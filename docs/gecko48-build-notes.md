# Gecko 48 build notes

What was discovered while making a Vue 3 app compile to something a KaiOS 2.5 handset
(Gecko 48 / Firefox 48) can actually execute, why each pipeline decision is where it is, and
how to recognise the failures again. Measurements are from this project's own builds, at the
sizes noted.

The short version: **almost every failure here is silent.** Tools that disagree about the
target do not error, they quietly do the wrong thing, and the result only shows up on a
device — or in the gates, which is why the gates exist.

## 1. One target, three spellings

`scripts/target.js` declares the target three ways because no two tools accept the same name
for "KaiOS 2.5".

| Tool | Accepts | Notes |
| --- | --- | --- |
| Browserslist (autoprefixer) | `kaios 2.5` | resolves fine |
| Babel / `@babel/helper-compilation-targets` | `{ firefox: '48' }` | **throws** on KaiOS |
| esbuild (`build.target`, `build.cssTarget`) | `firefox48` | |

Babel's two failure modes, both thrown from `getTargets`:

```
['kaios 2.5']  => ERROR: '0' is not a valid target
{ kaios: '2.5' } => ERROR: 'kaios' is not a valid target
{ firefox: '48' } => {"firefox":"48.0.0"}
```

The dangerous part is what happens *next*. The core-js polyfill provider wraps target
resolution in a fallback: when it cannot resolve targets it uses `babelApi.targets()`, which
is `{}` — "no targets" — which means **polyfill everything**. It does not warn.

Measured, same source:

| | core-js module files | bundle | gzip |
| --- | --- | --- | --- |
| `targets: ['kaios 2.5']` (silently empty) | 431 | 229.32 kB | 78.81 kB |
| `targets: { firefox: '48' }` | 84 polyfill modules | 186.99 kB | 67.80 kB |

Reproduce:

```bash
node --input-type=module -e "
import getTargets from '@babel/helper-compilation-targets';
try { console.log(getTargets(['kaios 2.5'])) } catch (e) { console.log('ERROR', e.message) }
"
```

## 2. core-js's compat data is about spec conformance, not first ship

After fixing the target, `es.array.map` was *still* polyfilled on Firefox 48, where
`Array.prototype.map` has existed since 2005. The reason is in the data itself:

```js
data['es.array.map']         // { firefox: "50", … }
data['es.promise']           // { firefox: "69", … }
data['es.set']               // { firefox: "53", … }
data['es.array.includes']    // { firefox: "102", … }
data['es.object.assign']     // { firefox: "36", … }  → FF48 has it, not polyfilled
```

The value is the first engine version whose implementation core-js considers *conformant*, not
the version that introduced the method. So on FF48 core-js replaces `Promise`, `Map`, `Set`,
`Array.prototype.map`, `String.prototype.split` and more with its own implementations.

Consequences, both real:

- **Size**: ~202 kB / ~76 kB gzip, of which core-js is the bulk (app source is ~20 kB of it).
- **Speed**: `Promise` is a JavaScript implementation, not the native one, on a 1.1 GHz phone.

This is the correct default — conformance is why the app behaves the same as it would in a
modern browser — but it is a *choice*, and the lever is the polyfill plugin's
`shouldInjectPolyfill(name, shouldInject)` if size or scheduler speed ever outweighs it.

## 3. Nothing may escape the syntax pass — except the polyfill library

`@babel/preset-env` at FF48 does not only lower async/await and spread; it also has to handle
the *dependencies*. core-js is written in modern JavaScript:

```js
// node_modules/core-js/internals/fails.js
module.exports = function (exec) {
  try { return !!exec(); } catch { return true; }   // optional catch binding, ES2019
};
```

An early version of the plugin skipped `node_modules/core-js` on the assumption that the
polyfill library ships ES5. It does not, and the result was `catch {}` in the shipped bundle —
a hard parse error on the device:

```
[syntax] js/app.js:3:1446 — Unexpected token
```

The fix is not "skip fewer things" but "skip nothing, except the one package that must not
receive injections". `SKIP_ID` in `scripts/vite-plugin-kaios-legacy.js` now matches core-js
only, and the reason is ordering, not syntax:

**Symptom** (with core-js included in the injection pass):

```
TypeError: Cannot set properties of undefined (setting 'exports')
  at requireSharedStore ← requireShared ← requireWellKnownSymbol ← requireToPrimitive
  ← requireToPropertyKey ← requireObjectGetOwnPropertyDescriptor ← require_export
  ← requireEs_array_push
```

`@rollup/plugin-commonjs` emits `var name = { exports: {} };` immediately before the function
that assigns to it, and the bundle was calling into that module's chain *before* the
initializer ran. Injecting `import 'core-js/modules/…'` into core-js's own CommonJS files is
what perturbs that ordering; the mechanism was not reduced to a single line, but the
correlation is reproducible and the fix is exact.

Ruled out along the way, each by one build:

- the final Babel pass — skipped it (`KAIOS_SKIP_FINAL_PASS`), still threw;
- the minifier — disabled it (`--minify false`), still threw.

Since core-js *is* the polyfill library, injecting polyfills into it is pointless anyway. Its
own modern syntax is handled by pass 3 below.

## 4. The last thing that rewrites the code must be the thing enforcing the target

The final ordering that works is three passes, and the placement of the third is the
load-bearing part:

1. **`transform`** — per module, before bundling. Syntax lowering plus core-js import
   injection. Must happen while the bundler can still resolve imports.
2. **bundler + minifier** — deliberately left at `esnext` (see §5).
3. **`writeBundle`** — after the file is on disk, rewrite it in place. Nothing runs after it.

The failure that forced pass 3 to be last:

```
[syntax] js/app.js:3:800 — Unexpected token          # `catch {}`, again
```

Babel had lowered `catch {}` to `catch (_unused) {}`; esbuild's minifier — whose own target was
still `esnext` — saw an unused binding and dropped it back to `catch {}`. Both stages were
doing their job, and the union of their work was unparseable on the device.

Two configurations were verified clean, and either invariant is sufficient:

- minifier target `firefox48`, final pass in `renderChunk` (before minification), **or**
- minifier target `esnext`, final pass after the bundle is written.

The project uses the second, because the first also has to fight Vite's own chunk transpile:

```
[vite:esbuild-transpile] Transform failed with 6 errors:
js/app.js:18462:2: ERROR: Transforming const to the configured target environment
("firefox48" + 2 overrides) is not supported yet
```

So: **the bundler is told `esnext` and does no lowering at all; Babel owns the target and
finishes last.** Anything that can rewrite *toward* a newer target must run before the final
pass — never after it.

## 5. Why Vite is pinned to 7

Vite 8 is rolldown-based. Forced to a single IIFE chunk (which is what a classic-script app
needs), rolldown inlines its CommonJS runtime **after** the modules that call it. Unminified:

```js
// line 3
var require_fails = /* @__PURE__ */ __commonJSMin(((exports, module) => { …
// line 6266
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
```

Minified, the helper is `var Y = (e, t) => …` and the app dies on the first line with
`TypeError: Y is not a function`. Rolldown's runtime is normally a separate chunk imported
first (`import { t as __commonJSMin } from "../assets/rolldown-runtime-*.js"`), which works for
ESM output but is not usable on Gecko 48.

Reproduce: install `vite@8`, set `build.rollupOptions.output.format = 'iife'`, build, and
compare the offsets of the helper definition and its first use.

Vite 7's Rollup path has produced IIFE bundles for years and does it correctly. When revisiting
this, the check is not "does it build" — it is "does `dist/js/app.js` run", which is what
`scripts/smoke-legacy.mjs` answers.

## 6. Static gates prove packaging; only execution proves runtime

The static gate (`verify-legacy.mjs`) happily passed the bundle that threw
`Cannot set properties of undefined` at startup. Parsing is not running.

`smoke-legacy.mjs` therefore boots the **shipped** file in a jsdom realm with every
post-ES2015 built-in deleted, then drives it with KaiOS key events. That is the check that
proves the polyfills are actually present, rather than merely configured.

Two lessons about the gate itself:

- **Vue patches the DOM asynchronously.** Assertions immediately after `dispatchEvent` read the
  previous render. Four "app bugs" turned out to be this; the test now awaits a microtask after
  every key press.
- **The realm is jsdom's DOM, which is newer than Gecko 48's.** The gate covers JavaScript
  built-ins and app behaviour, not DOM API age (`Element.prototype.append` is FF49, for
  instance, and jsdom provides it). Confirm on a handset before a store release.

## 7. KaiOS platform findings

- **Key names** are exactly `SoftLeft`, `SoftRight`, `Enter`, `ArrowUp/Down/Left/Right`,
  `Backspace`. Arrow keys simulate the softkeys in the simulator, not on device.
- **Back semantics are context dependent** (`design-guide/key`): in a text field it clears a
  character; otherwise it goes up one level; at the top level it leaves the app. The app must
  therefore *not* consume it in a text field, and must not consume it at the top level either —
  unhandled is the correct handling.
- **The D-pad's caret claim in a text field is bounded by the text.** The guide gives the arrows
  to the caret (and Back to clearing), which the handler honours while the caret has a line to
  move to — a one-line `<input>` never does, and a `<textarea>` only where a newline lies on that
  side of the caret. At the edge the highlight takes the press and `select()` moves focus off the
  field. Without that bound the field is a trap: it is focused as soon as the highlight lands on
  it, so every arrow press was swallowed and nothing else on the screen could ever be reached.
- **The D-pad contract in KaiOS's own samples** is a `[nav-selectable]` attribute plus
  `nav-selected="true"` on the highlighted element, and a softkey bar of `#softkey` with
  left/centre/right labels. This project keeps those attributes for CSS/tooling compatibility
  but tracks selection in `nav.ts` by uid, because writing `nav-selected` from outside Vue
  fights the renderer.
- **Units**: `1rem = 10px` on the guide's reference display (140 ppi, QVGA 240×320).
- **The public design guide has no colour page.** The full docs sitemap for
  `design-guide/*` is: action-icon, basic-navigation, hosted-app, key, launcher-icon,
  marketing-banner, typography, ui-component. The original palette therefore came from KaiOS's
  own sample app (`#E1E2E1` background, `#F5F5F6` surface, `#242424` text, `#cbcbcb` border),
  and chrome metrics (36 px header, 30 px softkey bar, 40 px rows) from the same source. The
  app's palette has since moved to the calm "dawn light" re-theme in `src/styles/kaios.css` —
  same chrome metrics, deeper slate-indigo accent — because the sample's muted grey failed
  WCAG AA (2.1–2.4:1) and its accent failed both AA pairs (4.1:1 white ink, 3.8:1 as text).
- **One genuine conflict in the guide**: the typography table gives software key text as
  H5 = 14 px/600, while the sample renders the centre key at 18 px. The sample wins for chrome
  metrics and the table wins for the type ramp; the deviation is commented in
  `src/styles/kaios.css`.
- **`cursor: true`** in the manifest enables the platform's "Emulated Cursor Navigation"
  (`design-guide/basic-navigation`) — an alternative to the app managing selection itself. It is
  not enabled here because it would fight `nav.ts`.
- **Privileged apps run without `unsafe-eval` and without inline scripts**, so the Vue runtime
  compiler (which uses `new Function`) is unusable — only precompiled SFCs. Vite resolves `vue`
  to the runtime-only build already; the gate asserts no `new Function` survives.
- **`systemXHR` is the only way to reach a server that sends no CORS headers.** It applies to
  `XMLHttpRequest` created with `mozSystem: true` and has no `fetch()` equivalent, which is why
  all remote access goes through `src/kaios/xhr.ts`. Verified: MDN's search API sends no
  `Access-Control-Allow-Origin`, so a fetch-based client could not reach it from a page even
  inside the privileged app.

## 8. The blank page: what removing `type="module"` also removes

There were two independent causes of "built app loads, `#app` stays empty". The first one is about
*which folder is the app*; the second is about *when the script runs*.

### 8.1 The project root is not an app (the one that actually bit)

`manifest.webapp` originally sat at the repository root, which made the **project folder** look
like a valid KaiOS app to WebIDE and the simulator. Pointing either of them at it produced:

- a package containing the entire project — `node_modules/`, `src/`, `scripts/`, and a nested
  `dist/` — because the tool packages the folder it is given;
- and, as the app's page, the root `index.html`, which is the **Vite source entry**:

  ```html
  <script type="module" src="/src/main.js"></script>
  ```

Gecko 48 does not execute `type="module"` scripts at all, and `/src/main.js` does not exist in a
package anyway, so *no application code ever runs*. The HTML parses, `#app` exists, and nothing
fills it. Nothing errors, because nothing is executed.

The fix is structural rather than cosmetic: `manifest.webapp` moved to `public/manifest.webapp`
(Vite copies `public/` verbatim), so **only `dist/` is an installable package**. WebIDE pointed at
the project root now fails with "no manifest" instead of silently shipping `node_modules` and a
dead page. `npm run verify` fails if a root manifest ever comes back:

```
[layout] manifest.webapp exists at the repo root: WebIDE would package the whole project
and load the unusable source index.html instead of dist/
```

Rule of thumb: **build, then point the tool at `dist/`.**

### 8.2 `<script>` timing — the same symptom, a different cause

Vite injects the entry script into `<head>` as `type="module"`. Module scripts are deferred by
specification, which is why the dev server was always fine. The production HTML transform strips
`type="module"` — that is the whole point of it — and in doing so turned the tag into a classic
script that executes **while the head is still being parsed**:

```html
<script src="./js/app.js"></script>   <!-- runs before <div id="app"> is parsed -->
```

`createApp(App).mount('#app')` then has no target. It does not always look the same, because the
mount does not happen at that instant: it sits behind `initL10n()`, which resolves from a timer
or an event. So the app either throws a mount error or *wins a race against the parser* — and a
200 kB parse on a 1.1 GHz phone loses that race far more often than a laptop does. Intermittent
blank pages, and a bundle that works when you test it locally and not on the handset.

**Fix, in one line:**

```html
<script src="./js/app.js" defer></script>
```

`defer` restores exactly the semantics `type="module"` had provided: fetch in parallel, execute
after parsing, in document order. `async` is not an alternative — it fires on arrival, which is
the original problem.

**Why both gates missed it.**

- The runtime gate `eval`'d the bundle *after* constructing the full DOM from the HTML, so
  `#app` always existed. It modelled the bundle, never the page's execution order.
- The static gate asserted `type="module"` was *absent*. It never asked *when* the script runs.
- Loading the page faithfully in jsdom is not enough either: **jsdom fetches external scripts
  asynchronously, so a script a browser would run during parsing effectively runs after it.**
  Execution *timing* cannot be caught dynamically here at all; it has to be a static rule.

That rule now lives in `verify-legacy.mjs` and fires deterministically on the broken build:

```
[html] <script src="./js/app.js"> is in <head> without defer — it runs before #app exists, so the app cannot mount
[html] <script src="./js/libs/l10n.js"> is in <head> without defer — it runs before #app exists, so the app cannot mount
```

The second line is not noise: the platform l10n script has the same constraint, since the app
must find `navigator.mozL10n` already installed.

**Related: root-absolute asset URLs.** The same blank page appears for a second, unrelated
reason if `dist/index.html` is opened over `file://` or served from a subdirectory: `/js/app.js`
resolves to the filesystem root or the server root and 404s. `base: './'` in `vite.config.js`
removes that. On a device nothing changes — the app is served from its own origin root, so
`./js/app.js` and `/js/app.js` are the same URL — but off-device the package can now be opened
directly. Note that over `file://` the browser blocks the XHR that loads
`data/*.properties`, so strings render as message ids rather than text; use `npm run preview`
for a fully correct local run.

## 9. Smaller findings

- **Babel 8 removed `bugfixes`** (always on) and **removed `useBuiltIns`** from
  `@babel/preset-env`; the supported replacement is `babel-plugin-polyfill-corejs3`. Errors are
  explicit: `The 'useBuiltIns' option has been removed. Please use babel-plugin-polyfill-corejs3 instead.`
- **`regenerator-runtime` is not needed.** Babel 8 inlines a regenerator helper as a local
  function (no `function*`, no global `regeneratorRuntime` — both verified absent in the
  bundle), so the dependency was removed. The async path is exercised by the runtime gate.
- **Autoprefixer contributes nothing for Gecko** — Firefox does not want the prefixes it adds.
  It stays configured because it keeps `browserslist` in package.json as the one declaration of
  the target for CSS tooling, but do not expect output from it.
- **`build.cssTarget` is the exception to the `esnext` rule.** esbuild lowers CSS completely and
  safely, so pointing it at `firefox48` is a net win: nested CSS and other modern syntax are
  compiled rather than shipped.
- **`zip` alone cannot express the packaging rules.** `scripts/package-kaios.mjs` always
  re-checks that `manifest.webapp` is at the archive root, because a wrapping folder makes the
  package silently unrecognisable to the device.
- **`mozL10n.get()` returns an empty string, not the id, when the locale data could not load.**
  That is how the `file://` case showed up as chrome with blank labels rather than an obvious
  failure. `t()` in `src/kaios/l10n.ts` now falls back to the id for `undefined`, `null` and
  `''`, so a missing or unloadable translation is visible instead of invisible.

## 10. If you change the pipeline

1. Nothing may be excluded from the syntax pass. core-js is excluded from the *injection* pass
   only, and for ordering reasons.
2. Every tool that emits or rewrites JavaScript must be given the real target — or must run
   before the pass that enforces it. `esnext` is safe for the bundler *only* because Babel
   finishes last.
3. Adding a target spelling? Put it in `scripts/target.js`. A tool that does not recognise the
   target you gave it may not tell you.
4. **Every `<script src>` that ends up in `<head>` must be `defer`.** Vite emits the entry as
   `type="module"` (deferred by spec); the transform that strips the attribute must put the
   deferral back. If a page renders empty, check this before anything else — it is invisible
   until it is a race.
5. Nothing but a browser models execution timing. jsdom resolves external scripts
   asynchronously, so guards for "runs too early" have to be static rules in
   `verify-legacy.mjs`, not assertions in the runtime gate.
6. `npm run verify` after any change to Vite, Babel, core-js, or Vue versions. Both gates, not
   just the build. And when a check passes, ask what it would take for it to fail — the blank
   page passed both gates.
