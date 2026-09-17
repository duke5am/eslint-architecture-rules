/**
 * Custom ESLint rules for architecture boundaries.
 *
 * This module is a plain plugin object: a `rules` map plus a `meta` block. It has
 * no dependencies, so it can be dropped into a repository, referenced from
 * eslint.config.js with a relative path, and never appears in package-lock.json.
 *
 * Flat config (ESLint v9 and v10) is the only supported configuration format.
 * The legacy eslintrc format could not load a plugin that is not an npm package
 * named `eslint-plugin-*`, which is precisely the situation this pack is for;
 * see docs/RULE-REFERENCE.md, "Legacy eslintrc".
 *
 * ESLint API generation targeted: v9.0.0 and newer, including the v10 line.
 * Verified against ESLint 10.10.0; minimum supported is 9.0.0. The rules use
 * only the property forms `context.sourceCode`, `context.filename`,
 * `context.cwd`, `context.physicalFilename`, `context.options`, `context.report`
 * and `sourceCode.getScope(node)`, all of which exist in v9 and survive the v10
 * removal of `getSourceCode`/`getFilename`/`getCwd`/`getScope`.
 */

"use strict";

const noBarrelCycle = require("./no-barrel-cycle");
const noConsoleInProduction = require("./no-console-in-production");
const noCrossFeatureImport = require("./no-cross-feature-import");
const noDeepImport = require("./no-deep-import");
const noLayerViolation = require("./no-layer-violation");
const noRestrictedImportInTests = require("./no-restricted-import-in-tests");
const requireDependencyDirection = require("./require-dependency-direction");

/**
 * Keep this in step with package.json. ESLint only uses it for `--print-config`
 * output and for cache invalidation messages, never for behaviour.
 *
 * @type {string}
 */
const VERSION = "1.0.0";

const plugin = {
    meta: {
        name: "eslint-plugin-architecture-boundaries",
        version: VERSION
    },
    rules: {
        "no-barrel-cycle": noBarrelCycle,
        "no-console-in-production": noConsoleInProduction,
        "no-cross-feature-import": noCrossFeatureImport,
        "no-deep-import": noDeepImport,
        "no-layer-violation": noLayerViolation,
        "no-restricted-import-in-tests": noRestrictedImportInTests,
        "require-dependency-direction": requireDependencyDirection
    }
};

module.exports = plugin;
module.exports.default = plugin;
