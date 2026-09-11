# Sokai

The Solar Network app for KaiOS. The Sekai of Solar Network, S(e)okai.

Vue 3 + Vite app packaged as a KaiOS 2.5 *privileged* Open Web App.

## Quick start

```bash
npm install
npm run dev        # desktop browser, hot reload, 240x320 viewport recommended
npm run build      # -> dist/, compiled for the handset
npm run verify     # static + runtime checks against Gecko 48
npm run package:kaios   # build + verify + build/sokai-<version>.zip
```

Deploy by loading `dist/` (or the zip) through KaiOS WebIDE, or by copying `dist/` to a
device. Store submission additionally requires the package to be signed by KaiOS.

## The KaiOS constraint

KaiOS 2.5 runs the **Gecko 48** engine (Firefox 48, 2016). That is the whole reason this
project has a build pipeline instead of just a bundler: modern source does not merely look
wrong on Gecko 48, it throws.

`scripts/target.js` is the single place that names the target. It is spelled three ways
because the tools disagree about how to say "KaiOS 2.5": browserslist knows `kaios 2.5`,
Babel's compat data does **not** (it throws `'kaios' is not a valid target`, and the
core-js provider then silently falls back to polyfilling the entire library — 431 modules
instead of 84), and esbuild takes `firefox48`.

### How the bundle is compiled

`scripts/vite-plugin-kaios-legacy.js` runs Babel in three passes. The placement of each is
load-bearing:

1. **Per module, before bundling** (`transform`) — `@babel/preset-env` lowers syntax, and
   `babel-plugin-polyfill-corejs3` injects `import 'core-js/…'` for the APIs the code
   actually uses. This has to happen while the bundler can still resolve imports, and it has
   to include `node_modules`: dependencies ship post-ES2015 syntax and built-ins of their own.
2. **The bundler and its minifier**, both left at `esnext` on purpose. esbuild's minifier
   rewrites *toward* its target, so pointing it at Gecko 48 lets it re-emit syntax the engine
   cannot parse, and Vite's own chunk transpile fails outright on this chunk.
3. **After everything else has written the file** (`writeBundle`) — a final lowering pass
   over `dist/js/app.js`. This is the pass that decides what ships, so nothing may run after
   it.

`core-js` itself is excluded from pass 1: injecting polyfills into the polyfill library is
pointless, and it perturbs `@rollup/plugin-commonjs`'s interop ordering badly enough that the
bundle calls a module's `require…()` before the `var name = { exports: {} }` it needs. Its own
modern syntax is lowered by pass 3.

The reasoning behind each placement, the failures that forced them, and the error strings to
search for: [`docs/gecko48-build-notes.md`](docs/gecko48-build-notes.md).

## What `npm run verify` enforces

Two gates, because they catch different things.

`scripts/verify-legacy.mjs` — static, on `dist/`:

| Check | Why it breaks on device |
| --- | --- |
| Whole bundle parses as `ecmaVersion: 6` `sourceType: script` | FF48 has ES2015 and nothing newer: no async/await, no object spread, no `?.`/`??`, no `**`, no optional catch binding |
| No `type="module"`, `crossorigin`, `modulepreload` in `index.html` | Gecko 48 has no ES module support and silently ignores such scripts |
| No inline `<script>` | Privileged apps run under a CSP that forbids it |
| No `new Function(...)` / bare `eval(...)` | Same CSP, no `unsafe-eval` |
| CSS denylist | CSS Grid (FF52) and flex `gap` (FF63) do not degrade, they collapse layout; also `:is()`, `min()`/`max()`, `:focus-within`, `aspect-ratio`, `dvh`, … |
| `launch_path` and every icon exist in the package, manifest matches the repo root | A missed icon is a store rejection |

`scripts/smoke-legacy.mjs` — runtime. It boots the **shipped bundle** inside a jsdom realm with
every post-ES2015 built-in deleted (`Array.prototype.flat`, `Object.fromEntries`,
`Promise.finally`, `NodeList.prototype.forEach`, `globalThis`, …), then drives it with KaiOS
key events: D-pad movement and list-loop wrap, `Enter` to open a screen, a search that must go
out through `systemXHR`, and `Back` at the top level falling through to the platform. 21
assertions. This is the check that proves the polyfills are actually present rather than
merely configured.

The realm still provides jsdom's DOM, which is newer than Gecko 48's: these gates cover
JavaScript and app behaviour, not DOM API age. Confirm on a handset before a store release.

## KaiOS design guide

Implemented against `developer.kaiostech.com/docs/design-guide`:

- **Units** — `1rem = 10px` at the guide's reference display (140ppi QVGA 240x320). The type
  ramp in `src/styles/kaios.css` is named after the guide's labels (H1, H3, H5, P.PRI, …).
- **Chrome** — header (36px, uppercase) and softkey bar (30px, `SoftLeft`/`Enter`/`SoftRight`
  with the centre key larger) follow the KaiOS team's own sample app, which is also the source
  of the palette: the public guide documents no colour spec, so `--kai-color-accent` is the one
  knob to re-theme.
- **Components** — `KaiHeader`, `KaiSoftkey`, `KaiList`, `KaiListItem`, `KaiInput`,
  `KaiProgress`. Add the rest (Tab, Dialog, Option Menu, …) when a screen needs them; unused
  components are not scaffolded.
- **Navigation** — the guide's list rules: `Down` at the last item wraps to the first, `Up` at
  the first wraps to the last. Selection is tracked in `src/kaios/nav.js` by uid so Vue stays
  authoritative over the DOM; `[nav-selectable]` / `[nav-selected="true"]` attributes are kept
  for CSS and tooling compatibility.
- **Keys** — `SoftLeft` / `SoftRight` / `Enter`, D-pad arrows, `Backspace` as Back. Per the
  guide, Back inside a text field clears a character and D-pad moves the caret, so the handler
  stays out of the way while a text field has focus; at the top level Back is not consumed and
  the platform leaves the app. Entering a text field opens the platform's own softkey bar.
- **Localisation** — `public/data/*.properties` served through the platform's `l10n.js`, read
  with `t()` from `src/kaios/l10n.js`. `t()` registers a reactive dependency, so strings that
  arrive after first paint still render.

## Privileged network access

`manifest.webapp` requests `systemXHR`, which is what lets a privileged app reach servers that
send no CORS headers. That privilege only applies to `XMLHttpRequest` created with
`mozSystem: true`; `fetch()` has no equivalent. Every remote call therefore goes through
`requestJSON()` in `src/kaios/xhr.js`.

The demo Search screen is wired to a CORS-enabled public API so it also works in the desktop dev
server. It is an integration point, not a feature: point `SEARCH_ENDPOINT` in
`src/views/SearchView.vue` at the Solar Network API, and the privileged path keeps working where
a browser would refuse.

## Layout

```
index.html                 Vite entry; loads the platform l10n script
manifest.webapp            copied into the bundle by scripts/vite-plugin-kaios-manifest.js
src/
  main.js                  entry: key handler, l10n, mount
  App.vue                  screen stack + softkey bar
  kaios/                   keys, nav/softkeys, screen stack, l10n bridge, systemXHR
  components/              KaiOS UI components
  views/                   Home, Search, About
  styles/kaios.css         design tokens + primitives
public/                    copied verbatim: l10n data, l10n.js, manifest icons
scripts/                   target, Babel config, Vite plugins, both gates, packager
```

## Trade-offs worth knowing

- **Vite is pinned to 7.** Vite 8 (rolldown) inlines its CommonJS runtime *after* the modules
  that call it when forced to a single IIFE chunk, so the bundle throws at load. Vite 7's Rollup
  path has supported IIFE for years.
- **No source maps.** Three transpilers deep a map would be a chain of approximations, and the
  package has to exclude it anyway.
- **Bundle size** is ~200kB (~76kB gzip), mostly core-js: its compat data is deliberately
  conservative and polyfills spec-conformance details for engines as new as Firefox 69. If that
  ever matters more than conformance, prune with the polyfill plugin's `shouldInjectPolyfill`.
- **No vue-router.** KaiOS has no address bar and the Back key is the only history; the screen
  stack in `src/kaios/views.js` is ~20 lines.
- **`type: "privileged"`** is required for `systemXHR`, and privileged packages must be signed
  for the store. `cursor: true` in the manifest is the alternative to this app's own D-pad
  handling and is not enabled — it conflicts with managing selection in `nav.js`.
