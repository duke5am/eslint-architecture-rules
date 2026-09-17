/**
 * Segment-aware module structure helpers.
 *
 * "Feature" and "layer" are both defined the same way: a configured root
 * directory plus the first path segment below it. This file does that splitting
 * once, on path segments rather than substrings, so `src/features` can never
 * accidentally match `src/features-legacy` and `features` can never match a file
 * called `myfeatures/a.js`.
 */

"use strict";

const { segmentsOf } = require("./paths");
const { DEFAULT_ENTRY_FILES } = require("./docs");

/**
 * Split a path into "the configured root" and "everything below it".
 *
 * Roots are matched on whole segments, leftmost match first, so the outermost
 * root wins when roots are nested (as with `src/features` and `src`).
 *
 * @param {string} value path to split
 * @param {string|string[]} roots configured root(s)
 * @returns {{root: string, rest: string[]}|null} the split, or null if no root matched
 */
function splitAtRoot(value, roots) {
    const valueSegments = segmentsOf(value);
    if (valueSegments.length === 0) {
        return null;
    }
    const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);

    for (const root of rootList) {
        const rootSegments = segmentsOf(root);
        if (rootSegments.length === 0) {
            continue;
        }
        for (let i = 0; i + rootSegments.length <= valueSegments.length; i += 1) {
            const slice = valueSegments.slice(i, i + rootSegments.length);
            if (slice.every((segment, offset) => segment === rootSegments[offset])) {
                return {
                    root: rootSegments.join("/"),
                    rest: valueSegments.slice(i + rootSegments.length)
                };
            }
        }
    }

    return null;
}

/**
 * Is `entryFile` one of the file names that count as a public entry point?
 *
 * @param {string} entryFile a single path segment, e.g. "index.ts"
 * @param {string[]} [entryFiles] the configured entry file names
 * @returns {boolean} whether it is an entry file
 */
function isEntryFile(entryFile, entryFiles) {
    const list = Array.isArray(entryFiles) && entryFiles.length > 0 ? entryFiles : DEFAULT_ENTRY_FILES;
    return list.includes(entryFile);
}

/**
 * Classify where an import lands, relative to a configured root.
 *
 * @param {string} value a resolved import path or specifier
 * @param {string|string[]} roots configured root(s)
 * @param {string[]} [entryFiles] configured entry file names
 * @returns {{root: string, group: string, tail: string[], isEntry: boolean, isDeep: boolean}|null}
 *          classification, or null when the path is not below any root
 */
function classifyBelowRoot(value, roots, entryFiles) {
    const split = splitAtRoot(value, roots);
    if (!split || split.rest.length === 0) {
        return null;
    }

    const [group, ...tail] = split.rest;
    const isEntry = tail.length === 0 || (tail.length === 1 && isEntryFile(tail[0], entryFiles));

    return {
        root: split.root,
        group,
        tail,
        isEntry,
        isDeep: !isEntry
    };
}

module.exports = { classifyBelowRoot, isEntryFile, segmentsOf, splitAtRoot };
