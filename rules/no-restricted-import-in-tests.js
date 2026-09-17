/**
 * no-restricted-import-in-tests
 *
 * Stops a test file from importing the real network or database client. This is
 * the boundary that fails most quietly in practice: `import axios from "axios"`
 * in a unit test works, passes locally, and then either hits a real endpoint in
 * CI or depends on a sandbox nobody remembers provisioning.
 *
 * Fixable when the restricted entry declares a `replacement` — the pack only
 * rewrites to a module the configuration explicitly named, never to a guess.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { matches } = require("./utils/glob");
const { createImportVisitors, makeSpecifierFix, resolveSides } = require("./utils/imports");
const schema = require("./utils/schema");

const DEFAULT_TEST_FILES = [
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/test/**"
];

const DEFAULT_MESSAGE = "Replace it with a fake, a stub, or an in-memory double so the suite stays hermetic and offline.";

module.exports = {
    meta: {
        type: "problem",
        fixable: "code",
        docs: {
            description: "forbid test files from importing real network or database clients",
            recommended: false,
            url: docUrl("no-restricted-import-in-tests")
        },
        schema: [
            {
                type: "object",
                properties: {
                    testFiles: schema.globList(),
                    restricted: {
                        type: "array",
                        minItems: 1,
                        items: {
                            anyOf: [
                                { type: "string" },
                                {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        pattern: schema.globOrGlobs(),
                                        message: { type: "string" },
                                        replacement: { type: "string" },
                                        allowIn: schema.globOrGlobs()
                                    },
                                    anyOf: [
                                        { required: ["name"] },
                                        { required: ["pattern"] }
                                    ],
                                    additionalProperties: false
                                }
                            ]
                        }
                    },
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: true },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["restricted"],
                additionalProperties: false
            }
        ],
        messages: {
            restrictedInTest: "'{{specifier}}' must not be imported from a test file. {{message}}"
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || !Array.isArray(raw.restricted) || raw.restricted.length === 0) {
            throw new Error(
                "[no-restricted-import-in-tests] the \"restricted\" option is required and must list at " +
                "least one module, for example { restricted: [\"axios\", { name: \"pg\", replacement: \"./test-support/fake-db\" }] }."
            );
        }

        const options = {
            testFiles: DEFAULT_TEST_FILES,
            allow: [],
            allowTypeImports: true,
            checkDynamicImports: false,
            ...raw
        };

        const restricted = raw.restricted.map(normalizeRestriction).filter(Boolean);
        const testFiles = options.testFiles || DEFAULT_TEST_FILES;
        const sourceCode = context.sourceCode;

        return createImportVisitors(context, options, ({ sourceNode, specifier, typeOnly }) => {
            if (typeOnly && options.allowTypeImports) {
                return;
            }

            const { importCandidates, fileCandidates } = resolveSides({ context, options, specifier });

            // Not a test file: this rule has nothing to say.
            if (!fileCandidates.some(candidate => matches(candidate, testFiles))) {
                return;
            }

            const hit = restricted.find(entry => restrictionMatches(entry, importCandidates, fileCandidates));
            if (!hit) {
                return;
            }

            if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                return;
            }

            context.report({
                node: sourceNode,
                messageId: "restrictedInTest",
                data: {
                    specifier,
                    message: hit.message || DEFAULT_MESSAGE
                },
                fix: hit.replacement
                    ? makeSpecifierFix(sourceNode, hit.replacement, sourceCode.getText(sourceNode))
                    : null
            });
        });
    }
};

/**
 * Normalise a `restricted` entry into an object form.
 *
 * @param {string|object} entry the configured restriction
 * @returns {object|null} normalised restriction
 */
function normalizeRestriction(entry) {
    if (typeof entry === "string") {
        return { name: entry };
    }
    if (!entry || (typeof entry.name !== "string" && entry.pattern === undefined)) {
        return null;
    }
    return entry;
}

/**
 * Does a restriction apply to this import?
 *
 * `name` matches the specifier and any subpath of it, on whole segments, so
 * "axios" catches "axios/lib/adapters/http" but not "axios-mock-adapter".
 * `pattern` is a glob tested against every candidate path.
 *
 * @param {object} entry normalised restriction
 * @param {string[]} importCandidates import candidates
 * @param {string[]} fileCandidates importing-file candidates
 * @returns {boolean} whether the restriction applies
 */
function restrictionMatches(entry, importCandidates, fileCandidates) {
    if (entry.allowIn !== undefined && fileCandidates.some(candidate => matches(candidate, entry.allowIn))) {
        return false;
    }

    if (typeof entry.name === "string") {
        const name = entry.name;
        if (importCandidates.some(candidate => candidate === name || candidate.startsWith(`${name}/`))) {
            return true;
        }
    }

    if (entry.pattern !== undefined) {
        if (importCandidates.some(candidate => matches(candidate, entry.pattern))) {
            return true;
        }
    }

    return false;
}
