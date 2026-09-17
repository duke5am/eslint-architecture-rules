/**
 * require-dependency-direction
 *
 * The escape hatch that makes this pack useful after the seven built-in
 * boundaries run out. It is one generic engine: you declare who may import whom,
 * and you never write JavaScript. A team adds its own rule by appending an entry
 * to `boundaries` in eslint.config.js.
 *
 * It is also the only rule whose autofix can safely rewrite a specifier for a
 * reason other than a declared module entry: `rewrites` is an explicit,
 * human-authored statement that "an import of X should be an import of Y". When a
 * rewrite matches, the fix applies it; when it does not, the rule reports and
 * offers no fix, because inventing a replacement would be a guess.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { matches } = require("./utils/glob");
const { createImportVisitors, makeSpecifierFix, resolveSides } = require("./utils/imports");
const { applyAliases, isRelativeSpecifier, normalize, relativeFrom, segmentsOf } = require("./utils/paths");
const schema = require("./utils/schema");

const DEFAULT_MESSAGE = "This import crosses a boundary that this project declares it must not cross.";

module.exports = {
    meta: {
        type: "problem",
        fixable: "code",
        docs: {
            description: "enforce a declarative, configurable allow-list of dependency directions",
            recommended: false,
            url: docUrl("require-dependency-direction")
        },
        schema: [
            {
                type: "object",
                properties: {
                    boundaries: {
                        type: "array",
                        minItems: 1,
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                description: { type: "string" },
                                from: schema.globList(),
                                disallow: {
                                    type: "array",
                                    minItems: 1,
                                    items: {
                                        anyOf: [
                                            { type: "string" },
                                            {
                                                type: "object",
                                                properties: {
                                                    to: schema.globOrGlobs(),
                                                    message: { type: "string" }
                                                },
                                                required: ["to"],
                                                additionalProperties: false
                                            }
                                        ]
                                    }
                                },
                                allow: schema.allowList(),
                                rewrites: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            from: { type: "string" },
                                            to: { type: "string" }
                                        },
                                        required: ["from", "to"],
                                        additionalProperties: false
                                    }
                                },
                                allowTypeImports: { type: "boolean" }
                            },
                            required: ["name", "from", "disallow"],
                            additionalProperties: false
                        }
                    },
                    aliases: schema.aliases(),
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: false },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["boundaries"],
                additionalProperties: false
            }
        ],
        messages: {
            dependencyDirection: "'{{specifier}}' is not allowed here (boundary '{{boundary}}'). {{message}}"
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || !Array.isArray(raw.boundaries) || raw.boundaries.length === 0) {
            throw new Error(
                "[require-dependency-direction] the \"boundaries\" option is required and must list at " +
                "least one boundary, for example { boundaries: [{ name: \"ui-never-infra\", from: [\"src/ui/**\"], disallow: [\"src/infra/**\"] }] }."
            );
        }

        const options = {
            aliases: {},
            allow: [],
            allowTypeImports: false,
            checkDynamicImports: false,
            ...raw
        };

        const sourceCode = context.sourceCode;
        const filename = context.filename;

        return createImportVisitors(context, options, ({ sourceNode, specifier, typeOnly }) => {
            const { importCandidates, fileCandidates } = resolveSides({ context, options, specifier });

            for (const boundary of raw.boundaries) {
                if (!boundary || typeof boundary.name !== "string" || boundary.from === undefined) {
                    continue;
                }

                // Does this file live inside the boundary's `from` set?
                if (!fileCandidates.some(candidate => matches(candidate, boundary.from))) {
                    continue;
                }

                const boundaryAllowsTypeImports = boundary.allowTypeImports === undefined
                    ? options.allowTypeImports
                    : boundary.allowTypeImports;
                if (typeOnly && boundaryAllowsTypeImports) {
                    continue;
                }

                const disallowed = normalizeDisallow(boundary.disallow).find(entry =>
                    importCandidates.some(candidate => matches(candidate, entry.to))
                );
                if (!disallowed) {
                    continue;
                }

                if (findAllowEntry(boundary.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                    continue;
                }
                if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                    continue;
                }

                const replacement = computeRewrite({
                    specifier,
                    importCandidates,
                    rewrites: boundary.rewrites,
                    aliases: options.aliases,
                    filename
                });

                context.report({
                    node: sourceNode,
                    messageId: "dependencyDirection",
                    data: {
                        specifier,
                        boundary: boundary.name,
                        message: disallowed.message || boundary.description || DEFAULT_MESSAGE
                    },
                    fix: replacement === null
                        ? null
                        : makeSpecifierFix(sourceNode, replacement, sourceCode.getText(sourceNode))
                });
            }
        });
    }
};

/**
 * Normalise `disallow` into objects, accepting the bare-string shorthand.
 *
 * @param {Array<string|object>} disallow the configured list
 * @returns {Array<{to: string|string[], message?: string}>} normalised list
 */
function normalizeDisallow(disallow) {
    if (!Array.isArray(disallow)) {
        return [];
    }
    return disallow
        .map(entry => (typeof entry === "string" ? { to: entry } : entry))
        .filter(entry => entry && entry.to !== undefined);
}

/**
 * Apply the first matching rewrite, preserving the namespace of the original
 * specifier so the fix is valid in the file it lands in.
 *
 * @param {object} params parameters
 * @param {string} params.specifier the original specifier
 * @param {string[]} params.importCandidates every candidate this import matched
 * @param {Array<{from: string, to: string}>|undefined} params.rewrites configured rewrites
 * @param {Record<string, string>} params.aliases alias table
 * @param {string} params.filename the importing file
 * @returns {string|null} the rewritten specifier, or null when no rewrite applies
 */
function computeRewrite({ specifier, importCandidates, rewrites, aliases, filename }) {
    if (!Array.isArray(rewrites) || rewrites.length === 0) {
        return null;
    }

    for (const rewrite of rewrites) {
        if (!rewrite || typeof rewrite.from !== "string" || typeof rewrite.to !== "string") {
            continue;
        }
        const from = normalize(rewrite.from);
        const to = normalize(rewrite.to);

        for (const candidate of importCandidates) {
            const remainder = matchRewrite(candidate, from);

            if (remainder === null) {
                continue;
            }

            // The candidate is literally what the author wrote.
            if (candidate === specifier) {
                return `${to}${remainder}`;
            }

            // The candidate came from an alias: re-apply the alias key so the
            // replacement stays in the same namespace as the original import.
            const viaAlias = rewriteThroughAlias({ candidate, specifier, from, to, remainder, aliases });
            if (viaAlias !== null) {
                return viaAlias;
            }

            // The candidate came from resolving a relative specifier: point a
            // relative specifier at the same place.
            const viaRelative = rewriteToRelative({ specifier, candidate, from, to, remainder, filename });
            if (viaRelative !== null) {
                return viaRelative;
            }
        }
    }

    return null;
}

/**
 * Decide whether a candidate path is the rewrite's subject, and what tail to
 * carry over to the replacement.
 *
 * Three shapes match:
 *   - the path itself                     "src/infra/db"          -> remainder ""
 *   - something under it                  "src/infra/db/client.js" -> "/client.js"
 *   - the same file with an extension     "src/infra/db.js"      -> ".js"
 *
 * The third case is what makes a rewrite work for relative imports. A relative
 * specifier resolves to a path with the file extension on it, so `from:
 * "src/infra/db"` would otherwise match nothing and the rule would report
 * without offering the fix.
 *
 * @param {string} candidate a resolved import candidate
 * @param {string} from normalised rewrite source
 * @returns {string|null} the tail to append to the replacement, or null when this candidate is not the subject
 */
function matchRewrite(candidate, from) {
    if (candidate === from) {
        return "";
    }
    if (candidate.startsWith(`${from}/`)) {
        return candidate.slice(from.length);
    }
    if (candidate.startsWith(`${from}.`) && !candidate.slice(from.length + 1).includes("/")) {
        return candidate.slice(from.length);
    }
    return null;
}

/**
 * Re-express a rewrite in the original specifier's alias namespace.
 *
 * @param {object} params parameters
 * @param {string} params.candidate the matched candidate
 * @param {string} params.specifier the original specifier
 * @param {string} params.from rewrite source
 * @param {string} params.to rewrite target
 * @param {string} params.remainder path left over after `from`
 * @param {Record<string, string>} params.aliases alias table
 * @returns {string|null} rewritten specifier, or null when no alias explains the candidate
 */
function rewriteThroughAlias({ candidate, specifier, from, to, remainder, aliases }) {
    if (!aliases) {
        return null;
    }
    for (const [key, value] of Object.entries(aliases)) {
        const aliasValue = normalize(value);
        const candidateIsUnderAlias = candidate === aliasValue || candidate.startsWith(`${aliasValue}/`);
        const toIsUnderAlias = to === aliasValue || to.startsWith(`${aliasValue}/`);
        if (!candidateIsUnderAlias || !toIsUnderAlias) {
            continue;
        }
        if (applyAliases(specifier, { [key]: value }) !== candidate) {
            continue;
        }
        const inner = to.slice(aliasValue.length);
        return `${key}${inner}${remainder}`;
    }
    return null;
}

/**
 * Re-express a rewrite as a relative specifier, for files that import relatively.
 *
 * The target path is built inside the matched candidate's own namespace
 * (`prefix + to + remainder`) rather than from `to` alone. That is what makes
 * the rewrite work whether ESLint handed the rule an absolute filename (linting
 * files on disk) or a relative one (RuleTester, an editor buffer), without ever
 * producing a specifier that only resolves on one machine.
 *
 * @param {object} params parameters
 * @param {string} params.specifier the original specifier
 * @param {string} params.candidate the matched candidate
 * @param {string} params.from rewrite source
 * @param {string} params.to rewrite target
 * @param {string} params.remainder path left over after `from`
 * @param {string} params.filename the importing file
 * @returns {string|null} rewritten specifier, or null
 */
function rewriteToRelative({ specifier, candidate, from, to, remainder, filename }) {
    if (!isRelativeSpecifier(specifier)) {
        return null;
    }

    const prefix = candidate.slice(0, candidate.length - from.length - remainder.length);
    const rewritten = relativeFrom(filename, `${prefix}${to}${remainder}`);

    // A bare "." would be a directory import; report without fixing instead.
    return rewritten === "." ? null : rewritten;
}
