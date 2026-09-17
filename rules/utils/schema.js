/**
 * Reusable JSON Schema fragments for rule options.
 *
 * These are functions rather than shared constants on purpose. ESLint compiles
 * each rule's `meta.schema` with Ajv, and Ajv is free to attach bookkeeping
 * properties to the schema object it is handed. If seven rules shared one object
 * instance, that bookkeeping would be shared too, and the failure mode is an
 * obscure Ajv error rather than a useful one. Fresh objects per rule avoid the
 * entire class of problem for the cost of a few object allocations at load time.
 */

"use strict";

const { DEFAULT_ENTRY_FILES } = require("./docs");

/**
 * @returns {object} schema for a single glob
 */
function glob() {
    return { type: "string" };
}

/**
 * @returns {object} schema for one glob or an array of globs
 */
function globOrGlobs() {
    return {
        anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } }
        ]
    };
}

/**
 * @returns {object} schema for a required, non-empty list of globs
 */
function globList() {
    return {
        anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 }
        ]
    };
}

/**
 * @returns {object} schema for the `aliases` option
 */
function aliases() {
    return {
        type: "object",
        additionalProperties: { type: "string" }
    };
}

/**
 * @returns {object} schema for the `entryFiles` option
 */
function entryFiles() {
    return {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        default: DEFAULT_ENTRY_FILES
    };
}

/**
 * @returns {object} schema for the `allow` option
 *
 * Each entry is either a bare glob (shorthand for `to`) or an object with
 * optional `from` / `to` sides plus a human-readable `reason`.
 */
function allowList() {
    return {
        type: "array",
        items: {
            anyOf: [
                { type: "string" },
                {
                    type: "object",
                    properties: {
                        from: globOrGlobs(),
                        to: globOrGlobs(),
                        reason: { type: "string" }
                    },
                    additionalProperties: false
                }
            ]
        },
        default: []
    };
}

/**
 * @returns {object} schema for the `checkDynamicImports` option
 */
function checkDynamicImports() {
    return {
        type: "boolean",
        default: false,
        description: "also check literal import() specifiers"
    };
}

module.exports = {
    aliases,
    allowList,
    checkDynamicImports,
    entryFiles,
    glob,
    globList,
    globOrGlobs
};
