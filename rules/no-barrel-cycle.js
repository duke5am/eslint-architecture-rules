/**
 * no-barrel-cycle
 *
 * Catches the self-referential barrel cycle: a file that a barrel re-exports
 * from, importing that same barrel back. At runtime the cycle usually resolves
 * to `undefined` for one of the two modules, and the resulting bug is famously
 * hard to read — the import is present, the symbol exists in the other file, and
 * yet it is `undefined` at the call site.
 *
 * HONEST SCOPE. This is not a module-graph cycle detector. Building a real cycle
 * graph inside a lint rule would require resolving and reading every imported
 * file, which breaks under stdin linting, editor buffers, partial checkouts and
 * monorepo-wide caching. What this rule implements instead is the narrow,
 * checkable version: you declare each barrel and the files it re-exports from
 * (`owns`), and the rule flags an import of that barrel from any file it owns.
 * That edge is a cycle *by construction*, given a truthful `owns` list.
 *
 * The rule therefore depends on `owns` being accurate. If a barrel re-exports
 * from a directory you did not list, cycles through that directory are missed.
 * Everything else in the graph — A imports B imports C imports A — is out of
 * scope, and docs/RULE-REFERENCE.md says so rather than implying otherwise.
 *
 * No autofix: the correct replacement depends on which side of the cycle should
 * move, and rewriting an intra-feature import to a deep relative path is exactly
 * what no-deep-import forbids. That is a human decision, so the rule only reports.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { matches } = require("./utils/glob");
const { createImportVisitors, resolveSides } = require("./utils/imports");
const { isEntryFile, splitAtRoot } = require("./utils/modules");
const schema = require("./utils/schema");

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description: "forbid a file from importing the barrel that re-exports it",
            recommended: false,
            url: docUrl("no-barrel-cycle")
        },
        schema: [
            {
                type: "object",
                properties: {
                    barrels: {
                        type: "array",
                        minItems: 1,
                        items: {
                            type: "object",
                            properties: {
                                barrel: schema.glob(),
                                owns: schema.globList(),
                                entry: { type: "string" },
                                description: { type: "string" }
                            },
                            required: ["barrel", "owns"],
                            additionalProperties: false
                        }
                    },
                    aliases: schema.aliases(),
                    entryFiles: schema.entryFiles(),
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: false },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["barrels"],
                additionalProperties: false
            }
        ],
        messages: {
            barrelCycle: "'{{specifier}}' imports the barrel '{{barrel}}' from '{{file}}', a file that barrel re-exports. That cycle usually makes one of the two modules export `undefined`. Import the sibling module directly, or move the shared code out of '{{barrel}}'."
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || !Array.isArray(raw.barrels) || raw.barrels.length === 0) {
            throw new Error(
                "[no-barrel-cycle] the \"barrels\" option is required and must list at least one barrel, " +
                "for example { barrels: [{ barrel: \"@app/features/billing\", owns: [\"src/features/billing/**\"] }] }."
            );
        }

        const options = {
            aliases: {},
            entryFiles: undefined,
            allow: [],
            allowTypeImports: false,
            checkDynamicImports: false,
            ...raw
        };

        return createImportVisitors(context, options, ({ sourceNode, specifier, typeOnly }) => {
            if (typeOnly && options.allowTypeImports) {
                return;
            }

            const { importCandidates, fileCandidates } = resolveSides({ context, options, specifier });

            for (const barrel of raw.barrels) {
                if (!barrel || typeof barrel.barrel !== "string" || barrel.owns === undefined) {
                    continue;
                }

                // Which file is this? It only matters if the barrel owns it.
                // The last matching candidate is used for the message because
                // fileCandidates lists the path relative to the ESLint working
                // directory after the absolute one, and that reads far better in
                // a terminal than "/home/someone/src/...".
                const owners = fileCandidates.filter(candidate => matches(candidate, barrel.owns));
                const owner = owners.length > 0 ? owners[owners.length - 1] : null;

                if (!owner) {
                    continue;
                }

                // The barrel's own entry file importing itself is not a cycle.
                if (isBarrelTarget(fileCandidates, barrel.barrel, options.entryFiles)) {
                    continue;
                }

                if (!isBarrelTarget(importCandidates, barrel.barrel, options.entryFiles)) {
                    continue;
                }

                if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                    continue;
                }

                context.report({
                    node: sourceNode,
                    messageId: "barrelCycle",
                    data: {
                        specifier,
                        barrel: barrel.barrel,
                        file: owner
                    }
                });
            }
        });
    }
};

/**
 * Does any candidate point at the barrel itself (its directory or its entry file)?
 *
 * @param {string[]} candidates candidate specifiers or paths
 * @param {string} barrel the configured barrel
 * @param {string[]|undefined} entryFiles configured entry file names
 * @returns {boolean} whether a candidate is the barrel
 */
function isBarrelTarget(candidates, barrel, entryFiles) {
    for (const candidate of candidates) {
        if (matches(candidate, barrel)) {
            return true;
        }
        const split = splitAtRoot(candidate, barrel);
        if (!split) {
            continue;
        }
        if (split.rest.length === 0) {
            return true;
        }
        if (split.rest.length === 1 && isEntryFile(split.rest[0], entryFiles)) {
            return true;
        }
    }
    return false;
}
