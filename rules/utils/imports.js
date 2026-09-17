/**
 * Shared import-node plumbing.
 *
 * Every rule in this pack has to answer the same three questions: which AST
 * nodes are imports, what is the specifier, and is this a type-only import?
 * They are answered once here so that the seven rules stay readable.
 *
 * ESLint API surface used (see docs/WRITING-RULES.md for the verification notes):
 *   context.sourceCode   property, added v8.40.0, the only form in v10+
 *   context.filename     property, added v8.40.0, the only form in v10+
 *   context.cwd          property, added v8.40.0, the only form in v10+
 *   context.options      stable
 *   context.report       stable
 * Deliberately NOT used: context.getSourceCode(), context.getFilename(),
 * context.getCwd(), context.getScope(), context.getAncestors(),
 * context.markVariableAsUsed(). All of those are removed in ESLint v10.
 */

"use strict";

const { fileCandidates, importCandidates } = require("./paths");

/**
 * The specifier text of an import-like node, or `null` when it is not a
 * literal we can read. Non-literal specifiers appear in dynamic imports such as
 * ``import(`./locales/${locale}.js`)`` which cannot be resolved statically.
 *
 * @param {object} sourceNode the `source` property of the node
 * @returns {string|null} specifier text
 */
function readSpecifier(sourceNode) {
    if (!sourceNode) {
        return null;
    }
    if (sourceNode.type === "Literal" && typeof sourceNode.value === "string") {
        return sourceNode.value;
    }
    return null;
}

/**
 * Is this declaration type-only in a way TypeScript erases at compile time?
 *
 * Handles `import type { A } from "x"` (declaration-level importKind) and
 * `import { type A } from "x"` (specifier-level importKind, where every
 * specifier must be marked). An import with zero specifiers is a side-effect
 * import and is never type-only.
 *
 * @param {object} node an ImportDeclaration / ExportNamedDeclaration / ExportAllDeclaration
 * @returns {boolean} whether the import is erased before runtime
 */
function isTypeOnly(node) {
    if (node.importKind === "type" || node.exportKind === "type") {
        return true;
    }
    const specifiers = node.specifiers;
    if (!Array.isArray(specifiers) || specifiers.length === 0) {
        return false;
    }
    return specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type");
}

/**
 * Re-quote a rewritten specifier using the quote style of the original source
 * text, so an autofix never causes a cosmetic diff across the whole file.
 *
 * @param {string} originalText raw source of the literal being replaced
 * @param {string} value the new specifier
 * @returns {string} a quoted literal
 */
function quoteLike(originalText, value) {
    const first = typeof originalText === "string" ? originalText[0] : "";
    const quote = first === "'" ? "'" : "\"";
    let escaped = String(value).replace(/\\/gu, "\\\\");

    escaped = quote === "'"
        ? escaped.replace(/'/gu, "\\'")
        : escaped.replace(/"/gu, "\\\"");

    return `${quote}${escaped}${quote}`;
}

/**
 * Build the standard import visitors for a rule.
 *
 * `handle` receives a descriptor for every import-like construct found. Dynamic
 * `import()` is only visited when the rule option `checkDynamicImports` is true,
 * and even then only literal specifiers are reported: a computed specifier has
 * no static value to test against a boundary.
 *
 * @param {object} context ESLint rule context
 * @param {object} options normalised rule options
 * @param {Function} handle callback receiving a descriptor
 * @returns {Record<string, Function>} ESLint visitor object
 */
function createImportVisitors(context, options, handle) {
    const checkDynamic = options.checkDynamicImports === true;

    /**
     * @param {object} node the declaration node
     * @param {string} kind one of "import", "export-from", "dynamic-import"
     * @returns {void}
     */
    function dispatch(node, kind) {
        const specifier = readSpecifier(node.source);

        if (specifier === null || specifier === "") {
            return;
        }
        handle({
            node,
            sourceNode: node.source,
            specifier,
            kind,
            typeOnly: kind === "dynamic-import" ? false : isTypeOnly(node)
        });
    }

    const visitors = {
        ImportDeclaration(node) {
            dispatch(node, "import");
        },
        ExportNamedDeclaration(node) {
            if (node.source) {
                dispatch(node, "export-from");
            }
        },
        ExportAllDeclaration(node) {
            dispatch(node, "export-from");
        }
    };

    if (checkDynamic) {
        visitors.ImportExpression = function (node) {
            dispatch(node, "dynamic-import");
        };
    }

    return visitors;
}

/**
 * Resolve a specifier to the set of strings a glob may be matched against, and
 * also return the descriptors for the importing file.
 *
 * @param {object} params parameters
 * @param {object} params.context ESLint rule context
 * @param {object} params.options normalised rule options
 * @param {string} params.specifier raw specifier
 * @returns {{importCandidates: string[], fileCandidates: string[], resolved: string}} resolution
 */
function resolveSides({ context, options, specifier }) {
    const aliases = options.aliases || {};
    const cwd = context.cwd;
    const filename = context.filename;
    const importSide = importCandidates({ specifier, filename, aliases, cwd });

    return {
        importCandidates: importSide.candidates,
        fileCandidates: fileCandidates(filename, cwd),
        resolved: importSide.resolved
    };
}

/**
 * Create a fix function that swaps one specifier for another while preserving
 * the original quote style.
 *
 * The original source text must be passed in: the fixer object exposes only
 * insertTextAfter/insertTextBefore/remove/replaceText and their *Range variants,
 * and has no `sourceCode` property, so a rule must read the text it needs from
 * `context.sourceCode` before building the fix. ESLint v10 also requires the
 * text argument of every fixer method to be a real string.
 *
 * @param {object} sourceNode the literal node holding the specifier
 * @param {string} nextSpecifier replacement specifier
 * @param {string} originalText raw source text of `sourceNode`
 * @returns {Function} a `fix(fixer)` function
 */
function makeSpecifierFix(sourceNode, nextSpecifier, originalText) {
    return function (fixer) {
        return fixer.replaceText(sourceNode, quoteLike(originalText, nextSpecifier));
    };
}

module.exports = {
    createImportVisitors,
    isTypeOnly,
    makeSpecifierFix,
    quoteLike,
    readSpecifier,
    resolveSides
};
