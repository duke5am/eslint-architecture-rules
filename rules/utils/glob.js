/**
 * Minimal, dependency-free glob matcher for architecture rules.
 *
 * Why not `minimatch`? This pack must install with zero userland dependencies:
 * a lint rule that pulls a transitive dependency tree into every consumer's
 * node_modules is a supply-chain liability. The supported syntax is the subset
 * that boundary configuration actually needs.
 *
 * Supported syntax
 *   *        any run of characters except "/"
 *   **       any run of characters including "/"
 *   **\/     zero or more whole path segments (so `src/**\/x.js` matches `src/x.js`)
 *   ?        exactly one character except "/"
 *   [abc]    character class ([!abc] or [^abc] for negation)
 *   {a,b}    alternation (one level, no nesting)
 *   \x       literal x (escape)
 *   !glob    negation, only meaningful when passed inside an array
 *
 * Matching semantics: see `pathMatches()` at the bottom of this file.
 */

"use strict";

const REGEX_SPECIALS = /[.+^$()|\\]/;

/**
 * Expand one level of `{a,b}` alternation into an array of globs.
 * Nested braces are not supported and are treated literally.
 *
 * @param {string} glob glob pattern
 * @returns {string[]} expansions
 */
function expandBraces(glob) {
    const open = glob.indexOf("{");
    if (open === -1) {
        return [glob];
    }
    const close = glob.indexOf("}", open);
    if (close === -1) {
        return [glob];
    }
    const prefix = glob.slice(0, open);
    const suffix = glob.slice(close + 1);
    let depth = 0;
    let current = "";
    const parts = [];

    for (const char of glob.slice(open + 1, close)) {
        if (char === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
        }
        current += char;
    }
    parts.push(current);

    return parts.flatMap(part => expandBraces(prefix + part + suffix));
}

/**
 * Translate a single glob (no braces) into a regular expression source string.
 *
 * @param {string} glob glob pattern
 * @returns {string} regex source, without anchors
 */
function globBodyToRegExpSource(glob) {
    let out = "";
    let i = 0;

    while (i < glob.length) {
        const char = glob[i];

        if (char === "*") {
            const isDouble = glob[i + 1] === "*";
            const followedBySlash = glob[i + 2] === "/";

            if (isDouble && followedBySlash) {
                // `**/` consumes zero or more whole segments, so `a/**/b` matches `a/b`.
                out += "(?:[^/]*/)*";
                i += 3;
                continue;
            }
            if (isDouble) {
                // Trailing `/**` (or bare `**`) also matches nothing at all.
                if (i + 2 === glob.length && out.endsWith("/")) {
                    out = out.slice(0, -1) + "(?:/.*)?";
                } else {
                    out += ".*";
                }
                i += 2;
                continue;
            }
            out += "[^/]*";
            i += 1;
            continue;
        }

        if (char === "?") {
            out += "[^/]";
            i += 1;
            continue;
        }

        if (char === "[") {
            const close = glob.indexOf("]", i + 1);
            if (close === -1) {
                out += "\\[";
                i += 1;
                continue;
            }
            let body = glob.slice(i + 1, close);
            if (body.startsWith("!")) {
                body = `^${body.slice(1)}`;
            } else if (body.startsWith("^")) {
                // already negated
            }
            out += `[${body.replace(/\\/g, "\\\\")}]`;
            i = close + 1;
            continue;
        }

        if (REGEX_SPECIALS.test(char)) {
            out += `\\${char}`;
            i += 1;
            continue;
        }

        out += char;
        i += 1;
    }

    return out;
}

const cache = new Map();

/**
 * Compile a glob into a RegExp. Results are cached per pattern string, because
 * a rule re-compiles its config for every visited file otherwise.
 *
 * @param {string} glob glob pattern
 * @returns {RegExp} anchored regular expression
 */
function compile(glob) {
    const cached = cache.get(glob);
    if (cached) {
        return cached;
    }
    const source = expandBraces(glob)
        .map(part => `(?:${globBodyToRegExpSource(part)})`)
        .join("|");
    const regex = new RegExp(`^(?:${source})$`, "u");
    cache.set(glob, regex);
    return regex;
}

/**
 * Test a glob against a value, matching either the whole value or any
 * path-segment-aligned suffix of it.
 *
 * The suffix rule is what makes repo-relative globs ("src/ui/**") work no matter
 * what the process working directory is, and it lets the same config match both
 * a file path and a resolved import path without anyone normalising anything.
 * It is segment-aligned, so "infra/**" does NOT match "vendor/myinfra/a.js".
 *
 * @param {string} value normalised, slash-separated path or module specifier
 * @param {string} glob glob pattern
 * @returns {boolean} whether it matches
 */
function rawMatch(value, glob) {
    const regex = compile(glob);
    if (regex.test(value)) {
        return true;
    }
    // Reject globs that already anchor themselves to a suffix; a leading `**`
    // or `/` means the author wants an absolute/whole-path match.
    if (glob.startsWith("**") || glob.startsWith("/")) {
        return false;
    }
    let index = value.indexOf("/");
    while (index !== -1) {
        if (regex.test(value.slice(index + 1))) {
            return true;
        }
        index = value.indexOf("/", index + 1);
    }
    return false;
}

/**
 * Test one value against a list of globs, honouring `!` negation.
 * Negations are applied after the includes, so the last matching negation wins.
 *
 * @param {string} value normalised value
 * @param {string|string[]} globs one glob or an array of globs
 * @returns {boolean} whether the value matches
 */
function matches(value, globs) {
    if (!globs) {
        return false;
    }
    const list = Array.isArray(globs) ? globs : [globs];
    if (list.length === 0) {
        return false;
    }
    let included = false;
    let excluded = false;

    for (const entry of list) {
        if (typeof entry !== "string") {
            continue;
        }
        if (entry.startsWith("!")) {
            if (rawMatch(value, entry.slice(1))) {
                excluded = true;
            }
        } else if (rawMatch(value, entry)) {
            included = true;
        }
    }
    return included && !excluded;
}

/**
 * Test whether any candidate value matches any glob.
 *
 * @param {Iterable<string>} values candidate values
 * @param {string|string[]} globs globs
 * @returns {boolean} whether at least one value matched
 */
function matchesAny(values, globs) {
    for (const value of values) {
        if (matches(value, globs)) {
            return true;
        }
    }
    return false;
}

/**
 * Test whether two values are different by at least one path segment, i.e.
 * whether `candidate` is "deep inside" `base` rather than equal to it.
 *
 * @param {string} candidate deeper path
 * @param {string} base shallower path
 * @returns {boolean} true when candidate is strictly deeper than base
 */
function isDeep(candidate, base) {
    return candidate !== base && candidate.startsWith(`${base}/`);
}

module.exports = { compile, matches, matchesAny, rawMatch, isDeep, expandBraces };
