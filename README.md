# Sokai

The Solar Network app for KaiOS. The Sekai of Solar Network, S(e)okai.

Vue 3 + Vite app packaged as a KaiOS 2.5 *privileged* Open Web App.

## What it does

The app opens on a **dashboard** — a clock card and one card per top-level screen, currently
Explore and About, with room for the log-in and notification entries that come next. Explore lists
public Solar Network posts from `api.solian.app`, with pictures; opening one shows its body as
markdown, its attachments above the card, and its replies underneath. D-pad and softkeys only.

Every read route is anonymous — no `Authorization` header — and the server limits anonymous
responses to published, non-draft, public posts. Composing, reactions and video playback are not
implemented yet; nothing in this increment writes to the API.

## Quick start

```bash
npm install
npm run dev        # desktop browser, hot reload, 240x320 viewport recommended
npm run build      # -> dist/, compiled for the handset
npm run verify     # static + runtime checks against Gecko 48
npm run package:kaios   # build + verify + build/sokai-<version>.zip
```

Deploy by pointing KaiOS WebIDE (or the simulator) at **`dist/`** — never at the project root.
Only `dist/` is an installable package: `manifest.webapp` lives in `public/`, so the repository
root has no manifest and WebIDE will refuse it instead of quietly packaging `node_modules` and
loading `index.html`, which is the Vite *source* page and does not run on Gecko 48 (that shows up
as an empty `#app` with no error anywhere). `npm run verify` fails if a manifest ever reappears at
the root.

For a single artefact, `npm run package:kaios` produces `build/sokai-<version>.zip` with
`manifest.webapp` at the archive root; that is what store submission consumes. Signing is done by
KaiOS, so sideload an unsigned `dist/` through WebIDE.

To run the **built** package locally, serve it — `npm run preview` (or any static server rooted
at `dist/`). Opening `dist/index.html` straight off the filesystem also works now that assets
use relative URLs, but browsers block the `file://` request that loads
`public/data/*.properties`, so every string renders as its message id instead of translated
text. Use the preview server when localisation matters.

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
| Every `<script src>` in `<head>` has `defer` | A classic script in the head runs before `<div id="app">` is parsed, so the app cannot mount — a blank page with an empty `#app`. Removing `type="module"` removed the deferred execution modules get for free |
| No inline `<script>` | Privileged apps run under a CSP that forbids it |
| No `new Function(...)` / bare `eval(...)` | Same CSP, no `unsafe-eval` |
| CSS denylist | CSS Grid (FF52) and flex `gap` (FF63) do not degrade, they collapse layout; also `:is()`, `min()`/`max()`, `:focus-within`, `aspect-ratio`, `dvh`, … |
| `launch_path` and every icon exist in the package, manifest matches the repo root | A missed icon is a store rejection |

`scripts/smoke-legacy.mjs` — runtime. It boots the **shipped bundle** inside a jsdom realm with
every post-ES2015 built-in deleted (`Array.prototype.flat`, `Object.fromEntries`,
`Promise.finally`, `NodeList.prototype.forEach`, `globalThis`, …), then drives it with KaiOS
key events against canned copies of the Solar Network responses: the dashboard's entries and clock,
the post-list request (privileged `systemXHR`, anonymous, offset-paginated, `x-total` parsed),
D-pad movement and list-loop wrap, the row's quote, picture, attachment and count lines, `Enter` to
open a post whose body must render as markdown rather than as escaped text (with its quoted parent
rendered as markdown too, its attachments above the card, and only Solar Network file images
fetched), the replies that arrive with it, the status-bar inset rule, and `Back` at the top level
falling through to the platform. 54 assertions. This is the check that proves the polyfills are
actually present rather than merely configured.

The realm still provides jsdom's DOM, which is newer than Gecko 48's: these gates cover
JavaScript and app behaviour, not DOM API age. Confirm on a handset before a store release.

## KaiOS design guide

Implemented against `developer.kaiostech.com/docs/design-guide`:

- **Units** — `1rem = 10px` at the guide's reference display (140ppi QVGA 240x320). The type
  ramp in `src/styles/kaios.css` is named after the guide's labels (H1, H3, H5, P.PRI, …).
- **Chrome** — header (36px, uppercase) and softkey bar (30px, `SoftLeft`/`Enter`/`SoftRight`
  with the centre key larger) follow the KaiOS team's own sample app, which is also the source
  of the palette: the public guide documents no colour spec, so `--kai-color-accent` is the one
  knob to re-theme. It is `#7577ba`, and the manifest's `theme_color` hands the same value to
  the Launcher.
- **Accent contrast** — white ink on `#7577ba` measures 4.1:1, and `#7577ba` used as *text* on
  `--kai-color-surface` measures 3.8:1; WCAG AA asks 4.5:1 for body text, so those are the two
  pairs to re-measure on a re-theme (accent-coloured text is the markdown link, the `[image]`
  marker and the raised field label). A sibling of the same hue, `#6769ae`, passes both — 5.0:1
  and 4.6:1 — and dark ink on `#7577ba` passes at 4.6:1.
- **Dashboard** — the root screen, after the reference client's dashboard: a clock card (nothing
  from the network, so the screen is alive before the first request resolves) and one card per
  top-level screen, each with a title and a one-line description. It is the extension point — a
  new screen is a row in `DashboardView.vue`'s `ENTRIES` plus a view in `App.vue`'s map — and it
  makes no requests of its own. Back at the root is not consumed, so the platform takes it and
  leaves the app.
- **Post detail** — attachments live outside the post card, flush against its top edge; when the
  block holds a picture the touching corners are squared off so the two read as one column.
  `kai-content--roomy` adds the 12px of breathing room below the header that the card would
  otherwise lose to it.
- **Components** — `KaiHeader`, `KaiSoftkey`, `KaiList`, `KaiListItem`, `KaiProgress`,
  `KaiPostRow` (plus `KaiPostQuote` and `KaiAttachmentList` for what it embeds); `KaiInput` is
  kept for the compose screen that follows the read path. Add the rest (Tab, Dialog, Option
  Menu, …) when a screen needs them.
- **Post rows** carry what the wire already gives: author and handle, time, `edited`, kind
  (`Article`/`Blog`, moments unlabelled), non-public visibility, a `truncated` marker, the title,
  a three-line excerpt, the quoted parent of a reply or forward, attachment lines, reply/boost/
  reaction counts and tags. The excerpt is clipped by *visual width* — a CJK glyph costs two
  units (`src/content/markdown.js`) — because a character budget that fills five lines of Latin
  fills ten of CJK, and `-webkit-line-clamp` needs `display: -webkit-box`, which Gecko 48 lacks.
- **Pictures** are shown, not described. A picture attachment renders as an `<img>` on
  `https://api.solian.app/drive/files/{id}` — the same URL FloatLand and the Flutter client use —
  with the `width`/`height` from the wire as its box, so a row does not resize as bytes land
  (Gecko 48 has no `loading="lazy"`, so the intrinsic size is the only placeholder available). The
  server answers `307` to a signed object-storage URL and serves a compressed WebP: 24kB–350kB
  across five sampled posts. A row crops its one picture to 120px (`object-fit: cover`, Firefox
  32+) and keeps the metadata as its caption; the detail screen shows each picture whole. An image
  that fails to load falls back to the caption, `[image]` included.
  - Inline `![alt](solian://files/{id})` images in a body are rendered too — markdown-it drops any
    `src` outside its scheme allowlist, so that one scheme is admitted in `src/content/markdown.js`
    and nothing else is: an image pointing anywhere else on the internet stays the `[image]` marker
    and is never fetched.
  - The privileged app CSP already starts at `default-src * data: blob:`
    (`security.apps.privileged.CSP.default`), so remote images need no manifest `csp` entry —
    and a `csp` value can only ever be *stricter* than that default.
  - Video is not played and its poster is not shown: the platform generated a thumbnail for one
    attachment in ninety, so a video stays a `[video] … · … MB` line.
- **Attachments without a picture** — documents, audio, video — stay metadata lines: `[file]
  notes.pdf · 1.5 KB`. Nothing is fetched for them, and `?thumbnail=true` 404s where the platform
  has no thumbnail.
- **Safe area** — the KaiOS status bar is 26px and `manifest.webapp` does not request
  `fullscreen`, so it is shown. The app reserves that space by default: `src/kaios/screen.js` sets
  `--kai-safe-top` and the header carries it as top padding, so its background runs under the bar
  and the title clears it. The one detectable case is the platform having reserved the space
  already — a handset whose panel matches the viewport's width and is a bar taller — where the
  inset drops to zero; off-device `screen` is a monitor, so the dev server and the gates get the
  same reserved layout the handset does.
- **Navigation** — the guide's list rules: `Down` at the last item wraps to the first, `Up` at
  the first wraps to the last. An element registered with `scrollFirst` instead takes the arrow
  keys until the view has been scrolled to its end — the post body, which is otherwise taller
  than the screen and unreachable. Selection is tracked in `src/kaios/nav.js` by uid so Vue stays
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
`request()` in `src/kaios/xhr.js`, which hands back the status, the response headers (the post
list reports its row count in `x-total`) and the parsed body, and takes a method and a JSON body
for the write paths that come later.

`src/api/solian.js` is the only module that knows an API URL. Every route it calls is anonymous:
public Sphere reads need no `Authorization` header, and the server limits anonymous responses to
published, non-draft, public posts. The edge happens to send CORS headers as well, so the same
code works in the desktop dev server — but the privileged path is what matters on a handset.

## Layout

```
index.html                 Vite entry (source only — not a runnable page)
src/
  main.js                  entry: key handler, l10n, mount
  App.vue                  the view map + softkey bar
  api/                     Solar Network client, wire → model normalisers
  content/markdown.js      post bodies: markdown in the detail, plain text in a row
  kaios/                   keys, nav/softkeys, screen stack, l10n bridge, systemXHR, status bar
  components/              KaiOS UI components
  views/                   Dashboard, Explore, Post, About
  styles/kaios.css         design tokens + primitives
public/                    copied verbatim into dist/: manifest.webapp, l10n data,
                           l10n.js, manifest icons
scripts/                   target, Babel config, Vite plugins, both gates, packager
dist/                      the only installable app package (build output)
```

## Trade-offs worth knowing

- **Vite is pinned to 7.** Vite 8 (rolldown) inlines its CommonJS runtime *after* the modules
  that call it when forced to a single IIFE chunk, so the bundle throws at load. Vite 7's Rollup
  path has supported IIFE for years.
- **No source maps.** Three transpilers deep a map would be a chain of approximations, and the
  package has to exclude it anyway.
- **Bundle size** is ~331kB (~131kB gzip). Roughly half of it is core-js: its compat data is
  deliberately conservative and polyfills spec-conformance details for engines as new as Firefox
  69. The rest is Vue plus `markdown-it`, which renders post bodies — a hand-written renderer
  would be smaller, but escaping user content is exactly the bug class worth paying a library
  for. If the core-js share ever matters more than conformance, prune it with the polyfill
  plugin's `shouldInjectPolyfill`.
- **No vue-router.** KaiOS has no address bar and the Back key is the only history; the screen
  stack in `src/kaios/views.js` is ~20 lines.
- **`type: "privileged"`** is required for `systemXHR`, and privileged packages must be signed
  for the store. `cursor: true` in the manifest is the alternative to this app's own D-pad
  handling and is not enabled — it conflicts with managing selection in `nav.js`.
