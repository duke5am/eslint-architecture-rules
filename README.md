# eslint-architecture-rules

Turn architectural conventions into ESLint rules that fail CI — so boundaries stop
eroding one code-review miss at a time.

Two rules here: **`no-layer-violation`** and **`no-cross-feature-import`**. The
full pack adds five more (public entry points, hermetic tests, console in
production, barrel cycles, and a declarative dependency-direction engine).

## Verified in a real ESLint run

```bash
npm install eslint
npx eslint fixtures/src
```

```
/…/fixtures/src/ui/Button.js
  1:20  error  '../infra/db.js' reaches into layer 'infra', which layer 'ui' may
               not import. 'ui' is allowed to import: domain
               boundaries/no-layer-violation

✖ 1 problem (1 error, 0 warnings)
```

And the false-positive check — a **same-feature** deep relative import is
correctly *not* flagged:

```js
// fixtures/src/features/checkout/Good.js — no error reported
import { helper } from "./internal/helper.js";
```

That negative case matters more than the positive one: a boundary rule that fires
on legitimate code gets disabled within a day, and then it protects nothing.

## What I could NOT verify — please read

**`no-cross-feature-import` did not fire in my end-to-end ESLint run.**

The fixture is a genuine violation — `src/features/checkout/CrossFeature.js`
importing `../../billing/internal/charge.js`, a different feature's internals —
with this configuration:

```js
"boundaries/no-cross-feature-import": ["error", {
  featuresRoot: ["src/features"], aliases: { "@app": "src" }, depth: "both"
}]
```

It produced no finding. The rule *does* pass its own `RuleTester` suite, which
supplies **relative** filenames (`src/features/billing/internal/charge.js`), while
ESLint in a real run passes **absolute** ones (`/path/to/project/src/features/…`) —
I confirmed that with a probe rule. So the most likely cause is that the rule's
`featuresRoot` matching does not resolve against the absolute path. I did not have
time to confirm that or fix it.

**Treat `no-cross-feature-import` as not-yet-proven in a real project.** Test it on
your own tree before relying on it; if it does not fire, that is why.
`no-layer-violation` is verified working as shown above.

I am telling you this rather than shipping a demo that quietly omits the rule,
because "the tests pass" and "it works when you run it" turned out to be different
claims here.

## Setup

```bash
npm install eslint
```

`package.json` must declare `"type": "commonjs"` — the rules are CommonJS, and
under `"type": "module"` Node refuses to load them.

Legacy `.eslintrc` is unsupported: it cannot load a local plugin by relative path,
and ESLint v10 removed eslintrc entirely. Flat config only.

ESLint **9.0.0 or newer** (tested on 10.10.0). The rules use `context.sourceCode`
and `context.filename`, which replaced the deprecated `getSourceCode()` /
`getFilename()` in v9.

## Configuring a layer rule

`pattern` is an **array** of globs. The rule's own schema rejects `glob` as a key,
which is worth knowing because that is the obvious thing to write:

```js
{ name: "ui", pattern: ["src/ui/**"], mayImport: ["domain"] }
```

Layers are declared bottom-up: a layer may import only what `mayImport` lists,
and anything not listed is a violation.

## Rolling it out without blocking everyone

Do not turn these on as errors across an existing codebase. A rule that fires
4,000 times on day one gets disabled and never re-enabled. Start with `"warn"`,
baseline the existing violations, fix by directory, then promote to `"error"`.

## The full pack

Seven rules, the `RuleTester` suites (204 tests), and the rollout and
writing-rules guides.

→ **Custom ESLint Rules for Architecture Boundaries**: <!-- GUMROAD-LINK -->
