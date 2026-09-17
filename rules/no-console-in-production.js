/**
 * no-console-in-production
 *
 * Bans `console.*` outside an allow-list of paths. The interesting cases are not
 * `console.log` in a script — they are the debug line left in a request handler,
 * the `console.log(req.headers)` that shipped an auth token to a log aggregator,
 * and the `console.error(err)` in a React component that nobody can grep for
 * because the message is not structured.
 *
 * Fixable, and only where deletion cannot corrupt the program. `fix` removes the
 * whole `console.x(...)` statement when that statement sits directly in a
 * Program, a block, or a `switch` case. In a single-statement position — the
 * body of an `if` with no braces, a `while`, a label, an arrow with an
 * expression body — removing the statement would leave a dangling `if (x)`,
 * which is a syntax error, so the rule reports without a fix there. That case is
 * covered by a test.
 *
 * Two things this rule deliberately does not catch, both documented in
 * docs/RULE-REFERENCE.md: a destructured alias (`const { log } = console`) and a
 * console reassigned to another variable that is then called as `logger.log()`.
 */

"use strict";

const { docUrl } = require("./utils/docs");
const { matches } = require("./utils/glob");
const { fileCandidates } = require("./utils/paths");
const schema = require("./utils/schema");

const DEFAULT_ALLOW_METHODS = ["error", "warn"];
const COMPUTED_METHOD = "<computed>";

/** Node types whose child statement slot can be emptied without breaking syntax. */
const SAFE_STATEMENT_PARENTS = new Set(["Program", "BlockStatement", "SwitchCase"]);

module.exports = {
    meta: {
        type: "problem",
        fixable: "code",
        docs: {
            description: "forbid console usage outside an allow-list of paths",
            recommended: false,
            url: docUrl("no-console-in-production")
        },
        schema: [
            {
                type: "object",
                properties: {
                    allow: schema.globList(),
                    allowMethods: {
                        type: "array",
                        items: { type: "string" },
                        default: DEFAULT_ALLOW_METHODS
                    },
                    checkComputed: { type: "boolean", default: false },
                    reportMemberAccess: { type: "boolean", default: false },
                    ignoreShadowedConsole: { type: "boolean", default: true },
                    fix: { type: "boolean", default: true }
                },
                additionalProperties: false
            }
        ],
        messages: {
            unexpectedConsole: "Unexpected 'console.{{method}}'. Use the project logger instead: console output is unstructured, unfiltered in production, and hard to grep for after an incident.",
            unexpectedConsoleMember: "Unexpected access to the 'console' object. Use the project logger instead of passing console methods around."
        }
    },

    create(context) {
        const options = {
            allow: [],
            allowMethods: DEFAULT_ALLOW_METHODS,
            checkComputed: false,
            reportMemberAccess: false,
            ignoreShadowedConsole: true,
            fix: true,
            ...(context.options[0] || {})
        };

        const allowedMethods = new Set(options.allowMethods || []);
        const sourceCode = context.sourceCode;
        const candidates = fileCandidates(context.filename, context.cwd);

        // With no filename (stdin, or an editor buffer) `candidates` is empty and
        // the rule lints rather than guessing an exemption.
        if (candidates.length > 0 && candidates.some(candidate => matches(candidate, options.allow))) {
            return {};
        }

        return {
            MemberExpression(node) {
                if (node.object.type !== "Identifier" || node.object.name !== "console") {
                    return;
                }
                if (options.ignoreShadowedConsole && isConsoleShadowed(sourceCode, node)) {
                    return;
                }

                const method = readMethodName(node, options);

                if (method === null) {
                    // A computed member whose name is not a literal: skip unless
                    // the team asked for it.
                    if (!options.checkComputed || !node.computed) {
                        return;
                    }
                }

                const resolvedMethod = method === null ? COMPUTED_METHOD : method;

                if (allowedMethods.has(resolvedMethod)) {
                    return;
                }

                // `console.log(x)` is a CallExpression whose callee is this
                // member expression, so the statement to delete is one level
                // further up than it looks. Getting this wrong is silent: the
                // rule still reports, it just never fixes anything.
                const call = calleeCallFor(node);
                if (call === null) {
                    if (!options.reportMemberAccess) {
                        return;
                    }
                    context.report({
                        node,
                        messageId: "unexpectedConsoleMember"
                    });
                    return;
                }

                const statement = statementFor(call);
                const removable = options.fix && statement !== null && isSafelyRemovable(statement);
                const range = removable ? removalRange(sourceCode, statement) : null;

                context.report({
                    node,
                    messageId: "unexpectedConsole",
                    data: { method: resolvedMethod },
                    fix: range === null ? null : fixer => fixer.removeRange(range)
                });
            }
        };
    }
};

/**
 * Read the property name of a console member expression.
 *
 * @param {object} node the MemberExpression
 * @param {object} options normalised rule options
 * @returns {string|null} the method name, or null when it is not statically known
 */
function readMethodName(node, options) {
    if (!node.computed) {
        return node.property.type === "Identifier" ? node.property.name : null;
    }
    if (!options.checkComputed) {
        return null;
    }
    if (node.property.type === "Literal" && typeof node.property.value === "string") {
        return node.property.value;
    }
    return null;
}

/**
 * Is `console` shadowed by a real declaration in scope?
 *
 * Walking the scope chain with `sourceCode.getScope(node)` is the supported
 * replacement for the removed `context.getScope()`. A variable with zero
 * definitions is a configured or implicit global (the builtin `console`), which
 * is not a shadow; a variable with definitions comes from source code and is.
 *
 * @param {object} sourceCode the SourceCode object
 * @param {object} node the node being inspected
 * @returns {boolean} whether a source-level declaration named `console` is in scope
 */
function isConsoleShadowed(sourceCode, node) {
    let scope = sourceCode.getScope(node);

    while (scope) {
        const variable = typeof scope.set?.get === "function"
            ? scope.set.get("console")
            : (scope.variables || []).find(candidate => candidate.name === "console");

        if (variable) {
            return Array.isArray(variable.defs) && variable.defs.length > 0;
        }
        scope = scope.upper;
    }

    return false;
}

/**
 * If this member expression is the callee of a call, return that CallExpression.
 * Optional chaining (`console?.log()`) puts a ChainExpression in between, so
 * both shapes are handled here rather than at every call site.
 *
 * @param {object} node the MemberExpression
 * @returns {object|null} the CallExpression, or null when this is not a call
 */
function calleeCallFor(node) {
    const parent = node.parent;

    if (!parent) {
        return null;
    }
    if (parent.type === "CallExpression" && parent.callee === node) {
        return parent;
    }
    if (parent.type === "ChainExpression" && parent.parent &&
        parent.parent.type === "CallExpression" && parent.parent.callee === parent) {
        return parent.parent;
    }
    return null;
}

/**
 * The ExpressionStatement wrapping a call, if there is one.
 *
 * Optional chaining puts a ChainExpression between the call and the statement
 * (`console?.log()` is ExpressionStatement > ChainExpression > CallExpression),
 * so it is unwrapped here. Missing that wrapper is why an optional-chained
 * console call used to report without a fix.
 *
 * @param {object} call the CallExpression
 * @returns {object|null} the statement, or null
 */
function statementFor(call) {
    let current = call;

    if (current.parent && current.parent.type === "ChainExpression") {
        current = current.parent;
    }

    const parent = current.parent;

    return parent && parent.type === "ExpressionStatement" ? parent : null;
}

/**
 * Widen a statement's removal range back over the indentation in front of it.
 *
 * Deleting only the statement's own range leaves its indentation behind, so the
 * file gains a line of trailing whitespace for every removed console call.
 *
 * The trailing newline is deliberately NOT consumed. ESLint's fixer treats a
 * second fix as conflicting when its start is not strictly past the end of the
 * previous one (`lastPos >= start`), so consuming the newline makes two adjacent
 * console statements in the same block fight over the same character and only
 * the first is applied per pass. Leaving the newline keeps every removal
 * independent, which is why the fix for one call can never shadow the fix for
 * the next one.
 *
 * @param {object} sourceCode the SourceCode object
 * @param {object} statement the statement to remove
 * @returns {number[]} the range to remove
 */
function removalRange(sourceCode, statement) {
    const text = sourceCode.getText();
    const lineStart = sourceCode.getIndexFromLoc({ line: statement.loc.start.line, column: 0 });
    const before = text.slice(lineStart, statement.range[0]);

    if (!/^[^\S\n]*$/u.test(before)) {
        return statement.range;
    }
    return [lineStart, statement.range[1]];
}

/**
 * Can this statement be deleted without changing the shape of the syntax tree?
 *
 * @param {object} statement the ExpressionStatement
 * @returns {boolean} whether deletion is syntactically safe
 */
function isSafelyRemovable(statement) {
    const parent = statement.parent;
    if (!parent) {
        return false;
    }
    return SAFE_STATEMENT_PARENTS.has(parent.type);
}
