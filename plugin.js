// The shipped rules as a flat-config plugin object. CommonJS, matching the
// rules themselves.
module.exports = {
  meta: { name: "eslint-plugin-boundaries", version: "1.0.0" },
  rules: {
    "no-layer-violation": require("./rules/no-layer-violation.js"),
    "no-cross-feature-import": require("./rules/no-cross-feature-import.js")
  }
};
