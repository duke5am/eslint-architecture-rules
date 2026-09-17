/**
 * Flat config for the two rules shipped here. Requires package.json to declare
 * "type": "commonjs" (the rules are CommonJS).
 */
const plugin = require("./plugin.js");

module.exports = [
  {
    files: ["**/*.js"],
    plugins: { boundaries: plugin },
    rules: {
      "boundaries/no-layer-violation": ["error", {
        aliases: { "@app": "src" },
        layers: [
          { name: "ui",     pattern: ["src/ui/**"],     mayImport: ["domain"] },
          { name: "domain", pattern: ["src/domain/**"], mayImport: [] },
          { name: "infra",  pattern: ["src/infra/**"],  mayImport: ["domain"] }
        ]
      }],
      "boundaries/no-cross-feature-import": ["error", {
        featuresRoot: ["src/features"],
        aliases: { "@app": "src" },
        depth: "both"
      }]
    }
  }
];
