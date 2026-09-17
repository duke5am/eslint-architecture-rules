/**
 * no-deep-import
 *
 * Forbids reaching past a module's public entry point: `@app/billing/src/internal/charge`
 * must be `@app/billing`. This is the rule that makes a barrel file meaningful,
 * because nothing else stops a colleague from importing the file behind it.
 *
 * Fixable. The fix rewrites the specifier to the entry declared in this rule's
 * own configuration, which is the exact import the rule is asking for. The
 * failure mode is loud rather than silent: if the entry does not re-export the
 * symbol, the build or the type checker fails on the next run. Teams that want
 * to eyeball each rewrite can set `fix: false`.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { createImportVisitors, makeSpecifierFix, resolveSides } = require("./utils/imports");
const { isEntryFile, segmentsOf, splitAtRoot } = require("./utils/modules");
const { isRelativeSpecifier, normalize, relativeFrom } = require("./utils/paths");
const schema = require("./utils/schema");

module.exports = {
    meta: {
        type: "problem",
        fixable: "code",
        docs: {
            description: "forbid importing past a module's public entry point",
            recommended: false,
            url: docUrl("no-deep-import")
        },
        schema: [
            {
                type: "object",
                properties: {
                    modules: {
                        type: "array",
                        minItems: 1,
                        items: {
                            anyOf: [
                                { type: "string" },
                                {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        entry: { type: "string" },
                                        description: { type: "string" }
                                    },
                                    required: ["name"],
                                    additionalProperties: false
                                }
                            ]
                        }
                    },
                    aliases: schema.aliases(),
                    entryFiles: schema.entryFiles(),
                    checkRelativeImports: { type: "boolean", default: true },
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: true },
                    fix: { type: "boolean", default: true },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["modules"],
                additionalProperties: false
            }
        ],
        messages: {
            deepImport: "'{{specifier}}' reaches past the public entry point of module '{{module}}'. Import '{{entry}}' instead."
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || !Array.isArray(raw.modules) || raw.modules.length === 0) {
            throw new Error(
                "[no-deep-import] the \"modules\" option is required and must list at least one module, " +
                "for example { modules: [\"@app/billing\", { name: \"src/shared\", entry: \"src/shared/index.js\" }] }."
            );
        }

        const options = {
            aliases: {},
            entryFiles: undefined,
            checkRelativeImports: true,
            allow: [],
            allowTypeImports: true,
            fix: true,
            checkDynamicImports: false,
            ...raw
        };

        const modules = raw.modules.map(normalizeModule).filter(Boolean);
        const sourceCode = context.sourceCode;
        const filename = context.filename;

        return createImportVisitors(context, options, ({ sourceNode, specifier, typeOnly }) => {
            if (typeOnly && options.allowTypeImports) {
                return;
            }
            if (!options.checkRelativeImports && isRelativeSpecifier(specifier)) {
                return;
            }

            const { importCandidates, fileCandidates } = resolveSides({ context, options, specifier });

            const hit = findDeepImport({
                candidates: importCandidates,
                fileCandidates,
                modules,
                entryFiles: options.entryFiles
            });
            if (!hit) {
                return;
            }

            if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                return;
            }

            const entry = computeReplacement({
                specifier,
                matchedCandidate: hit.candidate,
                restLength: hit.rest.length,
                mod: hit.mod,
                filename
            });

            context.report({
                node: sourceNode,
                messageId: "deepImport",
                data: { specifier, module: hit.mod.name, entry },
                fix: options.fix && entry !== null
                    ? makeSpecifierFix(sourceNode, entry, sourceCode.getText(sourceNode))
                    : null
            });
        });
    }
};

/**
 * Normalise one `modules` entry into `{name, entry}`.
 *
 * @param {string|object} entry the configured module
 * @returns {{name: string, entry: string}|null} normalised module
 */
function normalizeModule(entry) {
    if (typeof entry === "string") {
        return { name: normalize(entry), entry: normalize(entry) };
    }
    if (!entry || typeof entry.name !== "string") {
        return null;
    }
    const name = normalize(entry.name);
    return {
        name,
        entry: typeof entry.entry === "string" ? normalize(entry.entry) : name
    };
}

/**
 * Does any candidate reach past one of these modules' entry points?
 *
 * A module's own files are exempt: `src/shared/internal/format.js` may import
 * `./pad`, and a barrel may import the files it re-exports. Enforcing an entry
 * point on a module's own internals would ban the very structure the entry point
 * exists to describe, and it is the single largest source of false positives for
 * this rule.
 *
 * @param {object} params parameters
 * @param {string[]} params.candidates import candidates
 * @param {string[]} params.fileCandidates the importing file's candidates
 * @param {Array<{name: string, entry: string}>} params.modules normalised modules
 * @param {string[]|undefined} params.entryFiles configured entry file names
 * @returns {{mod: object, candidate: string, rest: string[]}|null} the hit, or null
 */
function findDeepImport({ candidates, fileCandidates, modules, entryFiles }) {
    for (const mod of modules) {
        if (fileCandidates.some(candidate => splitAtRoot(candidate, mod.name) !== null)) {
            continue;
        }
        for (const candidate of candidates) {
            const split = splitAtRoot(candidate, mod.name);
            if (!split || split.rest.length === 0) {
                continue;
            }
            if (split.rest.length === 1 && isEntryFile(split.rest[0], entryFiles)) {
                continue;
            }
            return { mod, candidate, rest: split.rest };
        }
    }
    return null;
}

/**
 * Work out the specifier the import should have been.
 *
 * A bare specifier is rewritten to the declared entry. A relative specifier is
 * rewritten to a *relative* path pointing at the module root, because the file's
 * own alias setup may not include the module's public name, and inventing an
 * alias the build cannot resolve would be worse than the deep import.
 *
 * @param {object} params parameters
 * @param {string} params.specifier the original specifier
 * @param {string} params.matchedCandidate the candidate that matched
 * @param {number} params.restLength how many segments follow the module root
 * @param {{name: string, entry: string}} params.mod
 * @param {string} params.filename the importing file
 * @returns {string|null} replacement specifier, or null when none can be derived
 */
function computeReplacement({ specifier, matchedCandidate, restLength, mod, filename }) {
    if (!isRelativeSpecifier(specifier)) {
        return mod.entry;
    }

    const candidateSegments = segmentsOf(matchedCandidate);
    if (candidateSegments.length <= restLength) {
        return null;
    }
    const modulePrefix = `/${candidateSegments.slice(0, candidateSegments.length - restLength).join("/")}`;

    return relativeFrom(filename, modulePrefix);
}
