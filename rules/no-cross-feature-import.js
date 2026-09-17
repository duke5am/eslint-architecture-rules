/**
 * no-cross-feature-import
 *
 * Forbids one feature/domain directory from importing another, with configurable
 * awareness of whether the import lands on the feature's public entry point or
 * reaches past it.
 *
 * Scope, stated plainly: the rule only fires for files that live *below*
 * `featuresRoot`. An import into a feature from outside any feature (say from
 * `src/ui`) is not a cross-feature import and is left alone; express that with
 * `no-layer-violation` or `require-dependency-direction` instead.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { createImportVisitors, resolveSides } = require("./utils/imports");
const { classifyBelowRoot } = require("./utils/modules");
const schema = require("./utils/schema");

const DEPTHS = ["both", "entry", "deep"];

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description: "forbid one feature from importing another feature's internals",
            recommended: false,
            url: docUrl("no-cross-feature-import")
        },
        // No fix: the correct replacement is a call into the other feature's
        // public API, which only the team knows. Rewriting the specifier to the
        // entry point is a mechanical guess that often does not compile.
        schema: [
            {
                type: "object",
                properties: {
                    featuresRoot: schema.globList(),
                    aliases: schema.aliases(),
                    depth: { enum: DEPTHS, default: "both" },
                    entryFiles: schema.entryFiles(),
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: true },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["featuresRoot"],
                additionalProperties: false
            }
        ],
        messages: {
            crossFeatureImport: "'{{specifier}}' imports feature '{{target}}' from feature '{{source}}'. Features must not depend on each other directly: move the shared code into a shared module, or expose an interface the other feature can consume.",
            deepCrossFeatureImport: "'{{specifier}}' reaches past the public entry point of feature '{{target}}' (expected '{{entry}}'). Deep imports bypass the feature's public API and are not allowed."
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || raw.featuresRoot === undefined) {
            throw new Error(
                "[no-cross-feature-import] the \"featuresRoot\" option is required, for example " +
                "{ featuresRoot: [\"src/features\"] }."
            );
        }

        const options = {
            aliases: {},
            depth: "both",
            entryFiles: undefined,
            allow: [],
            allowTypeImports: true,
            checkDynamicImports: false,
            ...raw
        };

        return createImportVisitors(context, options, ({ sourceNode, specifier, typeOnly }) => {
            if (typeOnly && options.allowTypeImports) {
                return;
            }

            const { importCandidates, fileCandidates } = resolveSides({ context, options, specifier });

            // Which feature is this file in? No match means the file is outside
            // the feature tree and this rule does not apply to it.
            const sourceLocation = firstClassified(fileCandidates, options.featuresRoot, options.entryFiles);
            if (!sourceLocation) {
                return;
            }

            // Where does the import land? Prefer a candidate that is below the
            // configured root, so an alias-resolved path is used when available.
            const targetLocation = firstClassified(importCandidates, options.featuresRoot, options.entryFiles);
            if (!targetLocation || targetLocation.group === sourceLocation.group) {
                return;
            }

            const flagged = targetLocation.isEntry
                ? options.depth !== "deep"
                : options.depth !== "entry";
            if (!flagged) {
                return;
            }

            if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                return;
            }

            const data = {
                specifier,
                source: sourceLocation.group,
                target: targetLocation.group
            };

            if (targetLocation.isEntry) {
                context.report({ node: sourceNode, messageId: "crossFeatureImport", data });
                return;
            }

            context.report({
                node: sourceNode,
                messageId: "deepCrossFeatureImport",
                data: {
                    ...data,
                    entry: entrySpecifier(specifier, targetLocation.tail.length)
                }
            });
        });
    }
};

/**
 * Return the first candidate that sits below one of the configured roots.
 *
 * @param {string[]} candidates candidate paths
 * @param {string|string[]} roots configured root(s)
 * @param {string[]|undefined} entryFiles configured entry file names
 * @returns {object|null} classification, or null
 */
function firstClassified(candidates, roots, entryFiles) {
    for (const candidate of candidates) {
        const classified = classifyBelowRoot(candidate, roots, entryFiles);
        if (classified) {
            return classified;
        }
    }
    return null;
}

/**
 * Trim `depth` path segments off a specifier, producing the specifier for the
 * feature entry point. The result stays in the same form the author wrote
 * (aliased or relative), so it can be pasted straight into the import.
 *
 * @param {string} specifier the original specifier
 * @param {number} depth how many segments to drop
 * @returns {string} the entry-point specifier
 */
function entrySpecifier(specifier, depth) {
    const segments = specifier.split("/");
    return segments.slice(0, Math.max(1, segments.length - depth)).join("/");
}
