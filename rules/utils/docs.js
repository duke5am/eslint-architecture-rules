/**
 * Single source of truth for the `meta.docs.url` emitted by every rule.
 *
 * ESLint never fetches this URL: it is surfaced by editors (VS Code shows it on
 * hover, and "Open rule documentation" uses it) and by `eslint --print-config`
 * tooling. Point it at your own fork once, here, and all seven rules follow.
 *
 * The default is a placeholder repository path, because this pack is delivered
 * as a zip rather than published to npm. Nothing in the pack depends on the URL
 * resolving; see README.md ("Two things to change on day one").
 */

"use strict";

const DOCS_BASE = "https://github.com/your-org/eslint-boundary-rules";

const REFERENCE = "docs/RULE-REFERENCE.md";

/**
 * Build the documentation URL for a rule section.
 *
 * @param {string} ruleName rule id, e.g. "no-cross-feature-import"
 * @returns {string} documentation URL
 */
function docUrl(ruleName) {
    return `${DOCS_BASE}/blob/main/${REFERENCE}#${ruleName}`;
}

/**
 * The default file names that count as a module's public entry point.
 * Shared by no-deep-import, no-cross-feature-import and no-barrel-cycle so the
 * three rules agree on what "the entry" means.
 *
 * @type {string[]}
 */
const DEFAULT_ENTRY_FILES = [
    "index.js",
    "index.mjs",
    "index.cjs",
    "index.jsx",
    "index.ts",
    "index.tsx",
    "index.d.ts"
];

module.exports = { DOCS_BASE, DEFAULT_ENTRY_FILES, REFERENCE, docUrl };
