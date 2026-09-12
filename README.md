# Sokai

The Solar Network app for KaiOS. The Sekai of Solar Network, S(e)okai.

Vue 3 + Vite app packaged as a KaiOS 2.5 *privileged* Open Web App.

## What it does

The app opens on a **dashboard** — a clock with the weekday and date set beside it, above the
app's own list of tiles. The first tile is the next Solar Network event: its name with how far
off it is, and the day and span it falls on under them. That tile is
the way into the **Calendar**, a full month view: a Monday-started grid with a dot per day that
carries an event and a hollow one for a holiday the network knows, the day's events listed under
it, and previous/next month plus Today on the softkeys. The rest of the dashboard is one tile per
top-level screen: Explore, **Chat**, **Notifications**, **Account** and About.
Explore lists Solar Network posts
from `api.solian.app`, with pictures, and the page-flip controls sit above the feed in one row —
previous, the page count, next — under a searchbar that pushes the **Search** screen: a field,
and the same page controls over its results. Opening a post shows its body as markdown, its
attachments above the body, its chain — the posts it carries on into — and its replies underneath,
paged with the same controls. **Chat** lists the account's rooms with
their unread counts and last-message previews (a direct room is titled by its other members),
scoped with the watch's own all/direct/groups filter; the left softkey is its write path, opening
the room features — a new message picked from account search, pending invites, the filter, chat
search and mark-all-read — while the right one opens the highlighted room. Inside a room the
thread renders as two-sided bubbles, opening it marks it read, the composer sends text from the
right softkey, and the left softkey holds the room's own actions (mark read, leave).
**Notifications** is the account's inbox: a row per notification, led by the actor's face or, when
the server sent none, the glyph its topic names — a reply arrow, a heart, a wallet, a bell for a
topic this build does not know — then the title, how long ago it landed, and the body clipped to a
row's worth of text. A dot marks what the account has not seen. The centre key opens what the row
points at when this app has a screen for it (a notification about a post opens the post) and marks
it read either way, the left key reloads the page, and the right key takes the whole inbox as read
in one call.
**Account** signs in through the OAuth 2.0 device flow (the code
to type on another device), shows the signed-in identity, and signs out.
D-pad and softkeys only. The right
softkey is held for the write actions that follow the read path — reply, reactions, send — and is
empty until they land.

Reads go out with the session's `Authorization: Bearer` header when one exists, and anonymously
otherwise; the server limits anonymous responses to published, non-draft, public posts. Posts,
reactions and chat messages can be written, and chats can be started, joined, searched and left;
post and message bodies can be dictated where the handset has the platform's speech service;
sent attachments, editing and deleting messages, room creation, typing indicators and calls are
not implemented yet. Beyond the session and the posts it writes,
the app keeps a local chat cache — IndexedDB, removable, capped (see
[Chat storage](#chat-storage)).

## Quick start

```bash
npm install
npm run dev        # desktop browser, hot reload, 240x320 viewport recommended
npm run build      # -> dist/, compiled for the handset
npm run verify     # static + runtime checks against Gecko 48
npm run package:kaios   # build + verify + build/sokai-<version>.zip
```

In the desktop browser the app's screen stack is reflected in the URL (`#/explore`,
`#/post?id=…`) via `src/kaios/hash.ts`, so a refresh returns to the same screen and a
screen is bookmarkable. That is a dev/testing affordance only: the sync is gated on
`screen` being a monitor, and a KaiOS panel has no address bar — the hardware Back
key is the app's own history, and the bundle never touches `location` on a handset.

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
| No flex/grid display on a `<button>`'s own class | FF48 cannot lay a `<button>` out as a flex container (FF52, bug 984869). It does not reject the declaration — it drops `align-items`/`justify-content` and puts the contents on the text baseline, so an icon row reads as mis-centred on the handset and perfectly centred in the dev browser. The layout goes on an inner element |
| `launch_path` and every icon exist in the package, manifest matches the repo root | A missed icon is a store rejection |
| Every platform API the bundle uses has its manifest privilege (`webkitSpeechRecognition` → `speech-recognition`, `mozGetUserMedia` → `audio-capture`) | A privilege the manifest does not request is a feature that silently degrades on device — the call rejects and the UI just reports a failure; nothing else in the pipeline would notice |

`scripts/smoke-legacy.mjs` — runtime. It boots the **shipped bundle** inside a jsdom realm with
every post-ES2015 built-in deleted (`Array.prototype.flat`, `Object.fromEntries`,
`Promise.finally`, `NodeList.prototype.forEach`, `globalThis`, …), then drives it with KaiOS
key events against canned copies of the Solar Network responses: the dashboard's entries, clock,
next-event tile and the bare circular spinner it shows while a page flips, the calendar screen
one keypress away from it (the month request it makes, six Monday-started weeks, the cursor on
the day the dashboard named, the day's marks, the agenda rows, week-by-week D-pad movement,
the month flip and the Today softkey), the post-list request
(privileged `systemXHR`, anonymous, offset-paginated, `x-total` parsed), the searchbar above the
one-row pager of always-present icon cells (previous, count, next; the inert boundary cell is
dimmed) with the highlight starting on the first post, D-pad movement and list-loop wrap, the
row's quote, picture, attachment and count lines, `Enter` to open a post
whose body must render as markdown rather than as escaped text (with its quoted parent rendered
as markdown too, its attachments above the body, the identity block leading the body on the
page rather than in a card, and only Solar Network file images fetched), the
replies that arrive with it under their own separator with the pager leading them (a flip fetching
the next offset and replacing the list, the chain the post carries on into rendered between the
body and the conversation, and a reply whose parent is already on the screen dropping its
`Replied to` quote), the status-bar inset rule, the searchbar pushing the Search screen
whose field starts highlighted and whose committed query hits the posts search endpoint, the
text-field key rule (a one-line field never keeps an arrow; a multi-line body keeps it only while
the caret has a line to move to, and at the edge the highlight takes the press and the field gives
up focus — the compose body is no trap), `Enter` as the multi-line body's newline against the
one-line field's app action, the compose body carrying no underline where the searchbar field
draws one, the chat room list (both rooms, the direct room titled by its peer, the room avatar,
a room with no picture lettered into a circle, the unread count as a capsule beside rather than
inside the `sender: message` preview — with the attachment count where a picture-only message has
no text), the thread (oldest bubble first with the newest at the bottom, every bubble carrying
its sender's avatar and name, attachments rendered inside it), writing it as a screen of its own
(the media toolbar, a picked file joining the draft and uploading when the message is sent, the
sticker picker walking packs to a sticker whose placeholder is posted and then rendered as the
sticker — the send closing the picker and the composer with it, so the reader lands on the thread
rather than back in the field — a voice note opening in the viewer as playable audio with the
centre key driving it, and
every message a D-pad stop so a press moves one message, and the highlight drawn as the bubble's
own reserved border so the ring follows the bubble's corners), dictation in it (a settled phrase
landing in the draft
instead of the phrase in flight, the next phrase appending to what is written, a refused
microphone reported without leaving the tool latched, and leaving the screen ending the session),
the gateway handshake carrying the
namespace and the session token with `messages.subscribe` + `messages.read` sent for the open
room, a pushed `messages.new` landing in the thread without a refetch, the chat list's left-key
menu and its entries, the all/direct/groups filter narrowing and restoring the list, the list
rendering whole (one `take=100` request, no pager) with each row prefixed by its last message's
sender and each preview clipped to its one line, mark-all-read `POST`ing once and clearing the
badges, new message searching accounts and
creating the direct room that then opens, accepting an invite (whose group row is lettered rather
than given a member's face), and the room's own left-key actions (a further read receipt, and
leave asking once more before it `DELETE`s and returns to the list), the thread as a *window* on
a 620-message room: one `take=50` page on open with the rest behind the Load more row, a press
appending the next older page above the thread without moving the highlight, the tenth page
filling the window to five hundred rows, the eleventh sliding the newest fifty out of the view
while the offset follows them, a live message at the cap dropping the oldest row instead, and the
last page ending the history so the row goes with the highlight left where it was, a page carrying
a sync placeholder, a `call.start` and a `system.call.member.joined` row rendering four bubbles
from eight rows — the room's own events being no part of the conversation, whatever they carry —
the composer's
`Send` key
appearing with text and its message `POST`ed with the session token and a `client_message_id`
before the echo lands in the thread, a failed send dropping the optimistic row and restoring the
draft for the retry, the inbox (the account's rows read with the session token and rendered title
over time over body, a row led by the actor's picture or its topic glyph, the unread dot on the
rows the server has not seen and only those, no pager for a single page, the centre key opening
the post a notification names while the receipt `POST`s, the dot clearing once it has been
opened, the bulk read `POST`ing once and taking every row, the right key going inert with nothing
unread, and the sign-in gate signed out), and `Back` at the top level falling through to the
platform. Every `check`
is one assertion of a behaviour the user can see, and the run prints them all — a failure names
what broke, not a line number. This is the check that proves the polyfills are actually present
rather than merely configured.

The realm still provides jsdom's DOM, which is newer than Gecko 48's: these gates cover
JavaScript and app behaviour, not DOM API age. Confirm on a handset before a store release.

## KaiOS design guide

Implemented against `developer.kaiostech.com/docs/design-guide`:

- **Units** — `1rem = 10px` at the guide's reference display (140ppi QVGA 240x320). The type
  ramp in `src/styles/kaios.css` is named after the guide's labels (H1, H3, H5, P.PRI, …).
- **Chrome** — header (36px, uppercase) and softkey bar (30px, `SoftLeft`/`Enter`/`SoftRight`
  with the centre key larger) follow the KaiOS team's own sample app, which is the source of
  the chrome metrics: the public guide documents no colour spec, so `--kai-color-accent` is the
  one knob to re-theme. The palette is the calm "dawn light" re-theme (see
  `src/styles/kaios.css`): a cool grey-violet base, soft near-black ink, and a slate-indigo
  accent `#5e6a9e` pulled from the blue core of the brand mark. The manifest's `theme_color`
  hands the same value to the Launcher.
- **Accent contrast** — the accent is chosen to pass WCAG AA on both of its jobs at once:
  white ink on `#5e6a9e` measures 5.2:1, and `#5e6a9e` used as *text* on
  `--kai-color-surface` measures 4.8:1 (accent-coloured text is the markdown link
  and the raised field label); AA asks 4.5:1 for body text. Keep the replacement accent
  between those two pairs on a re-theme. Secondary text passes too: `--kai-color-text-muted`
  measures 5.8:1 on the surface and 5.1:1 on the page background the flat dashboard rows sit on
  (the sample app's own muted grey was 2.1–2.4:1 — unreadable, and the main reason for the
  re-theme).
- **Dashboard** — the root screen: the hero is the clock, after the reference client's
  dashboard — `HH:MM` at display size with the weekday and date as its caption on the same
  baseline, directly on the background (no card). Everything under it is one flat list of
  tiles, each a row with a hairline separator and the accent fill for the current one — the
  KaiOS sample app's own list look. The list's first tile is the next event, read the way the
  calendar screen's agenda rows read it: its name with the countdown beside it, the day and
  span under them. The clock needs nothing from the network, so the screen is
  alive before the first request resolves. It shows `HH:MM`, not seconds, and its timer is armed
  on the minute boundary — one wake-up a minute instead of sixty — and dropped while the app is
  not visible, so the dashboard does not spend battery repainting the same two digits. The
  next event is the one request the dashboard makes, fetched from the calendar/countdown route —
  from the user's own account when a session exists, else from a named account's public mix
  (`solsynth`); a failure leaves the tile reading `Nothing coming up` rather than erroring the
  screen. That tile is one control: the centre key (or a tap in the dev browser) opens the
  calendar on the day it was naming. This is the extension
  point — a new
  screen is a row in `DashboardView.vue`'s `ENTRIES` plus a view in `App.vue`'s map. Back at
  the root is not consumed, so the platform takes it and leaves the app.
- **Calendar** (`nav_calendar`) — the full month view behind the dashboard's next-event block,
  after the reference client's event hub. One month at a time: six Monday-started weeks, so the
  grid is always the same shape, with the days outside the month still drawn (the week only reads
  correctly with them) and dimmed. Each day carries a dot per kind of thing on it — a filled one
  for a calendar event, a hollow one for a notable day — and today is a hairline box while the
  cursor is a solid accent fill, so the two cannot be confused. The grid is a single selectable,
  the way the reaction picker is: the D-pad moves a day cursor inside it (clamping at the week's
  edges instead of wrapping onto the next day), and at the first and last rows it hands the press
  back, which is how the month bar above and the day's list below are reached. The selected day's
  events sit underneath as ordinary rows — title, then the span in the device's own time — with the
  centre key opening the description, and a notable day is a name rather than a control, so it is
  never a focus stop. The left softkey returns the cursor to today, and the month arrows are the
  only other chrome. A day with nothing on it has no row in the server's answer at all, so the
  month is fetched whole and the grid draws its own empty days; a month the cursor walks into is
  fetched when it is entered, and an answer for a month the cursor has left is dropped rather than
  painted.
- **Chat** — the second dashboard row, and the only screen with a two-sided layout. Writing is
  its own screen: the thread's left key opens a full-screen composer (field, media toolbar,
  attachment rows), because a 240x320 display cannot hold a thread and a keyboard at once.
  Signed out
  it explains what chat needs and offers the sign-in screen, the compose screen's arrangement.
  Signed in the room list loads cache-first (the stored rooms paint, then the remote list merges
  over them) and renders whole — no pager: a handset's chat list is a few screens, and the
  server's page boundary is not a user-facing concept, so `listAllChatRooms` walks it behind the
  screen. Each row leads with the room's avatar — its picture, a direct room's peer's, or, with
  neither, a circle lettered from the room's own name (the initials are the Flutter client's
  `avatarFallbackText` rule: one glyph for a CJK or emoji name, up to two initials otherwise).
  That fallback is what keeps the list's left edge straight; without it a room with no picture
  starts its text at the screen edge. It is one accent fill rather than a palette, because this
  design system gives every colour a meaning. The row then previews the room the way both other
  clients do — the unread count as a red pill, then `<sender>: <what they said>`, with the
  attachment count standing in when a picture-only message has no text. That preview is clipped
  to one line and ellipsised, pill outside the clip, so a room row shows what was last said
  rather than a paragraph of it. The left key is the write path — as it is on Explore — and opens the
  design guide's option sheet with the room features (new message, invites, filter, search,
  mark all read), each a screen of its own or an in-place action. The filter
  (all / direct / groups) is the watch's own scope control and survives navigation; choosing one
  retitles the screen. Invites act per row — accept and decline are the two softkeys under the
  highlight, which is why `KaiListItem` gained the `selected` contract the post rows already
  had. Opening a room loads its newest page, marks it read, and subscribes to its live events.
  The thread is a *window* on the room, not the whole of it: fifty messages load on open, the
  rest sits behind a Load more row above the oldest message, and at most five hundred are held
  at once — the newest slide out as older pages come in, the oldest as live messages arrive, and
  a row that leaves the window was already written to the IndexedDB cache, so nothing is lost
  from the device. The row is an ordinary selectable, so the D-pad reaches it by walking up past
  the oldest message, and it stays put while its page loads. A row that vanishes under the
  highlight — that row once the history runs out, a message deleted by a live event — hands the
  highlight to its nearest surviving neighbour rather than to the screen's own anchor, so a
  disappearing row never throws the reader to the bottom of the thread. The server's own
  non-messages are dropped before they reach the DOM: the `placeholder` row the gateway writes
  while a message syncs, and the room's own events — the markers an edit, a delete, a reaction or
  a pin leaves behind (`messages.*`), and the membership and call rows (`system.*`, `call.*`).
  Solian keeps events behind a three-level setting and hides every one of them at `none`
  (`_isSystemEventType` / `_shouldIncludeInActiveList`), which is the level this thread takes: a
  `call.start` row carries content, so its type — not its emptiness — is what keeps it out, and
  this build has no call screen for one to open. The same rule gates a live `messages.new` before
  it reaches a thread, a preview or an unread count.
  Every bubble is a D-pad stop — a press moves one message, in step with the list — and Enter
  opens the message's media when it has any, so a text-only bubble is selected with nothing to
  open. The highlight is the bubble's own border, not an outline: Gecko 48 draws an outline as a
  rectangle, which cut across the rounded corners of the bubble it was meant to mark. Every
  bubble reserves that border and keeps it transparent until it is the highlighted one, so the
  ring traces the bubble's own radius and cannot resize the message it lands on; on your own
  accent bubble it turns white, riding the accent edge instead of floating past it onto the page.
  Every bubble carries its sender (avatar and name, on the bubble's own side — your own sit
  right on the accent background, which is what the thread's flex column is for), and a
  message's attachments render inside it as the same rows a post shows: a picture or a video's
  poster frame with the play badge, a file as its line, two at most before the count. That line
  leads with an `[image]`/`[file]` tag in the accent colour — on a light surface, which is the
  design system's way of labelling a row without spending a hue — so every surface that inverts
  its own text has to carry the tag with it: a highlighted feed row, a highlighted draft row,
  your own message bubble, the black viewer. The tag does not inherit, so the list of inverted
  surfaces lives in one rule above `.kai-post__attach-kind`; a new inverted surface belongs
  there. (It is invisible in review otherwise: each surface looks right on its own, and the tag
  only breaks *in combination* — accent-on-accent in a highlighted row, dark-on-black in the
  viewer.) The thread scrolls as one region, and the platform keyboard only opens on the
  composer screen, which is where the field is.
  Sending media follows the post composer: camera, video, microphone and gallery each hand back a
  file, the file joins the draft as a removable row, and it uploads when the message is sent —
  so a discarded draft leaves nothing behind on the drive. The microphone records **in the page**
  (`getUserMedia` + `MediaRecorder`, `src/kaios/recorder.ts`), not through the platform's recorder
  activity: the take is visible while it runs, with its length ticking, and the right key ends it.
  A device without those APIs — or one where the user refuses the mic — falls back to the
  recorder activity, so audio is never a dead end. **Dictation** is the other voice tool, and a
  different thing: it is the platform's speech service (`SpeechRecognition`, which KaiOS adds on
  top of Gecko 48) turned into text in the draft, not a take. Each settled phrase is appended to
  what the composer already holds, while the phrase in flight is shown on a line under the
  toolbar — typing during a session is therefore never overwritten, and nothing is typed that the
  user did not mean to keep. The tool is drawn only where the device has the API, and the session
  is ended by the right key, the tool itself, or leaving the screen. Like the recorder, it is
  behind a manifest privilege (`speech-recognition`), and like the recorder it is optional rather
  than assumed: a handset whose recognition backend is absent or refuses simply reports it
  (`dictation_denied`, `dictation_no_speech`, `dictation_network`) and keeps the text field as
  the write path. A sticker is not a file at all: it
  sends as the `:prefix+slug:` placeholder, which is what the picker's rows name, and the thread
  renders that placeholder as the sticker image (looked up once per sticker through
  `/sphere/stickers/lookup`, then loaded as the same `thumb` preset as every other picture — the
  lookup's `/open` sibling redirects to the 1080px original). Sending one closes the picker *and*
  the composer it was opened from (`popTo('chat-room')`), landing on the thread the sticker went
  to: a sticker is the whole message, so there is nothing left to write in the field it came from.
  There is no room creation, no
  typing indicator and no calls; a lone in-app voice take sends through the server's dedicated
  voice endpoint (`meta.voice_url` + `meta.duration_ms`, the wire the watch and Flutter use),
  while a take sent beside text or other files stays an audio attachment.

  Every message is a D-pad stop and Enter opens the media it carries, so the arrows always move
  a message at a time and a text-only bubble is simply selected with nothing to open. That viewer
  plays **audio** as well as video, which is also how a *received* voice note
  is reachable: its bytes sit behind `meta.voice_url` rather than in an attachment row, so
  opening it builds the row the viewer needs and plays the URL as sent (absolute or
  server-relative). The highlight on a bubble is a ring, not a fill, because the bubble's
  background already says who sent it.
- **Notifications** (`nav_notifications`) — the third dashboard row: the account's inbox, read from
  `/metoer/notifications` and scoped by nothing else, because this app has no tenant app id of its
  own and every topic in the account's inbox renders — the row picks its glyph by the topic, and a
  topic this build has never heard of falls back to the bell rather than to a blank. A row leads
  with the actor's picture when the server sent one in `meta.pfp` and with that glyph otherwise —
  the reference tile's own split — then the title, the relative time and the body. The body is
  clipped by *visual width* the way a feed row's excerpt is, markdown stripped rather than
  rendered, and it falls back to the subtitle on the notifications the server left without one;
  the reference tile's compact reading drops the subtitle the same way. Unread is a dot rather
  than a fill, since the highlight already owns the row's background: it is the accent when the
  row is not highlighted and inverts with the row's text when it is — the chat list's red capsule
  is a *count*, and a mark is not a number. The centre key opens what the row points at where this
  app has a screen for it — the server's `meta.action_uri` is read for a post id in any of the
  shapes the Solian clients accept (`solian://posts/<id>`, `/posts/<id>`, the `solian.app` link) —
  and marks the row read either way; a notification about a profile, a realm or a chat room is
  read without being dropped somewhere unrelated, because a wrong screen is worse than none. The
  receipt is optimistic and rolls back if the server refuses, so the screen never claims a receipt
  the server did not take. The left key reloads the page (what arrived since) and the right key
  takes the whole inbox as read in one call — the only bulk path the server exposes — and goes
  inert once nothing on the page is unread. Paging is the feed's arrangement: the page count and
  the two arrow cells above the rows, reached with `Up` from the first row. The inbox is the
  session's own, so signed out it explains and offers the sign-in screen, and a sign-out wipes the
  rows with the rest of the account's state.
- **Account** — the device-flow sign-in (OAuth 2.0, RFC 8628) as its own top-level screen,
  reached from the dashboard. Signed out it explains what sign-in is and offers one action;
  signing in shows a QR code encoding the verification page with the user code prefilled
  (generated locally — `qrcode-generator` — nothing to fetch), the code itself, and the
  verification URI, polls the token endpoint (the
  interval the server set, growing by five seconds on `slow_down`), and reports denial or
  expiry. Signed in it shows the display name and `@nick` and offers About and **Sign out**,
  which revokes the server session and drops the local one. The flow lives in
  `src/kaios/session.ts` and mirrors SolianWatch's standalone auth, sharing its public client
  id (`solian-on-watch`).
- **Icons** — the Solar Network brand artwork from the Solian client's asset set, whose licence is
  copied to `public/img/icons/LICENSE.md` next to it (that licence is not the Apache-2.0 the rest
  of this repository uses). Generated from the 2050px padded source at 78% coverage of a square
  transparent canvas, so a circular launcher mask cannot clip the mark: 16, 48, **56**, 60, **84**,
  **112**, 128 — 56/112 are what the KaiStore asks for and 84 what the JioStore asks for, none of
  which the scaffold had. The light variant — the same artwork inside a white rounded tile — is
  the whole set: the dashboard hero draws no mark, so no dark-ink cut is shipped. The 2014 vector
  logo that used to sit there is gone with them.
- **Post detail** — attachments live outside the post body, flush against its top edge; both are
  pulled out over the content gutter so their edges snap to the screen edges — pictures square
  their corners, since the screen edge is the frame, and the lines under them (`+2 more`) take the
  gutter back, because a caption is text and not a picture. The body — the non-attachment section —
  is **not** a card: the picture above it is already edge to edge, so a surface and a shadow there
  would draw a seam rather than a step, and the rest of the app reads as rows on the page. It is one
  column instead, in the order a feed row reads: the author's avatar and name, the facts of
  publication (time, kind, edited, truncated, visibility) on the muted meta line, then the title —
  at the display size the clock uses, the one headline the app has room for — then the markdown
  body, the quoted parent, and what the post drew (counts, the reaction pills, its tags) as its own
  quiet lines. `kai-content--roomy` adds the 12px of breathing room below the header that the
  picture would otherwise lose to it. Under the body the post's **chain** comes first — the posts
  it carries on into, flat rows under their own separator — and the replies after them: a chain
  member is the post continued, not an answer to it, so it reads above the conversation, the order
  the Solian client threads it in. A chain member opened on its own detail names what it continues
  through the same quote block a reply uses (`post_chained_to`) — the reference the row form of it
  never repeats, because the head is the post above it. The replies page and the feed page turn the
  same way: the one-row `KaiPager` leads the rows rather than trailing them, and it is absent when
  there is only one page. A reply whose
  parent is already on the screen — the post itself, one of its chain members, another reply on
  the page — leaves its `Replied to …` quote out: the parent is right there, and the quote would
  say it twice.
- **Lightbox** (`lightbox`) — the viewer a post's attachments open into: no title
  bar, no key hint, no strip. The media is the screen — pictures at fit with zoom, pan and
  rotation, videos and voice notes played by the centre key — and the set's counter rides over the
  media in the bottom corner rather than taking a row under it. A lone attachment is not a set, so
  it carries no counter at all.
- **Voice input** — two tools, one microphone. The **microphone** records a take in the page
  (`getUserMedia` + `MediaRecorder`, `src/kaios/recorder.ts`): the composer shows it running with
  its length, and Send while recording means "finish this and send it". **Dictation** is the
  platform's speech service (`src/kaios/dictation.ts`): a settled phrase is appended to the draft
  and the phrase in flight is drawn as a line, never typed — so a phrase the recogniser is still
  guessing cannot end up in the draft, and text typed during the session survives. Both are
  optional and both are hidden where the device lacks the API; between them they are why the
  media toolbar is the one row whose width varies by handset.
- **Components** — `KaiHeader`, `KaiSoftkey`, `KaiList`, `KaiListItem`, `KaiPager`, `KaiSpinner`,
  `KaiChatBubble`; `KaiPostRow` (plus `KaiPostQuote` and `KaiAttachmentList` for what it embeds);
  `KaiInput` and `KaiTextArea` are the write paths — the search bar and the compose body, and the
  chat composer. Add the rest (Tab, Dialog, Option Menu, …) when a screen needs them.
- **Chat** — the room list is a flat row per room (avatar, title, unread count and the last
  message's content as one line), most-active first, with no pager: the list renders whole. A
  direct room with no name is titled by its other members (`QRB`), the rule the Flutter client's
  room tile uses. The thread is the app's one *two-sided* layout: others' bubbles sit left on the
  surface colour with the sender's name above, your own sit right on the accent colour with no
  name, and each carries its relative time (and a `sending`/failure marker). It is a window of at
  most five hundred messages, filled fifty at a time from the Load more row above the oldest one,
  so a long room costs a bounded heap while the rest of its history stays in the cache. Writing
  is its own screen (`chat-compose`), opened with the thread's left key, because a 240x320
  display cannot hold a thread and a keyboard at once: the field, the media toolbar and the
  attachment rows live there, and Send is its right softkey, live only while the composer has
  something to send, like the compose body's Post key.
- **Post rows** carry what the wire already gives: author and handle, time, `edited`, kind
  (`Article`/`Blog`, moments unlabelled), non-public visibility, a `truncated` marker, the title,
  a three-line excerpt, the quoted parent of a reply or forward, attachment lines, reply/boost/
  chain/reaction counts and tags. The excerpt is clipped by *visual width* — a CJK glyph costs two
  units (`src/content/markdown.js`) — because a character budget that fills five lines of Latin
  fills ten of CJK, and `-webkit-line-clamp` needs `display: -webkit-box`, which Gecko 48 lacks.
  A chain member is never a row of its own — a list drops it, because a continuation read without
  its head is a sentence with the beginning cut off — so a head's row is where the chain is
  announced (`{{n}} chained`), and the continuation is read on the head's own screen.
- **Pictures** are shown, not described. A picture attachment renders as an `<img>` on
  `https://api.solian.app/drive/files/{id}` — the same URL FloatLand and the Flutter client use —
  with the `width`/`height` from the wire as its box, so a row does not resize as bytes land
  (Gecko 48 has no `loading="lazy"`, so the intrinsic size is the only box available; when the
  server sends a `blurhash` — about one image in ten — it is decoded locally to a 32×32 wash and
  painted behind the loading image as a `data:` URL, inside the CSP, with the plain tinted box as
  the fallback). The
  server answers `307` to a signed object-storage URL and serves a compressed WebP: 24kB–350kB
  across five sampled posts. A row shows its one picture at its own aspect
  ratio — the box follows the wire's `width`/`height` — capped at a screen
  width tall (`max-height`, with `object-fit: cover`, Firefox 32+), snapped to
  the screen edges and captionless: the picture is the post. The detail
  screen shows each picture whole and captionless too; documents and
  videos keep their line, and an image
  that fails to load falls back to the metadata caption, `[image]` included.
  - Inline `![alt](solian://files/{id})` images in a body are rendered too — markdown-it drops any
    `src` outside its scheme allowlist, so that one scheme is admitted in `src/content/markdown.js`
    and nothing else is: an image pointing anywhere else on the internet renders as nothing in
    the body (pure content) and is never fetched.
  - The privileged app CSP already starts at `default-src * data: blob:`
    (`security.apps.privileged.CSP.default`), so remote images need no manifest `csp` entry —
    and a `csp` value can only ever be *stricter* than that default.
  - Video is not played and its poster is not shown: the platform generated a thumbnail for one
    attachment in ninety, so a video stays a `[video] … · … MB` line.
- **Attachments without a picture** — documents, audio, video — stay metadata lines: `[file]
  notes.pdf · 1.5 KB`. Nothing is fetched for them, and `?thumbnail=true` 404s where the platform
  has no thumbnail.
- **Safe area** — KaiOS shows a 26px status bar, and `manifest.webapp` neither requests
  `fullscreen` nor forces `chrome.statusbar: "overlap"`, so the platform sizes the app's window
  *below* the bar: the header needs no inset and is the 36px of the chrome spec. The one case the
  app reserves space for is a handset whose viewport covers the whole panel, where the bar is drawn
  *over* the header: `src/kaios/screen.ts` sets `--kai-safe-top` and the header carries it as top
  padding, so its background runs under the bar and the title clears it. That measurement is also
  re-taken on every resize — the window a handset is given can settle after the first paint, and a
  stale inset is a band of empty accent above the title, which is what makes the bar read as twice
  its height. Off-device (`screen` is a monitor) the inset is 0, so the dev server, the simulator
  and the gates lay the header out exactly as the handset does.
- **Navigation** — the guide's list rules: `Down` at the last item wraps to the first, `Up` at
  the first wraps to the last. An element registered with `scrollFirst` instead takes the arrow
  keys until the view has been scrolled to its end — the post body, which is otherwise taller
  than the screen and unreachable. The feed's page-flip controls sit above the posts in one
  edge-to-edge row — an icon cell for previous, the total page count, an icon cell for next,
  both always present (the inert one at a boundary is dimmed, not a focus target, and the
  icon-only cells carry their localised labels as `aria-label`) — under a searchbar that pushes
  the Search screen; both are reachable with `Up` from the first post or by wrapping past the
  last. The detail's reply list uses the same row in the same place, above the replies, so a post
  and its conversation are paged the one way whichever screen they are read on. Primary content
  registers as `initial`, so the highlight starts on the first post (or the
  search field on the Search screen) rather than on the controls. Selection is tracked in
  `src/kaios/nav.ts` by uid so Vue stays authoritative over the DOM;
  `[nav-selectable]` / `[nav-selected="true"]` attributes are kept for CSS and tooling
  compatibility.
- **Keys** — `SoftLeft` / `SoftRight` / `Enter`, D-pad arrows, `Backspace` as Back. Per the
  guide, Back inside a text field clears a character and the D-pad moves the caret, so the
  handler stays out of the way — but only for a press the caret can use: at the edge of the text
  the highlight takes the D-pad press and the field gives up focus, so a field is never a dead
  end. `Enter` inserts a newline in the multi-line compose body (the draft is markdown) and stays
  the app's action in a one-line field, where it commits the search. At the top level Back is not
  consumed and the platform leaves the app. Entering a text field opens the platform's own
  softkey bar.
- **Localisation** — `public/data/*.properties` served through the platform's `l10n.js`, read
  with `t()` from `src/kaios/l10n.ts`. `t()` registers a reactive dependency, so strings that
  arrive after first paint still render.

## Privileged network access

`manifest.webapp` requests `systemXHR`, which is what lets a privileged app reach servers that
send no CORS headers. That privilege only applies to `XMLHttpRequest` created with
`mozSystem: true`; `fetch()` has no equivalent. Every remote call therefore goes through
`request()` in `src/kaios/xhr.ts`, which hands back the status, the response headers (the post
list reports its row count in `x-total`) and the parsed body, and takes a method and a JSON body
for the write paths (posts, reactions, chat messages).

`src/api/solian.js` is the only module that knows an API URL. Every call goes out with an
`Authorization: Bearer` header when a session exists (refreshed lazily by `src/kaios/session.ts`
when the token nears expiry) and anonymously otherwise; the server limits anonymous responses to
published, non-draft, public posts. Search is the post list with a `query` term — the server's
semantic engine answers it, which is why a search can take a few seconds — and people search
(`/stargate/accounts/search`) exists on the server for when a People scope is added. The calendar
reads are the passport routes: `GET /passport/accounts/{name}/calendar/countdown` for the
dashboard's next-event tile, and `GET /passport/accounts/{name}/calendar?year=&month=` for the
month screen — the `/accounts/me` variant when signed in, falling back to a
named account (`solsynth`, one constant at the top of the module) whose public events mix with
the network's own notable days. The month answer carries one row per day that has something on
it (the app draws the empty days itself), with the account's events in `user_events` and the
holidays in `notable_days` — the two lists the reference client's event hub renders. The edge
happens to send CORS headers as well, so the same code works in the desktop dev server — but the
privileged path is what matters on a handset.

Chat is the messager endpoints, all account-scoped (`401` anonymous): `GET /messager/chat` for
the room list — the SDK's `ChatApi` still points at `/messager/chat/rooms`, which **404s**; the
live route answers `{ rooms: [...] }`, the shape the iOS `ChatRoomsResponse` decodes, and the same
correction is in the handset clients — `GET /messager/chat/{id}` for a single room,
`GET /messager/chat/summary` for the unread map, `GET /messager/chat/{id}/messages`
(newest-first at offset 0 — the same direction as the feed, with the row count in `x-total`:
the thread reads offset 0 for its newest page and then walks `offset` by one page per Load more,
whereas the feed pages by flipping), and `POST /messager/chat/{id}/messages` to send. Sends carry a
`client_message_id` so the optimistic row reconciles with the server's echo, the way Solian's
`MessageSender` does it.

Opening a room subscribes it and claims it read over the gateway — `messages.subscribe` and
`messages.read` packets with a `chat_room_id`. There is deliberately no HTTP read call: the
SDK's `POST /messager/chat/rooms/{id}/read` 404s, and the only HTTP alternative
(`POST /messager/chat/read-all`) would clear rooms the user never opened — that one backs the
menu's explicit "mark all as read".

The room features behind the chat list's left key use the rest of the messager surface:
`GET /messager/chat?query=` for room search (the same route as the list), `GET
/messager/chat/invites` with `POST .../invites/{roomId}/accept|decline` for invitations,
`GET /messager/chat/direct/{accountId}` for the one-to-one room — get-or-create, so a `404`
falls through to `POST /messager/chat/direct {related_user_id}`, the flow the clients'
new-message action uses — `POST /messager/chat/read-all` for the bulk read, and `DELETE
/messager/chat/{roomId}/members/me` to leave. The account picker searches
`GET /stargate/accounts/search?query=` (public, so it answers anonymous callers).

Notifications are the metoer routes, account-scoped the same way: `GET /metoer/notifications`
(the page in `x-total`, each row carrying its `topic`, the server's own title/subtitle/`content`,
a `meta` bag with the actor's `pfp` and the `action_uri` to open, and `viewed_at` — null until the
account has seen it, which is what the row's unread dot reads), `POST
/metoer/notifications/{id}/read` for the single receipt, and `POST /metoer/notifications/all/read`
for the bulk one. No `?app=` filter is sent: this app has no tenant app id of its own, the
account's whole inbox is what the screen is for, and every topic renders (the row picks its glyph
by the topic, with a bell for anything this build does not know), so no row that arrives is one
the app cannot draw.

Realtime is `src/kaios/ws.ts`: one WebSocket to `wss://<host>/ws?namespace=dev.solsynth.solian`
with the bearer token as `tk`, a `ping` every minute, capped exponential-backoff reconnects, and
`messages.subscribe`/`messages.unsubscribe` per open room (the gateway pushes `messages.new` for
the account's other rooms regardless, which is what keeps the room list's badges live). The chat
store merges a live message into the open thread, or bumps that room's unread count and preview.
A host without `WebSocket` simply never connects and the screens update on the next visit —
the refresh-on-visit behaviour the rest of the app already has.

Sign-in is the OAuth 2.0 **device flow** against Stargate (mirroring SolianWatch, sharing its
public client id `solian-on-watch`): `POST /stargate/auth/open/device/code` for the code,
`POST /stargate/auth/open/token` to poll (`authorization_pending` keeps waiting, `slow_down`
lengthens the interval, `access_denied`/`expired_token` end it) and to refresh, the profile from
`GET /stargate/accounts/me`, and `DELETE /stargate/sessions/current` to revoke on sign-out. The
signing-in screen renders the verification page (user code prefilled) as a QR code, generated
on-device by the bundled `qrcode-generator` (the watch's vendored encoder does the same). The
token pair is kept in `localStorage` under `sokai.session` — the one durable store every KaiOS
2.5 app has — with reads and writes guarded so a host without storage simply runs anonymous.

## Chat storage

The chat screens cache in **IndexedDB**, written to the KaiOS storage guidelines
(`developer.kaiostech.com/docs/sfp-3.0/core-developer-topics/storage`), in `src/kaios/idb.ts` and
`src/stores/chat.ts`:

- **Removable by design.** The database is opened with the KaiOS options form
  (`indexedDB.open(name, { version, storageType: 'temporary' })`), which marks it as data the
  system may delete when the device runs low — before the user hits "storage full". The app
  treats a missing database as an empty cache: `onupgradeneeded` recreates the stores, every read
  degrades to a remote fetch, and a fresh launch after a wipe shows an error rather than a
  misleading "no chats yet". A host that rejects the options object (standard Gecko, the desktop
  dev server) falls back to the plain `open(name, version)`; a host with no `indexedDB` at all
  (jsdom, the smoke gate) runs on memory alone.
- **Writes are error-handled.** The platform blocks DB writes below a free-space threshold
  (~30MB), so every write is best-effort: a failure keeps the in-memory copy and sets a notice
  (`chat_storage_error`) instead of throwing. Reads keep working — the cache is an optimisation,
  never the source of truth.
- **Content is capped.** A room keeps at most 10,000 message rows and the oldest are pruned on
  save (the guideline's own example), so a long-lived room cannot grow without bound. The thread
  reads that history a page at a time — a cursor over the `byRoom` index, stepped `count` times —
  rather than materialising the room to answer for fifty rows of it.
- **Text only.** Media belongs in DeviceStorage, not IndexedDB, so nothing binary is ever stored
  here; attachments are read-only metadata on the message row.
- **The stored shape is the schema.** What is written is the app's own `ChatMessage` / `ChatRoom`
  / `ChatSummary` object, so a revision that adds or renames a field makes every stored row an
  older one's. `DB_VERSION` is therefore the shape's version, and a rise **drops** the previous
  generation rather than migrating it (a cache is disposable, and the screens refetch); what a
  rise cannot fix — a row from a newer build, a hand-written value — is caught at the read
  boundary, where `loadMessagePage` returns only rows that pass `isStoredMessage`. That check is
  the reason it exists: this cursor is the one path a `ChatMessage` takes to the screen without
  passing `normalizeChatMessage`, and a row missing a field the bubble dereferences is a crash in
  a render function, not a stale value.
- **Account-scoped.** Signing out drops the in-memory state and clears the database, so the next
  account cannot see the previous one's conversations.

Reads are cache-first, mirroring Solian's `MessageSyncService`: the stored page paints
immediately, then the remote page is merged over it by message id, and a failed fetch leaves the
cache on screen. A thread reads the cache page it is about to show — the newest page on open, and
then one page per Load more — so opening a long room costs one page of DOM and one cursor read,
not the room. Rooms, summaries and threads are all persisted; the composer's draft lives in
the store (memory only), so Back to the list and in again keeps what was being typed.

## Layout

```
index.html                 Vite entry (source only — not a runnable page)
src/
  main.ts                  entry: key handler, l10n, pinia, mount
  App.vue                  the view map + softkey bar
  api/                     Solar Network client, wire → model normalisers
  content/markdown.ts      post bodies: markdown in the detail, plain text in a row
  kaios/                   keys, nav/softkeys, screen stack, l10n bridge, systemXHR,
                           status bar, dev-browser hash sync, IndexedDB cache, chat
                           WebSocket, in-page voice recorder and speech dictation
  stores/account.ts        session state, identity, sign-in UI
  stores/chat.ts           rooms, summaries, threads, cache-first loads, sends, unread
  stores/compose.ts        the post draft, shared across the compose screens
  stores/feed.ts           the Explore timeline
  stores/notifications.ts  the inbox: loaded page, read receipts, account-scoped reset
  components/              KaiOS UI components
  views/                   Dashboard, Calendar, Explore, Post, Notifications, Chat (list,
                           room, compose, new message, invites, search, stickers), About
  styles/kaios.css         design tokens + primitives
public/                    copied verbatim into dist/: manifest.webapp, l10n data,
                           l10n.js, manifest icons
scripts/                   target, Babel config, Vite plugins, both gates, packager
dist/                      the only installable app package (build output)
```

Source is TypeScript throughout (checked by `vue-tsc` as the first step of `npm run
verify`), and `~/` aliases the repository root — `~/src/kaios/nav.ts` — in both Vite
and vue-tsc. The Babel chain gained `@babel/preset-typescript` so `.ts` modules still
get core-js polyfill injection on the way to Gecko 48 (see `scripts/babel-legacy.js`).

## Trade-offs worth knowing

- **Vite is pinned to 7.** Vite 8 (rolldown) inlines its CommonJS runtime *after* the modules
  that call it when forced to a single IIFE chunk, so the bundle throws at load. Vite 7's Rollup
  path has supported IIFE for years.
- **No source maps.** Three transpilers deep a map would be a chain of approximations, and the
  package has to exclude it anyway.
- **Bundle size** is ~565kB (~198kB gzip). Roughly half of it is core-js: its compat data is
  deliberately conservative and polyfills spec-conformance details for engines as new as Firefox
  69. The rest is Vue plus `markdown-it`, which renders post bodies — a hand-written renderer
  would be smaller, but escaping user content is exactly the bug class worth paying a library
  for. If the core-js share ever matters more than conformance, prune it with the polyfill
  plugin's `shouldInjectPolyfill`.
- **No vue-router.** KaiOS has no address bar and the Back key is the only history; the screen
  stack in `src/kaios/views.ts` is ~20 lines.
- **`type: "privileged"`** is required for `systemXHR`, and privileged packages must be signed
  for the store. `cursor: true` in the manifest is the alternative to this app's own D-pad
  handling and is not enabled — it conflicts with managing selection in `nav.ts`.
