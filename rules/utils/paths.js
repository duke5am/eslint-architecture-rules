/**
 * Textual path arithmetic for architecture rules.
 *
 * Everything here is pure string work: no `fs` calls, no resolver, no
 * `node_modules` lookups. That is deliberate. A lint rule that touches the file
 * system cannot run over stdin, over editor buffers that are not yet saved, or
 * over a monorepo checkout where only the current package is present. The price
 * is that path aliases must be declared in the rule options instead of being
 * read from tsconfig.json, and that symlinks are invisible. Both limitations are
 * stated in docs/RULE-REFERENCE.md.
 */

"use strict";

const path = require("node:path");

/**
 * Normalise a path to forward slashes and collapse ".", ".." and empty
 * segments textually. A leading "/" is preserved.
 *
 * This intentionally does NOT touch the file system, so it cannot resolve
 * symlinks or confirm that a path exists.
 *
 * @param {string} input path or specifier
 * @returns {string} normalised path
 */
function normalize(input) {
    const raw = String(input).replace(/\\/gu, "/");
    const isAbsolute = raw.startsWith("/");
    const out = [];

    for (const segment of raw.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..") {
                out.pop();
            } else if (!isAbsolute) {
                out.push("..");
            }
            continue;
        }
        out.push(segment);
    }

    return (isAbsolute ? "/" : "") + out.join("/");
}

/**
 * Is this an import specifier that starts with "./" or "../"?
 *
 * @param {string} specifier import specifier
 * @returns {boolean} whether it is relative
 */
function isRelativeSpecifier(specifier) {
    return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Is this a Node.js builtin specifier, with or without the node: prefix?
 *
 * @param {string} specifier import specifier
 * @returns {boolean} whether it is a builtin
 */
function isBuiltinSpecifier(specifier) {
    return specifier.startsWith("node:");
}

/**
 * Resolve a relative specifier against the directory of the importing file.
 * Returns an absolute-looking path (leading "/") whenever the filename was
 * absolute, which keeps the output stable for suffix matching.
 *
 * @param {string} specifier relative specifier
 * @param {string} filename the importing file
 * @returns {string} resolved path
 */
function resolveRelative(specifier, filename) {
    const dir = path.posix.dirname(normalize(filename));
    return normalize(`${dir}/${specifier}`);
}

/**
 * Apply a configured alias table to a specifier.
 *
 * Aliases match on whole path segments, and the longest matching key wins, so
 * `{ "@app/features": "src/features", "@app": "src" }` maps
 * `@app/features/billing` to `src/features/billing` rather than `src/features/billing`
 * via the shorter key. A specifier that matches no alias is returned unchanged.
 *
 * @param {string} specifier import specifier
 * @param {Record<string, string>} aliases alias table
 * @returns {string} the alias-resolved specifier, or the input
 */
function applyAliases(specifier, aliases) {
    if (!aliases) {
        return specifier;
    }
    const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (specifier === key) {
            return normalize(aliases[key]);
        }
        if (specifier.startsWith(`${key}/`)) {
            return normalize(`${aliases[key]}/${specifier.slice(key.length + 1)}`);
        }
    }
    return specifier;
}

/**
 * Split a path into its non-empty segments.
 *
 * @param {string} value a path
 * @returns {string[]} its segments
 */
function segmentsOf(value) {
    return normalize(value).split("/").filter(Boolean);
}

/**
 * Build a relative specifier pointing from one file to another path.
 *
 * This is segment arithmetic rather than `path.posix.relative()` on purpose.
 * ESLint hands rules an absolute `context.filename` when it lints files on disk,
 * but RuleTester cases and editor integrations can supply a relative filename,
 * and `path.relative()` silently mixes the two by resolving the relative side
 * against the process working directory. That produces a specifier full of
 * `../../../..` that resolves to a real directory on the developer's machine and
 * nowhere else. Working on segments behaves identically for both input shapes.
 *
 * @param {string} fromFile the file the import appears in
 * @param {string} targetPath the path to point at
 * @returns {string} a relative specifier, always starting with "." or ".."
 */
function relativeFrom(fromFile, targetPath) {
    const fromSegments = segmentsOf(path.posix.dirname(normalize(fromFile)));
    const targetSegments = segmentsOf(targetPath);
    let common = 0;

    while (
        common < fromSegments.length &&
        common < targetSegments.length &&
        fromSegments[common] === targetSegments[common]
    ) {
        common += 1;
    }

    const parts = [
        ...new Array(fromSegments.length - common).fill(".."),
        ...targetSegments.slice(common)
    ];
    const joined = parts.join("/");

    if (joined === "") {
        return ".";
    }
    return joined.startsWith(".") ? joined : `./${joined}`;
}

/**
 * Every string a glob should be tested against for a *file*.
 *
 * Both the raw filename and its path relative to the ESLint working directory
 * are returned, so a config written as either "src/ui/**", "/repo/src/ui/**" or
 * "**\/ui/**" behaves the same. Combined with segment-aligned suffix matching in
 * utils/glob.js, this means configuration does not break when ESLint is invoked
 * from a nested directory.
 *
 * @param {string} filename the linted filename
 * @param {string} cwd ESLint working directory
 * @returns {string[]} candidate paths
 */
function fileCandidates(filename, cwd) {
    if (typeof filename !== "string" || filename === "" || filename === "<input>" || filename === "<text>") {
        return [];
    }
    const normalized = normalize(filename);
    const candidates = [normalized];

    if (path.isAbsolute(filename) && cwd) {
        const relative = normalize(path.relative(cwd, filename));
        if (relative !== "" && relative !== normalized) {
            candidates.push(relative);
        }
    }
    return candidates;
}

/**
 * Every string a glob should be tested against for an *import*.
 *
 * For a relative specifier we emit the resolved path so layer/feature globs can
 * be written once in repo-relative terms; for everything else we emit both the
 * literal specifier and its alias-resolved form, so a boundary can be written
 * as "@app/infra/**" or as "src/infra/**" and mean the same thing.
 *
 * @param {object} params parameters
 * @param {string} params.specifier raw import specifier
 * @param {string} params.filename the importing file
 * @param {Record<string, string>} [params.aliases] alias table
 * @param {string} [params.cwd] ESLint working directory
 * @returns {{raw: string, resolved: string, candidates: string[]}} resolution
 */
function importCandidates({ specifier, filename, aliases, cwd }) {
    const candidates = [];
    let resolved;

    if (isRelativeSpecifier(specifier)) {
        resolved = resolveRelative(specifier, filename);
        candidates.push(resolved);
        if (cwd && resolved.startsWith("/")) {
            candidates.push(normalize(path.relative(cwd, resolved)));
        }
    } else {
        resolved = applyAliases(specifier, aliases);
        candidates.push(specifier);
        if (resolved !== specifier) {
            candidates.push(resolved);
        }
    }

    candidates.push(...fileCandidates(resolved, cwd));

    return {
        raw: specifier,
        resolved,
        candidates: [...new Set(candidates.filter(Boolean))]
    };
}

module.exports = {
    normalize,
    isRelativeSpecifier,
    isBuiltinSpecifier,
    resolveRelative,
    applyAliases,
    fileCandidates,
    importCandidates,
    relativeFrom,
    segmentsOf
};
