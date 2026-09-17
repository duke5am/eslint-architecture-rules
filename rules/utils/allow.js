/**
 * Shared "is this edge deliberately allowed?" logic.
 *
 * Three rules accept an `allow` list so that a team can carve out the exceptions
 * the architecture review already blessed. The shape is uniform across the pack:
 *
 *   allow: [
 *     { from: "src/features/checkout/**", to: "src/features/billing", reason: "…" },
 *     { to: "src/shared/**" }
 *   ]
 *
 * `from` is matched against the importing file, `to` against the import
 * specifier (and its resolved path). Either side may be omitted, in which case
 * that side matches everything; omitting both makes the entry a blanket
 * exemption, which is legal but almost always a mistake.
 */

"use strict";

const { matches } = require("./glob");

/**
 * Does this import edge match one of the configured exemptions?
 *
 * @param {Array<object>} allowEntries the rule's `allow` option
 * @param {object} sides the two sides of the edge
 * @param {string[]} sides.fileValues candidate paths for the importing file
 * @param {string[]} sides.importValues candidate paths for the import
 * @returns {object|null} the matching entry, or null when nothing matched
 */
function findAllowEntry(allowEntries, { fileValues, importValues }) {
    if (!Array.isArray(allowEntries) || allowEntries.length === 0) {
        return null;
    }

    for (const entry of allowEntries) {
        if (typeof entry === "string") {
            if (importValues.some(value => matches(value, entry))) {
                return { to: entry };
            }
            continue;
        }
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const fromOk = entry.from === undefined
            ? true
            : fileValues.some(value => matches(value, entry.from));
        if (!fromOk) {
            continue;
        }

        const toOk = entry.to === undefined
            ? true
            : importValues.some(value => matches(value, entry.to));
        if (!toOk) {
            continue;
        }

        return entry;
    }

    return null;
}

module.exports = { findAllowEntry };
