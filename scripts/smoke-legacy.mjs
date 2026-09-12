#!/usr/bin/env node
/**
 * Runtime gate: loads the built page the way a browser loads it — external
 * scripts fetched and executed in document order — then drives it with KaiOS
 * hardware key events.
 *
 * Why this exists on top of `verify-legacy.mjs`: static analysis can prove the
 * bundle *parses*, but not that the app *runs*. The polyfills that make Gecko 48
 * work are injected at build time by usage detection, so the only honest check is
 * to take those APIs away and see whether the app still starts, navigates and
 * reads posts over a privileged request.
 *
 * What this gate cannot do: jsdom fetches external scripts asynchronously, so a
 * script that a browser would run *during* parsing effectively runs after it
 * here. Execution *timing* is therefore enforced statically, by the `<head>`
 * `defer` rule in `verify-legacy.mjs` — this harness only asserts what happens
 * once the app is running.
 *
 * The realm still provides jsdom's DOM, which is newer than Gecko 48's: this
 * covers JavaScript built-ins and app behaviour, not DOM API age.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

import { STATUS_BAR_PX, statusBarInset } from '../src/kaios/screen.ts';

const failures = [];
let steps = 0;

function check(label, condition, observed) {
  steps += 1;
  const status = condition ? 'ok  ' : 'FAIL';
  const detail = condition || observed === undefined ? '' : ` — observed: ${JSON.stringify(observed)}`;
  console.log(`  ${status} ${label}${detail}`);
  if (!condition) failures.push(label);
}

const navState = (nodes) => nodes.map((node) => node.getAttribute('nav-selected'));

/** Rendered text, with Vue's template whitespace collapsed. */
const tight = (value) => value.replace(/\s+/g, ' ').trim();

/* --- Canned API responses ------------------------------------------------ */

const HOUR_MS = 3600000;

const FEED_POST_ID = '01a09055-3a56-7bc1-b59b-c84e56100be9';
const SECOND_POST_ID = '01a09028-3836-7c15-8a22-93b7b7db11e0';
const REPLY_ID = '01a08ff3-1852-7114-883c-3f05ac1bcb96';
const FORWARD_ID = '01a089c1-e23b-7c68-9e8f-498a77d2ae08';
/** The signed-in account's own post, for the edit/delete scenarios. */
const OWNED_POST_ID = '01a0eeee-1234-5678-9abc-def012345678';

/** The wire shape observed from `https://api.solian.app`: snake_case, integer enums. */
function wirePost(overrides) {
  const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();

  return Object.assign(
    {
      id: FEED_POST_ID,
      title: null,
      description: null,
      slug: null,
      edited_at: null,
      drafted_at: null,
      published_at: hourAgo,
      visibility: 0,
      content: '',
      content_type: 0,
      type: 0,
      is_truncated: false,
      replies_count: 0,
      thread_replies_count: 0,
      boost_count: 0,
      reactions_count: {},
      upvotes: 0,
      downvotes: 0,
      views_total: 0,
      replied_post_id: null,
      replied_post: null,
      forwarded_post_id: null,
      forwarded_post: null,
      attachments: [],
      tags: [],
      publisher: { id: '5e446e1d-29fa-4aea-9c6d-c20306b83433', type: 0, name: 'iCat', nick: 'iCat', picture: { id: 'avatar-1' } },
      resource_identifier: 'post:' + FEED_POST_ID,
      meta: { embeds: [] },
      created_at: hourAgo,
    },
    overrides,
  );
}

const FEED = [
  wirePost({
    title: 'SN notes',
    type: 1,
    is_truncated: true,
    replies_count: 3,
    boost_count: 2,
    reactions_count: { pray: 1, laugh: 1 },
    reactions_made: { pray: true },
    content: '# SN notes\n\n- supports X\n- and Y\n\nSee [the docs](https://example.com/docs) for more.',
    attachments: [
      {
        id: '01M28ESTWBSXQSTMVVBYYFDXSK',
        name: 'image_picker_C094B4E1.jpg',
        mime_type: 'image/jpeg',
        size: 358482,
        width: 810,
        height: 1440,
        has_thumbnail: false,
        // The server sends a BlurHash on some pictures; the row has to paint
        // it as one wash over the reserved box (see the smoke check below).
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      },
      {
        id: '01M27VGQRP4WP819BZ0TXDN7HF',
        name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 2470997,
        width: 1800,
        height: 1168,
      },
    ],
    forwarded_post_id: FORWARD_ID,
    forwarded_post: {
      id: FORWARD_ID,
      content: 'source body text',
      publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
      attachments: [{ id: 'f1', name: 'a.png', mime_type: 'image/png', size: 1024, width: 100, height: 200 }],
    },
  }),
  wirePost({
    id: SECOND_POST_ID,
    content: '第二篇内容',
    // Drafts can have a null `published_at`; the row has to fall back to
    // `created_at` instead of rendering nothing (or throwing).
    published_at: null,
    publisher: { id: 'b', type: 0, name: 'solsynth', nick: 'Solsynth' },
    replied_post_id: REPLY_ID,
    replied_post: { id: REPLY_ID, publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' } },
  }),
];

const DETAIL = wirePost({
  content:
    '# Heading\n\n- a\n- b\n\n![shot](solian://files/01M28ESTWBSXQSTMVVBYYFDXSK)\n\n![pixel](https://example.com/track.png)',
  visibility: 2,
  replies_count: 1,
  edited_at: new Date(Date.now() - HOUR_MS / 2).toISOString(),
  tags: [{ name: 'sokai' }, { name: null }],
  attachments: [
    { id: 'v1', name: 'clip.mp4', mime_type: 'video/mp4', size: 2470997, width: 1800, height: 1168 },
    { id: 'p1', name: 'photo.jpg', mime_type: 'image/jpeg', size: 630784, width: 3024, height: 1898 },
    { id: 'd1', name: 'notes.pdf', mime_type: 'application/pdf', size: 1536 },
  ],
  forwarded_post_id: FORWARD_ID,
  forwarded_post: {
    id: FORWARD_ID,
    content: 'Quoted source body.',
    publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
  },
});

const REPLIES = [
  wirePost({
    id: REPLY_ID,
    content: 'reply body',
    publisher: { id: 'c', type: 0, name: 'QRBG3376', nick: 'QRBG3376' },
  }),
];

const CANNED = {
  countdown: {
    status: 200,
    headers: '',
    body: [
      {
        event_id: '01f00000-0000-0000-0000-000000000001',
        event_type: 1,
        title: 'Solstice',
        description: 'The network turns a year older.',
        location: 'the sun',
        start_time: new Date(Date.now() + 3 * 24 * HOUR_MS + 4 * HOUR_MS).toISOString(),
        end_time: new Date(Date.now() + 3 * 24 * HOUR_MS + 5 * HOUR_MS).toISOString(),
        is_all_day: false,
        days_remaining: 3,
        hours_remaining: 4,
        is_ongoing: false,
        meta: null,
        account_id: '00000000-0000-0000-0000-000000000001',
      },
    ],
  },
  list: { status: 200, headers: 'x-total: 42\r\n', body: FEED },
  detail: { status: 200, headers: '', body: DETAIL },
  /* The signed-in account's own post, for the edit/delete scenarios: a simple
     text post with one picture, under the personal publisher. */
  ownedDetail: {
    status: 200,
    headers: '',
    body: wirePost({
      id: OWNED_POST_ID,
      content: 'owned post body',
      publisher: { id: 'pub-1', type: 0, name: 'testuser', nick: 'Test User', picture: { id: 'avatar-1' } },
      attachments: [{ id: 'seed-1', name: 'seed.png', mime_type: 'image/png', size: 4096, width: 100, height: 100 }],
    }),
  },
  replies: { status: 200, headers: 'x-total: 21\r\n', body: REPLIES },
  /* Stargate device flow: one code request, one pending poll, then approval.
     `interval: 1` keeps the poll fast enough for the gate's real timers. */
  deviceCode: {
    status: 200,
    headers: '',
    body: {
      device_code: 'dev-1',
      user_code: 'CODE-1234',
      verification_uri: 'https://solar.app/device',
      verification_uri_complete: 'https://solar.app/device?user_code=CODE-1234',
      expires_in: 600,
      interval: 1,
    },
  },
  tokenPending: { status: 400, headers: '', body: { error: 'authorization_pending' } },
  tokenOk: {
    status: 200,
    headers: '',
    body: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 },
  },
  me: {
    status: 200,
    headers: '',
    /* Held briefly so the session-restore scenario can observe the cached
       identity before the refreshed profile replaces it. */
    delay: 300,
    body: {
      id: 'acc-1',
      // Wire convention: `name` is the unique handle (@name), `nick` the
      // pretty display name — the same split the feed rows use.
      name: 'testuser',
      nick: 'Test User',
      profile: { background: { id: 'banner-1' }, picture: { id: 'avatar-1' } },
    },
  },
  revoke: { status: 200, headers: '', body: {} },
  /* Compose: the account's own publishers, the photo upload, and a created post. */
  publishers: {
    status: 200,
    headers: '',
    body: [
      { id: 'pub-1', type: 0, name: 'testuser', nick: 'Test User', picture: { id: 'pub-avatar-1' } },
      { id: 'pub-2', type: 0, name: 'secondpub', nick: 'Second Pub', picture: { id: 'pub-avatar-2' } },
    ],
  },
  upload: {
    status: 200,
    headers: '',
    body: { file: { id: 'file-upload-1', name: 'picked-photo.jpg', mime_type: 'image/jpeg', size: 16 } },
  },
  created: {
    status: 200,
    headers: '',
    body: wirePost({
      content: 'Hello from the smoke test',
      publisher: { id: 'pub-2', type: 0, name: 'secondpub', nick: 'Second Pub' },
    }),
  },
  /** Milliseconds to hold the feed's next-page response, so the loading UI is observable. */
  delayFlip: 60,
};

/** Runs before any other script in the page (see the stub note above). */
const PREAMBLE = `<script>
(function () {
  /* Firefox 48 does not have these. */
  var proto = Array.prototype;
  delete proto.flat; delete proto.flatMap; delete proto.at;
  delete proto.findLast; delete proto.findLastIndex;

  delete Object.fromEntries;
  delete Object.getOwnPropertyDescriptors;
  delete Object.hasOwn;

  proto = String.prototype;
  delete proto.matchAll; delete proto.replaceAll;
  delete proto.trimStart; delete proto.trimEnd; delete proto.at;

  delete Promise.prototype.finally;
  delete Promise.allSettled;
  delete Promise.any;
  delete Promise.withResolvers;

  delete window.NodeList.prototype.forEach;
  delete window.NodeList.prototype[Symbol.iterator];

  delete window.queueMicrotask;
  delete window.structuredClone;
  delete window.AbortController;
  delete window.ResizeObserver;
  delete window.IntersectionObserver;
  delete window.globalThis;

  /* Gecko 48 only knows the boolean form of scrollIntoView: the options-object
     form (Firefox 50+) throws, and the app must never call it. A throw here
     fails the gate exactly where the handset would. */
  Element.prototype.scrollIntoView = function (arg) {
    if (arg !== undefined && typeof arg !== 'boolean') {
      throw new TypeError(
        "'block' member of ScrollIntoViewOptions 'nearest' is not a valid value for enumeration ScrollLogicalPosition."
      );
    }
  };

  /* Deterministic stand-in for public/js/libs/l10n.js: get() echoes the id —
     and the placeholder names it was handed — so assertions also prove strings
     flow through the l10n layer with the right argument names. once() is
     synchronous, which turns the real page's mount race into a hard failure. */
  window.navigator.mozL10n = {
    get: function (id, args) {
      if (!args) return id;
      return id + '(' + Object.keys(args).sort().join(',') + ')';
    },
    once: function (callback) { callback(); }
  };

  /* The platform media activities: the compose screen's toolbar launches them
     (camera capture, recorder record, gallery pick) and reads the chosen file
     back as a Blob. The answer mirrors the requested type, so the attachment
     rows land with the right kind. The result lands in a later turn of the
     event loop, like the real activity. */
  window.MozActivity = function (spec) {
    this.spec = spec;
    var self = this;
    setTimeout(function () {
      var types = (spec.data && spec.data.type) || [];
      var isVideo = types.indexOf('video/*') !== -1;
      var isAudio = types.indexOf('audio/*') !== -1;
      self.result = isVideo
        ? { blob: new Blob(['fake-video-bytes'], { type: 'video/mp4' }), name: 'clip.mp4' }
        : isAudio
          ? { blob: new Blob(['fake-audio-bytes'], { type: 'audio/mp4' }), name: 'recording.m4a' }
          : { blob: new Blob(['fake-photo-bytes'], { type: 'image/jpeg' }), name: 'picked-photo.jpg' };
      if (typeof self.onsuccess === 'function') self.onsuccess();
    }, 0);
  };

  /* Gecko 48 has object URLs for the attachment preview; jsdom does not. */
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = function () { return 'blob:smoke-photo'; };
    URL.revokeObjectURL = function () {};
  }

  /* Gecko 48 has a real canvas 2D context; jsdom has none, and the BlurHash
     wash (src/kaios/blur.ts) silently falls back to the plain box without it.
     This stand-in keeps the wash — and the CSS that has to stretch its single
     32×32 decode over the reserved box — observable to the gate. */
  window.HTMLCanvasElement.prototype.getContext = function () {
    return {
      createImageData: function (width, height) {
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData: function () {}
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,c21va2U=';
  };

  /* Stands in for XMLHttpRequest so the privileged path can be inspected, and
     answers from a canned route table so the read path can be driven end to
     end. Responses land in a later turn of the event loop, like the real ones. */
  var CANNED = ${JSON.stringify(CANNED)};

  window.__requests = [];
  var __tokenPolls = 0;
  /* This session's reaction toggles: a symbol reacted again is taken back
     (the endpoint answers 204 for a removal, 200 for an addition). */
  var __reactions = {};
  window.XMLHttpRequest = function (options) {
    this.options = options;
    this.responseType = '';
    this.timeout = 0;
    this.status = 0;
    this.requestHeaders = {};
    this.responseHeaders = '';
    this.requestBody = '';
  };
  window.XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.requestHeaders[name] = value;
  };
  window.XMLHttpRequest.prototype.getAllResponseHeaders = function () {
    return this.responseHeaders;
  };
  window.XMLHttpRequest.prototype.send = function (body) {
    this.requestBody = body;
    window.__requests.push(this);
    var xhr = this;
    setTimeout(function () { respond(xhr); }, 0);
  };
  window.XMLHttpRequest.prototype.respond = function (status, body, headers) {
    this.status = status;
    this.response = body;
    this.responseHeaders = headers || '';
    this.onload();
  };

  function respond(xhr) {
    var url = xhr.url;
    if (url.indexOf('/stargate/auth/open/device/code') !== -1) {
      xhr.respond(CANNED.deviceCode.status, CANNED.deviceCode.body, CANNED.deviceCode.headers);
      return;
    }
    if (url.indexOf('/stargate/auth/open/token') !== -1) {
      __tokenPolls += 1;
      var tokenStep = __tokenPolls === 1 ? CANNED.tokenPending : CANNED.tokenOk;
      xhr.respond(tokenStep.status, tokenStep.body, tokenStep.headers);
      return;
    }
    if (url.indexOf('/stargate/accounts/me') !== -1) {
      var meDelay = CANNED.me.delay || 0;
      if (meDelay > 0) {
        setTimeout(function () {
          xhr.respond(CANNED.me.status, CANNED.me.body, CANNED.me.headers);
        }, meDelay);
      } else {
        xhr.respond(CANNED.me.status, CANNED.me.body, CANNED.me.headers);
      }
      return;
    }
    if (url.indexOf('/stargate/sessions/current') !== -1) {
      xhr.respond(CANNED.revoke.status, CANNED.revoke.body, CANNED.revoke.headers);
      return;
    }
    if (url.indexOf('/sphere/publishers?mine=true') !== -1) {
      xhr.respond(CANNED.publishers.status, CANNED.publishers.body, CANNED.publishers.headers);
      return;
    }
    if (url.indexOf('/drive/files/upload/direct') !== -1) {
      xhr.respond(CANNED.upload.status, CANNED.upload.body, CANNED.upload.headers);
      return;
    }
    if (url.indexOf('/sphere/posts/${OWNED_POST_ID}') !== -1 && xhr.method === 'GET') {
      xhr.respond(CANNED.ownedDetail.status, CANNED.ownedDetail.body, CANNED.ownedDetail.headers);
      return;
    }
    if (url.indexOf('/sphere/posts') !== -1 && xhr.method === 'POST' && url.indexOf('/reactions') === -1) {
      xhr.respond(CANNED.created.status, CANNED.created.body, CANNED.created.headers);
      return;
    }
    if (url.indexOf('/reactions') !== -1 && xhr.method === 'POST') {
      var symbol = '';
      try { symbol = (JSON.parse(xhr.requestBody) || {}).symbol || ''; } catch (e) {}
      if (__reactions[symbol]) {
        delete __reactions[symbol];
        xhr.respond(204, '', '');
      } else {
        __reactions[symbol] = true;
        xhr.respond(200, CANNED.created.body, CANNED.created.headers);
      }
      return;
    }
    var canned = url.indexOf('/calendar/countdown') !== -1
      ? CANNED.countdown
      : url.indexOf('/replies') !== -1
        ? CANNED.replies
        : url.indexOf('?') !== -1
          ? CANNED.list
          : CANNED.detail;

    var delay = url.indexOf('offset=20') !== -1 && url.indexOf('/replies') === -1
      ? CANNED.delayFlip
      : 0;
    if (delay > 0) {
      setTimeout(function () {
        xhr.respond(canned.status, canned.body, canned.headers);
      }, delay);
    } else {
      xhr.respond(canned.status, canned.body, canned.headers);
    }
  }
})();
</script>`;

const DIST = path.resolve('dist');
const distUrl = pathToFileURL(DIST + path.sep).href;

// Vite emits relative asset URLs (`base: './'`), which is what a packaged app
// wants: on a device the app is served from its own origin root, so `./js/app.js`
// resolves exactly like `/js/app.js`, and off-device it also works from a file
// path. This rebase stays as a guard for any root-absolute URL that creeps back
// in; the tag order and attributes - the things under test - are untouched.
const html = readFileSync(path.join(DIST, 'index.html'), 'utf8')
  .replace(/(src|href)="\//g, `$1="${distUrl}`)
  .replace(/<script\b[^>]*\bsrc="[^"]*l10n\.js"[^>]*><\/script>/, PREAMBLE);

if (!html.includes('XMLHttpRequest = function (options)')) {
  console.error('Harness error: could not find the l10n script tag to replace with the stub.');
  process.exit(1);
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: `${distUrl}index.html`,
});

const { window } = dom;
const { document } = window;

if (document.readyState !== 'complete') {
  await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
}
await new Promise((resolve) => setTimeout(resolve, 50));

const requests = window.__requests;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const all = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));
const text = (selector) => {
  const node = document.querySelector(selector);
  return node ? node.textContent.trim() : '';
};
const texts = (selector) => all(selector).map((node) => node.textContent.trim());

/**
 * Turns the event loop until `predicate` holds.
 *
 * A load is several asynchronous hops deep — the canned response arrives in a
 * later turn, then the store updates, then Vue's scheduler renders in a
 * microtask — so a fixed number of turns would encode that chain here and break
 * the moment the app grows a hop.
 */
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true;
    await flush();
  }
  return false;
}

/**
 * Like `until`, but for work paced by real timers — the device-flow poll
 * sleeps whole seconds between exchanges, which `flush()` (a 0ms turn) cannot
 * advance. Walks the clock in small steps up to `budgetMs`.
 */
async function untilTimer(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Dispatches a hardware key and waits for Vue to patch the DOM. Vue batches
 * renders into a microtask, so asserting straight after `dispatchEvent` reads
 * the previous state.
 */
async function press(key) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  await flush();
  return event;
}

/* --- Dashboard ------------------------------------------------------------ */

check('the app opens on the dashboard', text('.kai-header__title') === 'app_title', text('.kai-header__title'));
check(
  'the dashboard lists the top-level screens',
  texts('.kai-list-item__primary').join('|') === 'nav_explore|nav_account|nav_about' &&
    texts('.kai-list-item__secondary').join('|') === 'nav_explore_desc|nav_account_desc|nav_about_desc',
  { primary: texts('.kai-list-item__primary'), secondary: texts('.kai-list-item__secondary') },
);
check(
  'the dashboard clock shows a time and a date, without seconds',
  /^\d{2}:\d{2}$/.test(text('.kai-hero__time')) && /^\d{4}-\d{2}-\d{2}$/.test(text('.kai-hero__date')),
  { time: text('.kai-hero__time'), date: text('.kai-hero__date') },
);
check(
  'the dashboard shows the brand mark on the background',
  (() => {
    const mark = document.querySelector('.kai-hero__mark');
    // Vite resolves a public asset reference against the script's own URL, so the
    // attribute is absolute in the package; what matters is which file it names.
    const src = mark ? mark.getAttribute('src') || '' : '';
    return src.slice(-'img/icons/icon-mark-dark.png'.length) === 'img/icons/icon-mark-dark.png';
  })(),
  (document.querySelector('.kai-hero__mark') || {}).getAttribute
    ? document.querySelector('.kai-hero__mark').getAttribute('src')
    : null,
);
check(
  'the dashboard entries are rows, not cards',
  Boolean(document.querySelector('.kai-list--flat')) && all('.kai-list-item').length === 3,
  { flat: Boolean(document.querySelector('.kai-list--flat')), entries: all('.kai-list-item').length },
);
await until(() => Boolean(document.querySelector('.kai-hero__countdown')));
check(
  'the dashboard asks the network for the countdown and nothing else',
  requests.length === 1,
  requests.map((request) => request.url),
);
check(
  'the dashboard counts down to the next event',
  text('.kai-hero__countdown') === 'Solstice · countdown_days(d,h)',
  text('.kai-hero__countdown'),
);

await press('Enter');

/* --- Explore -------------------------------------------------------------- */

await until(() => document.querySelectorAll('li.kai-post').length > 0);

const rows = all('li.kai-post');
check('app mounts', all('#app').length === 1 && rows.length === 2, `explore rows: ${rows.length}`);
check('header renders a localised title', text('.kai-header__title') === 'nav_explore', text('.kai-header__title'));
check('first row starts selected', rows[0] && rows[0].getAttribute('nav-selected') === 'true', navState(rows));

check(
  'the page controls sit above the feed',
  (() => {
    const pager = document.querySelector('.kai-pager');
    const list = document.querySelector('.kai-content > ul.kai-list--flat');
    return Boolean(pager) && pager.nextElementSibling === list;
  })(),
  (() => {
    const pager = document.querySelector('.kai-pager');
    const list = document.querySelector('.kai-content > ul.kai-list--flat');
    return {
      pager: Boolean(pager),
      nextSibling: pager ? pager.nextElementSibling && pager.nextElementSibling.className : null,
      isPostList: pager ? pager.nextElementSibling === list : null,
    };
  })(),
);
check(
  'the highlight starts on the first post, not the page controls',
  rows[0].getAttribute('nav-selected') === 'true' && !document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]'),
  { rows: navState(rows), pager: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);
check(
  'feed rows lead with the publisher avatar',
  (() => {
    const img = document.querySelector('li.kai-post .kai-post__author .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('li.kai-post .kai-post__author .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);

check(
  'the post list is a flat list',
  document.querySelectorAll('.kai-content > ul.kai-list--flat > li.kai-post').length === 2,
  all('ul').map((list) => list.className),
);
const listRequest = requests.filter(
  (request) =>
    request.url ===
    'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true',
)[0];
check('the post list is fetched on mount', Boolean(listRequest));
if (listRequest) {
  check('request uses the systemXHR privilege', listRequest.options && listRequest.options.mozSystem === true);
  check('request is an anonymous GET', listRequest.method === 'GET' && !('Authorization' in listRequest.requestHeaders), {
    method: listRequest.method,
    headers: Object.keys(listRequest.requestHeaders),
  });
  check('request asks for JSON', listRequest.requestHeaders.Accept === 'application/json', listRequest.requestHeaders);
  check(
    'request URL is the offset-paginated public post list',
    listRequest.url === 'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true',
    listRequest.url,
  );
}
check('opening Explore adds exactly the list request', requests.length === 2, requests.length);

check(
  'rows show the display name and the unique @handle',
  // `name` is the unique handle (`@name`); `nick` is the pretty display name,
  // which is why the fixture keeps them different for the second row.
  texts('.kai-post__author').map(tight).join('|') === 'iCat @iCat|Solsynth @solsynth',
  texts('.kai-post__author').map(tight),
);
check(
  'rows show a relative timestamp through the l10n layer',
  text('.kai-post__time') === 'post_hours_ago(h)',
  text('.kai-post__time'),
);
check(
  'a reply row names the post it answered',
  texts('.kai-post__quote-label')[1] === 'post_replied_to(name)',
  texts('.kai-post__quote-label'),
);
check(
  'a null publication date falls back to the creation time',
  texts('.kai-post__time')[1] === 'post_hours_ago(h)',
  texts('.kai-post__time'),
);
check(
  'rows carry text, not markup',
  all('.kai-md').length === 0 && text('.kai-post__excerpt') === 'SN notes - supports X - and Y See the docs for more.',
  { markdownBlocks: all('.kai-md').length, excerpt: text('.kai-post__excerpt') },
);
check(
  'a row labels the post kind, title and truncation',
  text('.kai-post__title') === 'SN notes' &&
    tight(text('.kai-post__meta')).indexOf('post_kind_article') !== -1 &&
    tight(text('.kai-post__meta')).indexOf('post_truncated') !== -1,
  { title: text('.kai-post__title'), meta: tight(text('.kai-post__meta')) },
);
check(
  'a forwarded row quotes its source and counts its attachments',
  text('.kai-post__quote-label') === 'post_forwarded_from(name)' &&
    text('.kai-post__quote-text') === 'source body text' &&
    text('.kai-post__quote-attach').trim() === 'post_count_attachments(n)',
  {
    label: text('.kai-post__quote-label'),
    quote: text('.kai-post__quote-text'),
    attachments: text('.kai-post__quote-attach').trim(),
  },
);
check(
  'rows show the picture and count the rest; a picture carries no caption line',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    const lines = texts('.kai-post__attach').map(tight);
    // The shown picture has no metadata line under it; only the count of the
    // attachments it leaves out remains. (The line returns for a picture that
    // fails to load — the fallback the row needs to keep.)
    return Boolean(image) && lines.length === 1 && lines[0] === 'post_more_attachments(n)';
  })(),
  texts('.kai-post__attach').map(tight),
);
check(
  'a row shows the picture and reserves its box',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return (
      Boolean(image) &&
      image.getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK?preset=thumb' &&
      image.getAttribute('width') === '810' &&
      image.getAttribute('height') === '1440'
    );
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return image
      ? { src: image.getAttribute('src'), w: image.getAttribute('width'), h: image.getAttribute('height') }
      : null;
  })(),
);
check(
  'a row picture is edge-to-edge with square corners',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return Boolean(image) && window.getComputedStyle(image).borderRadius === '0px';
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return image ? window.getComputedStyle(image).borderRadius : null;
  })(),
);
check(
  'the BlurHash wash stretches over the reserved box instead of tiling',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    if (!image) return false;
    const style = window.getComputedStyle(image);
    // The decode is a 32×32 PNG: without `cover`/`no-repeat` the browser would
    // paint it as a grid of itself, which is the bug the gate locks out.
    return (
      image.style.backgroundImage.indexOf('data:image/png') !== -1 &&
      style.backgroundSize === 'cover' &&
      style.backgroundRepeat === 'no-repeat'
    );
  })(),
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    if (!image) return null;
    const style = window.getComputedStyle(image);
    return {
      backgroundImage: image.style.backgroundImage,
      backgroundSize: style.backgroundSize,
      backgroundRepeat: style.backgroundRepeat,
    };
  })(),
);
check(
  'rows show the reply and boost counts, and reactions as sticker pills',
  // The known reactions render as pills (sticker + count) instead of the
  // kinds-count text; only reactions without a bundled sticker keep the text.
  text('.kai-post__counts').replace(/\s+/g, '') === 'post_count_replies(n)post_count_boosts(n)' &&
    (() => {
      const pills = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction'));
      const sources = pills.map((pill) => pill.querySelector('.kai-reaction__img').getAttribute('src'));
      const counts = pills.map((pill) => pill.querySelector('.kai-reaction__count').textContent);
      return (
        pills.length === 2 &&
        sources.indexOf('/img/reactions/pray.png') !== -1 &&
        sources.indexOf('/img/reactions/laugh.png') !== -1 &&
        counts.every((count) => count === '1')
      );
    })(),
  {
    counts: text('.kai-post__counts'),
    pills: Array.prototype.slice.call(document.querySelectorAll('.kai-reaction')).map((pill) => ({
      src: pill.querySelector('.kai-reaction__img').getAttribute('src'),
      count: pill.querySelector('.kai-reaction__count').textContent,
    })),
  },
);
check(
  'the status bar space is reserved unless the platform reserved it already',
  statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 320 }) ===
    STATUS_BAR_PX &&
    // Handset that reserved the space: reserving it again would double the gap.
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 294 }) === 0 &&
    // Dev server and simulator: `screen` is a monitor, so nothing was reserved.
    statusBarInset({ screenWidth: 800, screenHeight: 600, innerWidth: 240, innerHeight: 320 }) ===
      STATUS_BAR_PX &&
    statusBarInset({ screenWidth: 1024, screenHeight: 768, innerWidth: 1024, innerHeight: 768 }) ===
      STATUS_BAR_PX,
  [
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 320 }),
    statusBarInset({ screenWidth: 240, screenHeight: 320, innerWidth: 240, innerHeight: 294 }),
    statusBarInset({ screenWidth: 800, screenHeight: 600, innerWidth: 240, innerHeight: 320 }),
    statusBarInset({ screenWidth: 1024, screenHeight: 768, innerWidth: 1024, innerHeight: 768 }),
  ],
);
check(
  'the title bar reserves the status bar space',
  document.documentElement.style.getPropertyValue('--kai-safe-top') === '26px',
  document.documentElement.style.getPropertyValue('--kai-safe-top'),
);

/* --- D-pad -------------------------------------------------------------- */

await press('ArrowDown');
check(
  'DOWN moves the highlight',
  rows[0].getAttribute('nav-selected') === 'false' && rows[1].getAttribute('nav-selected') === 'true',
  navState(rows),
);

await press('ArrowDown');
check(
  'DOWN from the last post wraps to the searchbar at the top',
  text('.kai-searchbar[nav-selected="true"]') === 'search_hint',
  text('.kai-searchbar[nav-selected="true"]'),
);

await press('ArrowDown');
check(
  'DOWN reaches the pager row',
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')),
  { pagerSelected: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);

await press('ArrowDown');
check(
  'the list loop returns to the first post',
  rows[0].getAttribute('nav-selected') === 'true',
  navState(rows),
);

await press('ArrowUp');
check(
  'UP above the first post reaches the page controls',
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')),
  { pagerSelected: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);

/* --- Page flip ---------------------------------------------------------- */

check(
  'the first page offers a next icon and names the page',
  (() => {
    const next = document.querySelector('.kai-pager .kai-list-item');
    return (
      Boolean(next) &&
      Boolean(next.querySelector('svg')) &&
      next.getAttribute('aria-label') === 'action_next_page' &&
      tight(text('.kai-pager__status')) === 'post_page(page,pages)'
    );
  })(),
  {
    icon: Boolean(document.querySelector('.kai-pager .kai-list-item svg')),
    aria: document.querySelector('.kai-pager .kai-list-item')
      ? document.querySelector('.kai-pager .kai-list-item').getAttribute('aria-label')
      : null,
    status: tight(text('.kai-pager__status')),
  },
);
check(
  'both page cells are always present; the inert one is dim',
  (() => {
    const cells = document.querySelectorAll('.kai-pager__cell');
    const dim = document.querySelector('.kai-pager__cell--dim');
    const active = document.querySelectorAll('.kai-pager .kai-list-item');
    return (
      cells.length === 2 &&
      Boolean(dim) &&
      dim.getAttribute('aria-hidden') === 'true' &&
      dim.getAttribute('nav-selectable') === null &&
      active.length === 1 &&
      Boolean(active[0].querySelector('svg'))
    );
  })(),
  Array.prototype.map.call(document.querySelectorAll('.kai-pager__cell'), (node) => ({
    text: node.textContent.trim(),
    cls: node.className,
    selectable: node.getAttribute('nav-selectable'),
  })),
);
check(
  'the searchbar sits above the page controls',
  (() => {
    const bar = all('.kai-searchbar')[0];
    const pager = document.querySelector('.kai-pager');
    return (
      all('.kai-searchbar').length === 1 &&
      Boolean(bar) &&
      bar.textContent.trim() === 'search_hint' &&
      bar.nextElementSibling === pager
    );
  })(),
  {
    bars: all('.kai-searchbar').map((el) => el.textContent.trim()),
    nextOfSearch: all('.kai-searchbar')[0]
      ? all('.kai-searchbar')[0].nextElementSibling &&
        all('.kai-searchbar')[0].nextElementSibling.className
      : null,
  },
);
check(
  'the pager is one row: dim prev, count, next',
  (() => {
    const pager = document.querySelector('.kai-pager');
    const nav = document.querySelector('.kai-pager__nav');
    const status = document.querySelector('.kai-pager__status');
    const cells = document.querySelectorAll('.kai-pager__cell');
    if (!pager || !nav || !status || cells.length !== 2) return false;
    const statusStyle = window.getComputedStyle(status);
    const navStyle = window.getComputedStyle(nav);
    return (
      nav.parentElement === pager &&
      status.parentElement === nav &&
      status.previousElementSibling === cells[0] &&
      status.nextElementSibling === cells[1] &&
      navStyle.display === 'flex' &&
      statusStyle.borderTopWidth === '0px' &&
      statusStyle.textAlign === 'center'
    );
  })(),
  (() => {
    const nav = document.querySelector('.kai-pager__nav');
    const status = document.querySelector('.kai-pager__status');
    return {
      navDisplay: nav ? window.getComputedStyle(nav).display : null,
      statusBorder: status ? window.getComputedStyle(status).borderTopWidth : null,
    };
  })(),
);

// The highlight is on the pager row above the feed, so Enter flips the page.
// The stub holds the response for a moment so the loading UI is observable.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-spinner')));
const ring = window.getComputedStyle(document.querySelector('.kai-spinner__ring'));
check(
  'the feed spinner is a bare circular ring while the page flips',
  Boolean(document.querySelector('.kai-spinner')) &&
    !document.querySelector('.kai-spinner__label') &&
    ring.borderRadius === '50%' &&
    ring.width === '32px' &&
    ring.height === '32px',
  {
    label: document.querySelector('.kai-spinner__label')
      ? document.querySelector('.kai-spinner__label').textContent
      : null,
    ring: { width: ring.width, height: ring.height, radius: ring.borderRadius },
  },
);
await until(() => requests.length === 3 && all('li.kai-post').length === 2);

const flippedRows = all('li.kai-post');
check(
  'flipping the page fetches the next offset and replaces the list',
  requests.length === 3 &&
    requests[2].url ===
      'https://api.solian.app/sphere/posts?take=20&offset=20&replies=false&orderDesc=true' &&
    flippedRows.length === 2,
  { urls: requests.map((request) => request.url), rows: flippedRows.length },
);
check(
  'the second page offers both directions',
  (() => {
    const cells = all('.kai-pager .kai-list-item');
    return (
      cells.length === 2 &&
      cells.every((cell) => Boolean(cell.querySelector('svg'))) &&
      cells[0].getAttribute('aria-label') === 'action_prev_page' &&
      cells[1].getAttribute('aria-label') === 'action_next_page'
    );
  })(),
  all('.kai-pager .kai-list-item').map((cell) => ({
    aria: cell.getAttribute('aria-label'),
    icon: Boolean(cell.querySelector('svg')),
  })),
);
check(
  'previous, count and next share one row, labelled for screen readers',
  (() => {
    const cells = document.querySelectorAll('.kai-pager__cell');
    const status = document.querySelector('.kai-pager__status');
    if (cells.length !== 2 || !status) return false;
    return (
      Boolean(cells[0].querySelector('svg')) &&
      Boolean(cells[1].querySelector('svg')) &&
      cells[0].getAttribute('aria-label') === 'action_prev_page' &&
      cells[1].getAttribute('aria-label') === 'action_next_page' &&
      status.previousElementSibling === cells[0] &&
      status.nextElementSibling === cells[1] &&
      window.getComputedStyle(cells[0]).borderTopWidth === '0px' &&
      window.getComputedStyle(cells[1]).borderTopWidth === '0px'
    );
  })(),
  Array.prototype.map.call(
    document.querySelectorAll('.kai-pager__cell'),
    (node) => ({
      icon: Boolean(node.querySelector('svg')),
      aria: node.getAttribute('aria-label'),
    }),
  ),
);
check(
  'focus starts at the top of the new page',
  flippedRows[0].getAttribute('nav-selected') === 'true',
  navState(flippedRows),
);
check(
  "the right softkey opens the row's options sheet",
  text('.kai-softkey__key--right') === 'action_options',
  text('.kai-softkey__key--right'),
);

check('softkey shows the centre action', text('.kai-softkey__key--center') === 'action_open', text('.kai-softkey__key--center'));
check(
  'the left softkey opens the composer',
  text('.kai-softkey__key--left') === 'nav_compose',
  { left: text('.kai-softkey__key--left') },
);

/* --- Post detail -------------------------------------------------------- */

await press('Enter');
await until(() => document.querySelector('.kai-md h1'));

check('ENTER opens the selected post', text('.kai-header__title') === 'post_title', text('.kai-header__title'));
check(
  'a sub-screen carries no back softkey either',
  text('.kai-softkey__key--left') === '',
  text('.kai-softkey__key--left'),
);

const postRequest = requests.filter(
  (request) => request.url === 'https://api.solian.app/sphere/posts/' + FEED_POST_ID,
)[0];
const repliesRequest = requests.filter(
  (request) =>
    request.url ===
    'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=0',
)[0];
check(
  'the post and its replies are requested together',
  Boolean(postRequest) &&
    Boolean(repliesRequest) &&
    postRequest.options &&
    postRequest.options.mozSystem === true,
  requests.map((request) => request.url),
);

const heading = document.querySelector('.kai-md h1');
check(
  'the body is rendered as markdown',
  Boolean(heading) && heading.textContent === 'Heading',
  document.querySelector('.kai-md') ? document.querySelector('.kai-md').textContent : null,
);
check('markdown list syntax is not leaked as text', all('.kai-md li').length === 2 && texts('.kai-md li').join('|') === 'a|b', texts('.kai-md li'));
check(
  'no raw markdown markers survive into the DOM',
  text('.kai-md').indexOf('#') === -1,
  text('.kai-md'),
);

const bodyCard = document.querySelector('.kai-content > div.kai-post');
// The post's first attachment arrives with the wire response, so its
// selectable registers a tick later; wait for the highlight to land on it.
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  'focus starts on the first attachment, not the body',
  Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')) &&
    bodyCard.getAttribute('nav-selected') === 'false',
  {
    extras: document.querySelector('.kai-post-extras') ? document.querySelector('.kai-post-extras').getAttribute('nav-selected') : null,
    body: bodyCard.getAttribute('nav-selected'),
  },
);
check(
  'the detail header leads with the author avatar',
  (() => {
    const img = document.querySelector('.kai-content > div.kai-post .kai-post__author .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('.kai-content > div.kai-post .kai-post__author .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);
check(
  'the detail body is a card with a shadow, snapped to the screen edges',
  (() => {
    if (!bodyCard) return false;
    const s = window.getComputedStyle(bodyCard);
    // The full-bleed pull-out (negative margin over the content gutter) is a
    // layout property jsdom cannot observe; the live check measures the box.
    return (
      s.boxShadow !== 'none' &&
      s.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      s.borderRadius === '0px'
    );
  })(),
  bodyCard
    ? {
        shadow: window.getComputedStyle(bodyCard).boxShadow,
        background: window.getComputedStyle(bodyCard).backgroundColor,
        radius: window.getComputedStyle(bodyCard).borderRadius,
      }
    : null,
);
check(
  'the body carries author, timestamp, visibility, counts and tags',
  text('.kai-content > div.kai-post').indexOf('iCat') !== -1 &&
    text('.kai-post__time') === 'post_hours_ago(h)' &&
    all('.kai-tag').length === 1 &&
    all('.kai-tag')[0].textContent.trim() === 'sokai',
  { tags: texts('.kai-tag'), time: text('.kai-post__time') },
);
check(
  'a non-public post is labelled and the edited marker shows',
  ['post_visibility_unlisted', 'post_edited', 'post_count_replies(n)'].every(
    (label) => text('.kai-content > div.kai-post').indexOf(label) !== -1,
  ),
  text('.kai-content > div.kai-post').slice(0, 200),
);
check(
  'the detail renders the quoted post as markdown',
  all('.kai-md--quote').length === 1 && tight(text('.kai-md--quote')) === 'Quoted source body.',
  tight(text('.kai-md--quote')),
);
check(
  'attachments sit above the body, not inside it',
  all('.kai-post-extras .kai-post__attach').length === 1 &&
    all('.kai-content > div.kai-post .kai-post__attach').length === 0 &&
    (document.querySelector('.kai-content').firstElementChild || {}).className === 'kai-post-extras',
  {
    extras: texts('.kai-post-extras .kai-post__attach').map(tight),
    insideBody: all('.kai-content > div.kai-post .kai-post__attach').length,
    firstChild: (document.querySelector('.kai-content').firstElementChild || {}).className,
  },
);
check(
  'a detail shows only the first attachment; the rest are counted',
  (() => {
    const images = all('.kai-post-extras .kai-attachment__image');
    return (
      images.length === 1 &&
      images[0].getAttribute('src') === 'https://api.solian.app/drive/files/v1?thumbnail=1' &&
      // The video's poster frame carries the play badge, so it reads playable.
      Boolean(document.querySelector('.kai-post-extras .kai-attachment__play svg')) &&
      texts('.kai-post-extras .kai-post__attach').map(tight).join(' | ') === 'post_more_attachments(n)'
    );
  })(),
  {
    images: all('.kai-post-extras img').map((image) => image.getAttribute('src')),
    badge: Boolean(document.querySelector('.kai-post-extras .kai-attachment__play svg')),
    lines: texts('.kai-post-extras .kai-post__attach').map(tight),
  },
);
check(
  'an inline file image is rendered, and a foreign one is not fetched',
  (() => {
    const photos = all('.kai-md__photo');
    const foreign = all('img').filter((image) => (image.getAttribute('src') || '').indexOf('example.com') !== -1);
    return (
      photos.length === 1 &&
      photos[0].getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK?preset=thumb' &&
      photos[0].getAttribute('alt') === 'shot' &&
      // A foreign image renders as nothing: the body stays pure content.
      !document.querySelector('.kai-md__image') &&
      foreign.length === 0
    );
  })(),
  {
    photos: all('.kai-md__photo').map((image) => image.getAttribute('src')),
    marker: text('.kai-md__image'),
    foreignImages: all('img').map((image) => image.getAttribute('src')),
  },
);

const replyRows = all('li.kai-post');
check(
  'replies render under their own separator, as flat rows',
  text('.kai-separator') === 'post_replies' &&
    replyRows.length === 1 &&
    replyRows[0].textContent.indexOf('reply body') !== -1 &&
    Boolean(document.querySelector('ul.kai-list--flat')),
  {
    separator: text('.kai-separator'),
    replies: replyRows.length,
    lists: all('ul').map((list) => list.className),
  },
);

// The highlight rests on the attachment strip: the first DOWN reaches the
// body, the second leaves it for the first reply. The body has nothing to
// scroll in jsdom (scrollHeight is 0), so the press moves on — the
// `scrollFirst` behaviour needs a real layout box.
await press('ArrowDown');
await press('ArrowDown');
check('DOWN leaves the body for the first reply', replyRows[0].getAttribute('nav-selected') === 'true', navState(replyRows));

await press('ArrowUp');
check('UP returns to the body', bodyCard.getAttribute('nav-selected') === 'true', bodyCard.getAttribute('nav-selected'));

await press('ArrowDown');
await press('ArrowDown');
check(
  'the reply pager row is reachable below the replies',
  Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')),
  { pagerSelected: Boolean(document.querySelector('.kai-pager .kai-list-item[nav-selected="true"]')) },
);

await press('Enter');
// The flip replaces the reply list, so wait for the rendered result, not just
// the request: the loading state and the canned response race the check.
await until(() => requests.length === 6 && all('li.kai-post').length === 1);

check(
  'flipping the reply page fetches the next offset and replaces the list',
  requests[requests.length - 1].url ===
    'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=20' &&
    all('li.kai-post').length === 1,
  { url: requests[requests.length - 1].url, replies: all('li.kai-post').length },
);
check(
  'after the flip the highlight returns to the top of the detail',
  document.querySelector('.kai-post-extras[nav-selected="true"]') !== null,
  document.querySelector('.kai-post-extras') ? document.querySelector('.kai-post-extras').getAttribute('nav-selected') : null,
);

/* --- Lightbox ------------------------------------------------------------- */

// The picture is the post: with the highlight resting on the strip, Enter
// opens the lightbox for the whole attachment set.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-lightbox')));
check(
  'ENTER on the first attachment opens the full-bleed lightbox',
  Boolean(document.querySelector('.kai-lightbox')) &&
    !document.querySelector('.kai-header') &&
    all('.kai-lightbox__stage').length === 1,
  {
    lightbox: Boolean(document.querySelector('.kai-lightbox')),
    header: Boolean(document.querySelector('.kai-header')),
    stages: all('.kai-lightbox__stage').length,
  },
);
check(
  'the lightbox opens on the video, paused, with its controls and hint',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'VIDEO' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/v1?original=1' &&
      media.getAttribute('poster') === 'https://api.solian.app/drive/files/v1?thumbnail=1' &&
      // Paused: the play badge shows, the progress bar waits at zero.
      Boolean(document.querySelector('.kai-lightbox__play')) &&
      Boolean(document.querySelector('.kai-lightbox__progress')) &&
      text('.kai-lightbox__counter') === 'lightbox_counter(current,total)' &&
      text('.kai-lightbox__hint') === 'lightbox_hint_video'
    );
  })(),
  {
    media: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').tagName : null,
    src: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
    poster: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('poster') : null,
    badge: Boolean(document.querySelector('.kai-lightbox__play')),
    counter: text('.kai-lightbox__counter'),
    hint: text('.kai-lightbox__hint'),
  },
);

// The centre key plays and pauses; the badge and the softkey label follow.
await press('Enter');
check(
  'the centre key plays the video; the badge clears',
  text('.kai-softkey__key--center') === 'lightbox_pause' && !document.querySelector('.kai-lightbox__play'),
  { center: text('.kai-softkey__key--center'), badge: Boolean(document.querySelector('.kai-lightbox__play')) },
);
await press('Enter');
check(
  'the centre key pauses the video; the badge returns',
  text('.kai-softkey__key--center') === 'lightbox_play' && Boolean(document.querySelector('.kai-lightbox__play')),
  { center: text('.kai-softkey__key--center'), badge: Boolean(document.querySelector('.kai-lightbox__play')) },
);

// RIGHT moves on to the picture.
await press('ArrowRight');
check(
  'RIGHT moves to the picture, with its key hint',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'IMG' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1' &&
      text('.kai-lightbox__hint') === 'lightbox_hint_image'
    );
  })(),
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return {
      media: media ? media.tagName + ' ' + media.getAttribute('src') : null,
      hint: text('.kai-lightbox__hint'),
    };
  })(),
);

// UP and DOWN zoom a picture in steps (the centre key is the video's play
// key); a zoomed picture keeps the D-pad for panning instead of switching.
// (jsdom never loads the bytes, so panning itself is untestable here — the
// zoom state and the key ownership are not.)
await press('ArrowUp');
check(
  'UP zooms the picture in; the centre key stays with the video',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.className.indexOf('kai-lightbox__media--zoomed') !== -1 &&
      text('.kai-softkey__key--center') === ''
    );
  })(),
  {
    className: document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').className : null,
    center: text('.kai-softkey__key--center'),
  },
);
await press('ArrowLeft');
check(
  'a zoomed picture does not switch on LEFT',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
// The phone pad pans inside the zoomed picture (2/4/6/8); it never switches,
// and it is inert once the picture is back at fit.
await press('4');
await press('8');
check(
  'the 2/4/6/8 pad pans the zoomed picture without switching',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
await press('ArrowDown');
check(
  'DOWN zooms the picture back out to fit',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.className.indexOf('kai-lightbox__media--zoomed') === -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').className : null,
);
await press('6');
check(
  'the pad is inert at fit; only LEFT/RIGHT switch',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.getAttribute('src') === 'https://api.solian.app/drive/files/p1?original=1';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').getAttribute('src') : null,
);
// 1 and 3 turn the picture a quarter-turn at a time — counterclockwise and
// clockwise — and the turn is observable even though the bytes never load.
await press('1');
check(
  '1 turns the picture counterclockwise',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform.indexOf('rotate(-90deg)') !== -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);
await press('3');
check(
  '3 turns it back upright',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform === '';
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);
await press('3');
check(
  '3 turns it on clockwise',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return Boolean(media) && media.style.transform.indexOf('rotate(90deg)') !== -1;
  })(),
  document.querySelector('.kai-lightbox__media') ? document.querySelector('.kai-lightbox__media').style.transform : null,
);

// RIGHT again reaches the document, which has only its line to be.
await press('ArrowRight');
check(
  'RIGHT reaches a document, which keeps its line',
  (() => {
    const line = document.querySelector('.kai-lightbox__line');
    return Boolean(line) && tight(line.textContent) === '[post_attach_file] notes.pdf · 1.5 KB';
  })(),
  text('.kai-lightbox__line'),
);

// LEFT wraps back through the set to the video.
await press('ArrowLeft');
await press('ArrowLeft');
check(
  'LEFT wraps back to the first attachment',
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return (
      Boolean(media) &&
      media.tagName === 'VIDEO' &&
      media.getAttribute('src') === 'https://api.solian.app/drive/files/v1?original=1'
    );
  })(),
  (() => {
    const media = document.querySelector('.kai-lightbox__media');
    return media ? media.tagName + ' ' + media.getAttribute('src') : null;
  })(),
);

// Back returns to the post, whose strip holds the highlight again.
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  'Back leaves the lightbox for the post',
  text('.kai-header__title') === 'post_title' && Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')),
  {
    title: text('.kai-header__title'),
    extras: document.querySelector('.kai-post-extras') ? document.querySelector('.kai-post-extras').getAttribute('nav-selected') : null,
  },
);

/* --- Reactions: the option menu and the sign-in gate -------------------- */

// The post's actions live in an option menu behind the right softkey, so the
// read path — body to replies — stays uninterrupted. The bar answers a tap
// like the key it stands for: this opens the menu with a pointer click, not a
// key press.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "the option menu lists the post's actions",
  texts('.kai-option-menu__item').join('|') === 'action_reply|action_forward|action_react|action_reload',
  texts('.kai-option-menu__item').join('|'),
);
check(
  'the option menu carries its own title and Select/Cancel bar',
  text('.kai-option-menu__header') === 'post_options' &&
    text('.kai-option-menu__key--left') === 'action_cancel' &&
    text('.kai-option-menu__key--center') === 'action_select' &&
    // The screen's own bar reads empty while the sheet is up.
    text('.kai-softkey__key--left') === '' &&
    text('.kai-softkey__key--center') === '',
  {
    header: text('.kai-option-menu__header'),
    left: text('.kai-option-menu__key--left'),
    center: text('.kai-option-menu__key--center'),
    screenLeft: text('.kai-softkey__key--left'),
    screenCenter: text('.kai-softkey__key--center'),
  },
);
// The sheet's own CANCEL answers a tap too.
document.querySelector('.kai-option-menu__key--left').click();
await until(() => !document.querySelector('.kai-option-menu'));
check(
  'the sheet CANCEL closes the option menu',
  text('.kai-header__title') === 'post_title' && !document.querySelector('.kai-option-menu'),
  { title: text('.kai-header__title'), menu: Boolean(document.querySelector('.kai-option-menu')) },
);
// Back closes it as well, without leaving the post.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('Backspace');
await until(() => !document.querySelector('.kai-option-menu'));
check(
  'Back closes the option menu without leaving the post',
  text('.kai-header__title') === 'post_title' && !document.querySelector('.kai-option-menu'),
  { title: text('.kai-header__title'), menu: Boolean(document.querySelector('.kai-option-menu')) },
);

// React runs from the menu; anonymous it leads to the sign-in gate, not a
// dead 401. The cursor starts on Reply: two DOWNs reach React.
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'action_react');
check(
  'React from the option menu opens the reaction picker',
  text('.kai-header__title') === 'action_react',
  text('.kai-header__title'),
);
check(
  'reacting while signed out shows the sign-in gate',
  text('.kai-content > .kai-text') === 'reactions_sign_in' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  {
    intro: text('.kai-content > .kai-text'),
    rows: texts('.kai-list-item__primary').join('|'),
  },
);
await press('Backspace');
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));

/* --- Back, then the other screen ---------------------------------------- */

await press('Backspace');
await until(() => all('li.kai-post').length === 2);
check(
  'the hardware Back key goes back to Explore',
  text('.kai-header__title') === 'nav_explore' && all('li.kai-post').length === 2,
  { title: text('.kai-header__title'), rows: all('li.kai-post').length },
);
// The timeline is preserved on a return: the page that was on screen (page 2,
// after the flip test) stays — the last list fetch is still its offset=20,
// not a fresh offset=0 reload.
const lastListRequest = requests
  .filter(
    (request) => request.url.indexOf('/sphere/posts?') !== -1 && request.url.indexOf('query=') === -1,
  )
  .slice(-1)[0];
check(
  'returning to the feed does not refetch the timeline',
  Boolean(lastListRequest) && lastListRequest.url.indexOf('offset=20') !== -1,
  lastListRequest ? lastListRequest.url : null,
);

// Explore is no longer the top level: its Back goes up to the dashboard, and the
// dashboard is where the platform takes Back.
await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === 3);
check(
  'Back returns to the dashboard',
  text('.kai-header__title') === 'app_title' && all('.kai-list-item').length === 3,
  { title: text('.kai-header__title'), entries: all('.kai-list-item').length },
);

await press('ArrowDown');
check(
  'DOWN reaches the second dashboard entry',
  all('.kai-list-item')[1].getAttribute('nav-selected') === 'true',
  navState(all('.kai-list-item')),
);

// The third row is About; the second is the new Account screen.
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_about');
const about = text('.kai-content');
check('About opens from the dashboard', text('.kai-header__title') === 'nav_about', text('.kai-header__title'));
// Guards the build-time `define` values: unreplaced, these render as nothing
// and the screen is silently blank.
check('About shows the compiled version', about.includes('0.2.0'), about);
check('About shows the compiled target', about.includes('KaiOS 2.5 (Gecko 48)'), about);

await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === 3);

/* --- Search ------------------------------------------------------------ */

// From the dashboard, the first entry is Explore: open it and walk up to the
// searchbar. The timeline is preserved on page 2 (the earlier flip test), so
// the pager carries both cells: three UPs from the first post reach the bar
// (next cell, previous cell, searchbar).
await press('Enter');
await until(() => all('li.kai-post').length === 2);
await press('ArrowUp');
await press('ArrowUp');
await press('ArrowUp');
await flush();
check(
  'UP three times from the first post reaches the searchbar',
  (() => {
    const bar = all('.kai-searchbar').find((el) => el.textContent.trim() === 'search_hint');
    return Boolean(bar && bar.getAttribute('nav-selected') === 'true');
  })(),
  all('.kai-searchbar').map((el) => el.textContent.trim()),
);

await press('Enter');
await until(() => text('.kai-header__title') === 'nav_search');
check(
  'the searchbar pushes the Search screen, whose field starts highlighted',
  text('.kai-header__title') === 'nav_search' &&
    document.querySelector('.kai-field__input[nav-selected="true"]') !== null,
  {
    header: text('.kai-header__title'),
    fieldSelected: Boolean(document.querySelector('.kai-field__input[nav-selected="true"]')),
  },
);

// Type a term and commit with Enter.
const field = document.querySelector('.kai-field__input');
field.value = 'sol';
field.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
check(
  'the one-line searchbar field draws its underline',
  window.getComputedStyle(field).borderBottomStyle === 'solid',
  window.getComputedStyle(field).borderBottomStyle,
);
// A one-line field has no caret line to give the D-pad, so the highlight takes
// the press — the field is not a trap; and Enter is the app's action here, not
// the platform's newline (see the compose body, where it is the reverse).
const searchEnter = await press('Enter');
check(
  'Enter in a one-line field is the app action, not the platform newline',
  searchEnter.defaultPrevented === true,
  searchEnter.defaultPrevented,
);
await until(() => all('li.kai-post').length === 2);
// The commit closed the platform's editor: the field keeps the highlight but no
// longer the keys, so the D-pad moves on to the results.
const searchDown = await press('ArrowDown');
check(
  'DOWN after a committed search moves off the field to the results',
  searchDown.defaultPrevented === true &&
    document.querySelector('.kai-field__input[nav-selected="true"]') === null,
  {
    prevented: searchDown.defaultPrevented,
    stillOnField: Boolean(document.querySelector('.kai-field__input[nav-selected="true"]')),
  },
);

const searchRequest = requests.filter((request) => request.url.indexOf('query=sol') !== -1)[0];
check(
  'the search hits the posts search endpoint',
  Boolean(searchRequest) &&
    searchRequest.url ===
      'https://api.solian.app/sphere/posts?take=20&offset=0&replies=false&orderDesc=true&query=sol',
  searchRequest ? searchRequest.url : null,
);
check(
  'search results render as post rows under their own page controls',
  all('li.kai-post').length === 2 &&
    document.querySelector('.kai-pager') !== null &&
    document.querySelector('.kai-pager').nextElementSibling ===
      document.querySelector('.kai-content > ul.kai-list--flat'),
  {
    rows: all('li.kai-post').length,
    pager: Boolean(document.querySelector('.kai-pager')),
  },
);

// Back out to the dashboard, where the platform takes Back.
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
await press('Backspace');
await until(() => document.querySelectorAll('.kai-list-item').length === 3);

/* --- Account: the device flow ---------------------------------------------- */

// The dashboard's second row is Account; enter it while signed out.
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_account');
check(
  'the account screen offers sign-in when signed out',
  text('.kai-content > .kai-text') === 'account_sign_in_intro' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  {
    intro: text('.kai-content > .kai-text'),
    rows: texts('.kai-list-item__primary'),
  },
);

// Start the flow: the Sign in row is the only row.
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-account__code')));
const codeRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/auth/open/device/code') !== -1,
)[0];
check(
  'the device flow asks Stargate for a code as the shared client',
  Boolean(codeRequest) &&
    codeRequest.method === 'POST' &&
    codeRequest.requestBody.indexOf('client_id=solian-on-watch') !== -1 &&
    codeRequest.requestBody.indexOf('scope=*') !== -1,
  codeRequest ? { method: codeRequest.method, body: codeRequest.requestBody } : null,
);
check(
  'the user code and waiting state are shown for the other device',
  text('.kai-account__code') === 'CODE-1234' && text('.kai-account__waiting') === 'account_waiting',
  { code: text('.kai-account__code'), waiting: text('.kai-account__waiting') },
);
check(
  'the signing-in screen shows a QR code encoding the prefilled page',
  (() => {
    const image = document.querySelector('.kai-account__qr img');
    if (!image) return false;
    const src = image.getAttribute('src');
    const prefix = 'data:image/svg+xml;charset=utf-8,';
    if (!src || src.indexOf(prefix) !== 0) return false;
    // A real QR is drawn: the SVG carries the white backing and module paths.
    const svg = decodeURIComponent(src.slice(prefix.length));
    return svg.indexOf('<svg') === 0 && svg.indexOf('<rect') !== -1 && svg.indexOf('<path') !== -1;
  })(),
  (() => {
    const image = document.querySelector('.kai-account__qr img');
    return image ? image.getAttribute('src') : null;
  })(),
);

// The first poll is still pending; the second exchange approves.
await untilTimer(() => Boolean(document.querySelector('.kai-account__name')));
const tokenRequests = requests.filter(
  (request) => request.url.indexOf('/stargate/auth/open/token') !== -1,
);
check(
  'the poll exchanges the device code twice, pending then approved',
  tokenRequests.length === 2 &&
    decodeURIComponent(tokenRequests[0].requestBody).indexOf(
      'grant_type=urn:ietf:params:oauth:grant-type:device_code',
    ) !== -1 &&
    tokenRequests[0].requestBody.indexOf('device_code=dev-1') !== -1,
  tokenRequests.map((request) => decodeURIComponent(request.requestBody)),
);
const meRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/accounts/me') !== -1,
)[0];
check(
  'the profile is fetched with the new token',
  Boolean(meRequest) && meRequest.requestHeaders.Authorization === 'Bearer test-access',
  meRequest ? meRequest.requestHeaders : null,
);
check(
  'the account screen shows the signed-in identity and its banner',
  (() => {
    const name = text('.kai-account__name');
    const handle = text('.kai-account__handle');
    const banner = document.querySelector('.kai-account__banner');
    const pfp = document.querySelector('.kai-account__pfp');
    return (
      name === 'Test User' &&
      handle === '@testuser' &&
      Boolean(banner) &&
      banner.getAttribute('src') === 'https://api.solian.app/drive/files/banner-1?preset=thumb' &&
      Boolean(pfp) &&
      pfp.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb'
    );
  })(),
  {
    name: text('.kai-account__name'),
    handle: text('.kai-account__handle'),
    banner: (document.querySelector('.kai-account__banner') || {}).getAttribute
      ? document.querySelector('.kai-account__banner').getAttribute('src')
      : null,
    pfp: (document.querySelector('.kai-account__pfp') || {}).getAttribute
      ? document.querySelector('.kai-account__pfp').getAttribute('src')
      : null,
  },
);

// Back to the dashboard: the feed now goes out authenticated.
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');
await press('Enter');
await until(() => all('li.kai-post').length > 0);
const authedFeed = requests
  .filter(
    (request) =>
      request.url.indexOf('/sphere/posts?') !== -1 && request.url.indexOf('query=') === -1,
  )
  .slice(-1)[0];
check(
  'the feed is authenticated after sign-in',
  Boolean(authedFeed) && authedFeed.requestHeaders.Authorization === 'Bearer test-access',
  authedFeed ? authedFeed.requestHeaders : null,
);

/* --- Reactions: the signed-in picker ------------------------------------ */

// The highlight rests on the first post, so the right softkey opens its
// options sheet; React is the third choice (after Reply and Forward).
await until(() => text('.kai-softkey__key--right') === 'action_options');
await press('SoftRight');
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "a feed row's options sheet lists the read-write actions",
  texts('.kai-option-menu__item').join('|') === 'action_reply|action_forward|action_react',
  texts('.kai-option-menu__item').join('|'),
);
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => document.querySelectorAll('.kai-reaction-tile').length === 15);
check(
  'the signed-in picker shows the fifteen reaction stickers',
  text('.kai-header__title') === 'action_react' &&
    document.querySelectorAll('.kai-reaction-tile').length === 15,
  {
    title: text('.kai-header__title'),
    tiles: document.querySelectorAll('.kai-reaction-tile').length,
  },
);
const reactionBadges = () =>
  Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile__count')).map((node) => node.textContent);
check(
  'the picker carries the post reactions as count badges',
  reactionBadges().length === 2 && reactionBadges().every((count) => count === '1'),
  reactionBadges(),
);

// The cursor starts on the first sticker; the D-pad walks the 5×3 grid.
check(
  'the picker starts on the first sticker',
  document.querySelectorAll('.kai-reaction-tile')[0].className.indexOf('kai-reaction-tile--selected') !== -1,
  document.querySelectorAll('.kai-reaction-tile')[0].className,
);
await press('ArrowRight');
check(
  'RIGHT moves the cursor to the next sticker',
  document.querySelectorAll('.kai-reaction-tile')[1].className.indexOf('kai-reaction-tile--selected') !== -1,
  document.querySelectorAll('.kai-reaction-tile')[1].className,
);

// Enter reacts with the highlighted sticker; the toggle answer bumps the badge.
await press('Enter');
await until(() => reactionBadges().length === 3);
const reactionPosts = requests.filter(
  (request) =>
    request.method === 'POST' &&
    request.url.indexOf('/sphere/posts/') !== -1 &&
    request.url.indexOf('/reactions') !== -1,
);
check(
  'reacting POSTs the highlighted sticker and attitude',
  reactionPosts.length === 1 &&
    JSON.parse(reactionPosts[0].requestBody).symbol === 'salute' &&
    JSON.parse(reactionPosts[0].requestBody).attitude === 0,
  reactionPosts.map((request) => request.requestBody),
);
check(
  'a fresh reaction appears as a count badge',
  reactionBadges().length === 3 && reactionBadges().indexOf('1') !== -1,
  reactionBadges(),
);

// Reactions the user made — the post's `reactions_made` (pray) and the one
// just added (salute) — are tinted and carry a check, like the main app's.
check(
  'reactions the user made are highlighted with a check',
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const bySrc = {};
    for (const tile of tiles) {
      const img = tile.querySelector('img');
      if (img) bySrc[img.getAttribute('src')] = tile;
    }
    const made = (tile) =>
      Boolean(tile) && tile.className.indexOf('kai-reaction-tile--made') !== -1;
    const pray = bySrc['/img/reactions/pray.png'];
    const salute = bySrc['/img/reactions/salute.png'];
    return (
      made(pray) && Boolean(pray.querySelector('.kai-reaction-tile__check')) &&
      made(salute) && Boolean(salute.querySelector('.kai-reaction-tile__check'))
    );
  })(),
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const made = tiles
      .filter((tile) => tile.className.indexOf('kai-reaction-tile--made') !== -1)
      .map((tile) => tile.querySelector('img').getAttribute('src'));
    return { made, checks: document.querySelectorAll('.kai-reaction-tile__check').length };
  })(),
);

// Reacting again with the same sticker takes it back: the endpoint answers
// 204, the badge and the highlight both clear.
await press('Enter');
await until(() => reactionBadges().length === 2);
check(
  're-acting with the same sticker removes its badge and highlight',
  (() => {
    const tiles = Array.prototype.slice.call(document.querySelectorAll('.kai-reaction-tile'));
    const salute = tiles.find((tile) => {
      const img = tile.querySelector('img');
      return img && img.getAttribute('src') === '/img/reactions/salute.png';
    });
    return (
      reactionBadges().length === 2 &&
      Boolean(salute) &&
      salute.className.indexOf('kai-reaction-tile--made') === -1
    );
  })(),
  { badges: reactionBadges(), made: document.querySelectorAll('.kai-reaction-tile--made').length },
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Owned post: edit and delete ---------------------------------------- */

// The signed-in account's own post, reached by bookmarking its URL: the hash
// sync rebuilds the stack and the canned route answers the owned detail.
window.location.hash = '#/explore/post?id=' + OWNED_POST_ID;
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
check(
  "the owned post's picture leads the view",
  text('.kai-header__title') === 'post_title' &&
    document.querySelector('.kai-post-extras').getAttribute('nav-selected') === 'true',
  { title: text('.kai-header__title'), extras: document.querySelector('.kai-post-extras').getAttribute('nav-selected') },
);
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
check(
  "an owned post's menu adds edit and delete",
  texts('.kai-option-menu__item').join('|') ===
    'action_reply|action_forward|action_react|post_edit|post_delete|action_reload',
  texts('.kai-option-menu__item').join('|'),
);

// The cursor starts on Reply; three DOWNs reach Edit.
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  "edit opens the composer seeded with the post's content",
  text('.kai-header__title') === 'compose_edit' &&
    document.querySelector('.kai-field__textarea').value === 'owned post body',
  {
    title: text('.kai-header__title'),
    draft: document.querySelector('.kai-field__textarea') ? document.querySelector('.kai-field__textarea').value : null,
  },
);
check(
  'the edited post keeps its own publisher: no publisher row',
  texts('.kai-list-item__primary').join('|').indexOf('compose_post_as') === -1,
  texts('.kai-list-item__primary').join('|'),
);
check(
  "the edited post's attachments seed the draft",
  texts('.kai-list-item__primary').join('|').indexOf('seed.png') !== -1,
  texts('.kai-list-item__primary').join('|'),
);
check(
  'the Save key is live on the seeded draft',
  text('.kai-softkey__key--right') === 'compose_save',
  text('.kai-softkey__key--right'),
);

// Edit the body and save: the PATCH is scoped to the post's publisher.
const editField = document.querySelector('.kai-field__textarea');
editField.value = 'owned post body\nedited';
editField.dispatchEvent(new window.Event('input', { bubbles: true }));
await press('SoftRight');
await until(() => text('.kai-header__title') === 'post_title');
const editRequests = requests.filter(
  (request) => request.method === 'PATCH' && request.url.indexOf('/sphere/posts/' + OWNED_POST_ID) !== -1,
);
check(
  'saving PATCHes the post under its publisher with the new content',
  editRequests.length === 1 &&
    editRequests[0].url.indexOf('pub=testuser') !== -1 &&
    JSON.parse(editRequests[0].requestBody).content === 'owned post body\nedited',
  editRequests.map((request) => ({ url: request.url, body: request.requestBody })),
);

// Back on the post view; the menu's Delete row asks before it acts.
await until(() => Boolean(document.querySelector('.kai-post-extras[nav-selected="true"]')));
document.querySelector('.kai-softkey__key--right').click();
await until(() => Boolean(document.querySelector('.kai-option-menu')));
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('ArrowDown');
await press('Enter');
check(
  'the first press on Delete asks for confirmation',
  texts('.kai-option-menu__item').join('|').indexOf('post_delete_confirm') !== -1,
  texts('.kai-option-menu__item').join('|'),
);
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_explore');
const deleteRequests = requests.filter(
  (request) => request.method === 'DELETE' && request.url.indexOf('/sphere/posts/' + OWNED_POST_ID) !== -1,
);
check(
  'the second press DELETEs the post and returns to the feed',
  deleteRequests.length === 1 && text('.kai-header__title') === 'nav_explore',
  { deletes: deleteRequests.length, title: text('.kai-header__title') },
);

await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

/* --- Compose: publisher, photo, post -------------------------------------- */

// Signed in, the write path is the left softkey — no compose tile on the feed.
await press('Enter');
await until(() => all('li.kai-post').length === 2);
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'compose opens on the first owned publisher with the media toolbar',
  texts('.kai-list-item__primary').join('|') === 'compose_post_as(name)' &&
    // The row is icon-only: each tool draws a lucide glyph and keeps its name
    // as the accessible label.
    all('.kai-icon-button').length === 4 &&
    all('.kai-icon-button svg').length === 4 &&
    all('.kai-icon-button')
      .map((button) => button.getAttribute('aria-label'))
      .join('|') === 'compose_take_photo|compose_record_video|compose_record_audio|compose_add_photo' &&
    all('.kai-icon-button__label').length === 0,
  {
    rows: texts('.kai-list-item__primary'),
    tools: all('.kai-icon-button').map((button) => button.getAttribute('aria-label')),
  },
);
check(
  'the Post as row leads with the publisher avatar',
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-1?preset=thumb';
  })(),
  (() => {
    const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
    return img ? img.getAttribute('src') : null;
  })(),
);
check(
  'the Post key waits for content',
  text('.kai-softkey__key--right') === '',
  text('.kai-softkey__key--right'),
);

// Type the body. The field is the screen's primary control, so it opens in the
// platform's text mode — but the D-pad is not trapped there: the caret keeps a
// press only while the draft has a line to move to, and a one-line value has
// none. (That trap was the bug: the focused field swallowed every arrow.)
const composeField = document.querySelector('.kai-field__textarea');
check(
  'compose opens in text mode on the body field',
  document.activeElement === composeField && composeField.getAttribute('nav-selected') === 'true',
  {
    focused: document.activeElement === composeField,
    selected: composeField.getAttribute('nav-selected'),
  },
);
check(
  'the compose body carries no underline',
  window.getComputedStyle(composeField).borderBottomStyle === 'none',
  window.getComputedStyle(composeField).borderBottomStyle,
);

composeField.value = 'hello\nworld';
composeField.setSelectionRange(0, 0);
composeField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
const caretDown = await press('ArrowDown');
check(
  'DOWN with a line below the caret stays with the caret',
  caretDown.defaultPrevented === false && composeField.getAttribute('nav-selected') === 'true',
  { prevented: caretDown.defaultPrevented, selected: composeField.getAttribute('nav-selected') },
);
composeField.setSelectionRange(composeField.value.length, composeField.value.length);
const lastLineDown = await press('ArrowDown');
check(
  'DOWN at the last line hands the press to the media toolbar',
  lastLineDown.defaultPrevented === true &&
    document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_take_photo',
  { prevented: lastLineDown.defaultPrevented, tools: all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')) },
);
await press('ArrowUp');
check(
  'UP comes back to the body field',
  composeField.getAttribute('nav-selected') === 'true' && document.activeElement === composeField,
  {
    selected: composeField.getAttribute('nav-selected'),
    focused: document.activeElement === composeField,
  },
);
// Enter in the body is the platform's newline — the draft is markdown, so
// consuming it would make a line break impossible.
const bodyEnter = await press('Enter');
check(
  'Enter in the multi-line body is left to the platform, not the app action',
  bodyEnter.defaultPrevented === false,
  bodyEnter.defaultPrevented,
);

composeField.value = 'Hello from the smoke test';
composeField.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();
check(
  'the Post key appears once there is content',
  text('.kai-softkey__key--right') === 'compose_post',
  text('.kai-softkey__key--right'),
);

// Switch publisher: the row above the field opens the picker.
await press('ArrowUp');
await press('Enter');
await until(() => text('.kai-header__title') === 'compose_publisher_title');
check(
  'the picker lists the account publishers, marking the current one',
  texts('.kai-list-item__primary').join('|') === 'Test User|Second Pub' &&
    texts('.kai-list-item__secondary').join('|') === 'compose_current · @testuser|@secondpub',
  { primary: texts('.kai-list-item__primary'), secondary: texts('.kai-list-item__secondary') },
);
check(
  'the picker rows lead with each publisher avatar',
  (() => {
    const imgs = all('.kai-list-item--thumb .kai-avatar');
    return (
      imgs.length === 2 &&
      imgs[0].getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-1?preset=thumb' &&
      imgs[1].getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-2?preset=thumb'
    );
  })(),
  all('.kai-list-item--thumb .kai-avatar').map((img) => img.getAttribute('src')),
);
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
// The remounted draft highlights its body field again, in text mode — the D-pad
// still leaves it, which is what the navigation below relies on.
check(
  'the remounted draft returns to text mode on the body field',
  document.activeElement === document.querySelector('.kai-field__textarea'),
  document.activeElement ? document.activeElement.className : null,
);
await flush();
check(
  'the chosen publisher comes back to the draft, avatar included',
  texts('.kai-list-item__secondary')[0] === '@secondpub' &&
    (() => {
      const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
      return Boolean(img) && img.getAttribute('src') === 'https://api.solian.app/drive/files/pub-avatar-2?preset=thumb';
    })(),
  {
    secondary: texts('.kai-list-item__secondary'),
    thumb: (() => {
      const img = document.querySelector('.kai-list-item--thumb .kai-avatar');
      return img ? img.getAttribute('src') : null;
    })(),
  },
);

// Attach media: DOWN from the body reaches the first toolbar tool (Take
// photo); the camera activity hands the file back as a Blob.
await press('ArrowDown');
await press('Enter');
await until(() => Boolean(document.querySelector('.kai-compose-attachment')));
check(
  'the picked photo joins the draft as a removable row',
  (texts('.kai-compose-attachment .kai-list-item__primary')[0] || '').indexOf('picked-photo.jpg') !== -1 &&
    (texts('.kai-compose-attachment .kai-list-item__secondary')[0] || '').indexOf('compose_tap_to_remove') !== -1,
  texts('.kai-compose-attachment .kai-list-item__primary'),
);
check(
  'the tile name clamps to one line, ellipsized',
  (() => {
    const primary = document.querySelector('.kai-compose-attachment .kai-list-item__primary');
    if (!primary) return false;
    const style = window.getComputedStyle(primary);
    // The ellipsis pair — `-webkit-line-clamp` would be the modern way, but
    // Gecko 48 has neither it nor `display: -webkit-box`.
    return style.whiteSpace === 'nowrap' && style.overflow === 'hidden' && style.textOverflow === 'ellipsis';
  })(),
  (() => {
    const primary = document.querySelector('.kai-compose-attachment .kai-list-item__primary');
    return primary ? window.getComputedStyle(primary) : null;
  })(),
);

// The toolbar walks left to right and wraps, like the pager's cells.
await press('ArrowDown');
check(
  'DOWN walks to the record-video tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_record_video',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
await press('ArrowDown');
check(
  'DOWN walks to the record-audio tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_record_audio',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
await press('ArrowDown');
check(
  'DOWN wraps to the gallery tool',
  document.querySelector('.kai-icon-button[nav-selected="true"]').getAttribute('aria-label') === 'compose_add_photo',
  all('.kai-icon-button[nav-selected="true"]').map((b) => b.getAttribute('aria-label')),
);
// UP walks back out of the toolbar into the body field. The body element is
// re-created by the publisher-picker remount, so it is queried fresh here.
await press('ArrowUp');
await press('ArrowUp');
await press('ArrowUp');
await press('ArrowUp');
check(
  'UP leaves the toolbar for the body field',
  document.querySelector('.kai-field__textarea').getAttribute('nav-selected') === 'true',
  document.querySelector('.kai-field__textarea').getAttribute('nav-selected'),
);

// Post: the photo uploads first, then the post is created, then back to the feed.
await press('SoftRight');
await until(() => text('.kai-header__title') === 'nav_explore');
await until(() => all('li.kai-post').length === 2);
const uploadRequest = requests
  .filter((request) => request.url.indexOf('/drive/files/upload/direct') !== -1)
  .slice(-1)[0];
const createRequest = requests
  .filter((request) => request.url.indexOf('/sphere/posts?pub=') !== -1)
  .slice(-1)[0];
const createBody = createRequest ? JSON.parse(createRequest.requestBody) : null;
check(
  'posting uploads the photo, then creates the post under the chosen publisher',
  Boolean(uploadRequest) &&
    uploadRequest.method === 'POST' &&
    uploadRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    Boolean(createRequest) &&
    createRequest.method === 'POST' &&
    createRequest.requestHeaders.Authorization === 'Bearer test-access' &&
    Boolean(createBody) &&
    createBody.content === 'Hello from the smoke test' &&
    JSON.stringify(createBody.attachments) === '["file-upload-1"]',
  {
    uploadUrl: uploadRequest ? uploadRequest.url : null,
    uploadAuth: uploadRequest ? uploadRequest.requestHeaders.Authorization : null,
    createUrl: createRequest ? createRequest.url : null,
    createBody,
  },
);

// The store cleared the draft: a fresh compose visit starts empty.
await press('SoftLeft');
await until(() => Boolean(document.querySelector('.kai-field__textarea')));
check(
  'a fresh compose visit starts with an empty draft and no photo',
  document.querySelector('.kai-field__textarea').value === '' &&
    !document.querySelector('.kai-compose-attachment'),
  {
    value: document.querySelector('.kai-field__textarea').value,
    attachments: all('.kai-compose-attachment').length,
  },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'nav_explore');
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

// Sign out: revoke the server session, then the local one.
await press('ArrowDown');
await press('Enter');
await until(() => text('.kai-header__title') === 'nav_account');
await press('ArrowDown');
await press('Enter');
await until(() => texts('.kai-list-item__primary').join('|') === 'account_sign_in');
const revokeRequest = requests.filter(
  (request) => request.url.indexOf('/stargate/sessions/current') !== -1,
)[0];
check(
  'signing out revokes the server session',
  Boolean(revokeRequest) &&
    revokeRequest.method === 'DELETE' &&
    revokeRequest.requestHeaders.Authorization === 'Bearer test-access',
  revokeRequest ? { method: revokeRequest.method, headers: revokeRequest.requestHeaders } : null,
);
check(
  'signing out returns to the sign-in prompt',
  text('.kai-content > .kai-text') === 'account_sign_in_intro' &&
    texts('.kai-list-item__primary').join('|') === 'account_sign_in',
  { intro: text('.kai-content > .kai-text'), rows: texts('.kai-list-item__primary') },
);
await press('Backspace');
await until(() => text('.kai-header__title') === 'app_title');

const backEvent = await press('Backspace');
check('Back at the top level is left to the platform', backEvent.defaultPrevented === false);

// ---- Relaunch with a stored session -----------------------------------------
// A fresh page with a stored session must render the cached identity at once
// (optimistic) and re-fetch the profile in the background — so a display name
// or banner changed on another device shows up on the next launch. jsdom's
// localStorage throws on file: origins, so the relaunch document gets an http
// origin; the rebased script URLs are absolute file:// paths, so they still
// load from dist/.
const SEED = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  expiresAt: Date.now() + 600000,
  account: {
    id: 'acc-1',
    name: 'testuser',
    nick: 'Cached Nick',
    display: 'Cached Nick',
    profile: { background: { id: 'banner-1' }, picture: { id: 'avatar-1' } },
  },
};
const relaunchHtml = html
  .replace(/(src|href)="\.\//g, `$1="${distUrl}`)
  .replace(
    '<head>',
    `<head><script>window.localStorage.setItem('sokai.session', ${JSON.stringify(JSON.stringify(SEED))});</script>`,
  );
const relaunch = new JSDOM(relaunchHtml, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://sokai.test/index.html',
});
const rw = relaunch.window;
if (rw.document.readyState !== 'complete') {
  await new Promise((resolve) => rw.addEventListener('load', resolve, { once: true }));
}
await new Promise((resolve) => setTimeout(resolve, 50));

const rRequests = rw.__requests;
const rdoc = rw.document;
const rtext = (selector) => {
  const node = rdoc.querySelector(selector);
  return node ? node.textContent.trim() : '';
};
const rflush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function runtil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true;
    await rflush();
  }
  return false;
}
async function rpress(key) {
  const event = new rw.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  rdoc.dispatchEvent(event);
  await rflush();
  return event;
}
/** For work paced by the canned /me delay (a real timer `rflush` cannot reach). */
async function runtilTimer(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// The stored identity renders without waiting for the network…
await runtil(() => rtext('.kai-header__title') === 'app_title');
await rpress('ArrowDown');
await rpress('Enter');
await runtil(() => rtext('.kai-header__title') === 'nav_account');
check(
  'a restored session shows the cached identity immediately',
  (() => {
    const pfp = rdoc.querySelector('.kai-account__pfp');
    return (
      rtext('.kai-account__name') === 'Cached Nick' &&
      rtext('.kai-account__handle') === '@testuser' &&
      Boolean(pfp) &&
      pfp.getAttribute('src') === 'https://api.solian.app/drive/files/avatar-1?preset=thumb'
    );
  })(),
  { name: rtext('.kai-account__name'), handle: rtext('.kai-account__handle') },
);

// …and refreshes it in the background with a fresh /me — no token refresh,
// because the stored access token still has life in it.
const rMe = rRequests.filter((request) => request.url.indexOf('/stargate/accounts/me') !== -1)[0];
check(
  'restoring a session re-fetches the profile',
  Boolean(rMe) && rMe.requestHeaders.Authorization === 'Bearer test-access',
  rMe ? rMe.requestHeaders : null,
);
check(
  'a still-valid stored token is not refreshed on restore',
  rRequests.filter((request) => request.url.indexOf('/stargate/auth/open/token') !== -1).length === 0,
  rRequests.map((request) => request.url),
);
await runtilTimer(() => rtext('.kai-account__name') === 'Test User');
check(
  'the refreshed profile replaces the cached identity',
  rtext('.kai-account__name') === 'Test User' && rtext('.kai-account__handle') === '@testuser',
  { name: rtext('.kai-account__name'), handle: rtext('.kai-account__handle') },
);
relaunch.window.close();

dom.window.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${steps} runtime checks failed on a Gecko 48-era realm.`);
  process.exit(1);
}

console.log(`\nruntime check passed: ${steps} assertions on a realm without post-ES2015 APIs.`);
