/**
 * no-layer-violation
 *
 * Encodes a layer order once, declaratively, instead of in a wiki page that
 * nobody reads. Each layer lists the other layers it is allowed to import from.
 *
 * Scope, stated plainly: only edges where *both* ends resolve to a configured
 * layer are checked. Third-party imports (react, axios, node:fs) are ignored
 * here even though "the domain layer must not import react" is a real rule —
 * express that with require-dependency-direction, whose `disallow` list accepts
 * bare module specifiers.
 */

"use strict";

const { findAllowEntry } = require("./utils/allow");
const { docUrl } = require("./utils/docs");
const { matches } = require("./utils/glob");
const { createImportVisitors, resolveSides } = require("./utils/imports");
const schema = require("./utils/schema");

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description: "enforce a declared import order between architectural layers",
            recommended: false,
            url: docUrl("no-layer-violation")
        },
        // No fix: the layer a misplaced import should move to is an architectural
        // decision (often an inversion of control or a port/adapter change).
        schema: [
            {
                type: "object",
                properties: {
                    layers: {
                        type: "array",
                        minItems: 1,
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                pattern: schema.globList(),
                                mayImport: {
                                    type: "array",
                                    items: { type: "string" },
                                    default: []
                                },
                                description: { type: "string" }
                            },
                            required: ["name", "pattern"],
                            additionalProperties: false
                        }
                    },
                    aliases: schema.aliases(),
                    allow: schema.allowList(),
                    allowTypeImports: { type: "boolean", default: false },
                    checkDynamicImports: schema.checkDynamicImports()
                },
                required: ["layers"],
                additionalProperties: false
            }
        ],
        messages: {
            layerViolation: "'{{specifier}}' reaches into layer '{{targetLayer}}', which layer '{{sourceLayer}}' may not import. '{{sourceLayer}}' is allowed to import: {{allowed}}."
        }
    },

    create(context) {
        const raw = context.options[0];

        if (!raw || !Array.isArray(raw.layers) || raw.layers.length === 0) {
            throw new Error(
                "[no-layer-violation] the \"layers\" option is required and must list at least one " +
                "layer, for example { layers: [{ name: \"ui\", pattern: \"src/ui/**\", mayImport: [\"domain\"] }] }."
            );
        }

        const options = {
            aliases: {},
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

            const sourceLayer = layerFor(fileCandidates, options.layers);
            if (!sourceLayer) {
                return;
            }

            const targetLayer = layerFor(importCandidates, options.layers);
            // No layer at the other end: same layer (always fine), or something
            // this rule does not own.
            if (!targetLayer || targetLayer.name === sourceLayer.name) {
                return;
            }

            const mayImport = Array.isArray(sourceLayer.mayImport) ? sourceLayer.mayImport : [];
            if (mayImport.includes("*") || mayImport.includes(targetLayer.name)) {
                return;
            }

            if (findAllowEntry(options.allow, { fileValues: fileCandidates, importValues: importCandidates })) {
                return;
            }

            context.report({
                node: sourceNode,
                messageId: "layerViolation",
                data: {
                    specifier,
                    sourceLayer: sourceLayer.name,
                    targetLayer: targetLayer.name,
                    allowed: mayImport.length === 0 ? "nothing" : mayImport.join(", ")
                }
            });
        });
    }
};

/**
 * Find the first configured layer that owns any of these candidate paths.
 * Declaration order wins, so put the most specific layer first.
 *
 * @param {string[]} candidates candidate paths
 * @param {Array<{name: string, pattern: string|string[]}>} layers configured layers
 * @returns {{name: string, pattern: string|string[], mayImport?: string[]}|null} the layer, or null
 */
function layerFor(candidates, layers) {
    for (const layer of layers) {
        for (const candidate of candidates) {
            if (matches(candidate, layer.pattern)) {
                return layer;
            }
        }
    }
    return null;
}
