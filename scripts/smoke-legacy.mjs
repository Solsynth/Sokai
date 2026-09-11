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

import { STATUS_BAR_PX, statusBarInset } from '../src/kaios/screen.js';

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
      publisher: { id: '5e446e1d-29fa-4aea-9c6d-c20306b83433', type: 0, name: 'iCat', nick: 'iCat' },
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
  attachments: [{ id: 'd1', name: 'notes.pdf', mime_type: 'application/pdf', size: 1536 }],
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
  list: { status: 200, headers: 'x-total: 2\r\n', body: FEED },
  detail: { status: 200, headers: '', body: DETAIL },
  replies: { status: 200, headers: 'x-total: 1\r\n', body: REPLIES },
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

  delete window.NodeList.prototype.forEach;
  delete window.NodeList.prototype[Symbol.iterator];

  delete window.queueMicrotask;
  delete window.structuredClone;
  delete window.AbortController;
  delete window.ResizeObserver;
  delete window.IntersectionObserver;
  delete window.globalThis;

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

  /* Stands in for XMLHttpRequest so the privileged path can be inspected, and
     answers from a canned route table so the read path can be driven end to
     end. Responses land in a later turn of the event loop, like the real ones. */
  var CANNED = ${JSON.stringify(CANNED)};

  window.__requests = [];
  window.XMLHttpRequest = function (options) {
    this.options = options;
    this.responseType = '';
    this.timeout = 0;
    this.status = 0;
    this.requestHeaders = {};
    this.responseHeaders = '';
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
  window.XMLHttpRequest.prototype.send = function () {
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
    var canned = url.indexOf('/replies') !== -1
      ? CANNED.replies
      : url.indexOf('?') !== -1
        ? CANNED.list
        : CANNED.detail;

    xhr.respond(canned.status, canned.body, canned.headers);
  }
})();
</script>`;

const DIST = path.resolve('dist');
const distUrl = pathToFileURL(DIST + path.sep).href;

// The package uses root-absolute URLs, which is correct on a device (the app is
// served from its origin root) but means nothing to a file path. Rebase them
// onto dist/ so the loader can fetch them; the tag order and attributes — the
// things under test — are untouched.
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
  texts('.kai-list-item__primary').join('|') === 'nav_explore|nav_about' &&
    texts('.kai-list-item__secondary').join('|') === 'nav_explore_desc|nav_about_desc',
  { primary: texts('.kai-list-item__primary'), secondary: texts('.kai-list-item__secondary') },
);
check(
  'the dashboard clock shows a time and a date',
  /^\d{2}:\d{2}:\d{2}$/.test(text('.kai-clock__time')) && /^\d{4}-\d{2}-\d{2}$/.test(text('.kai-clock__date')),
  { time: text('.kai-clock__time'), date: text('.kai-clock__date') },
);
check('the dashboard asks the network for nothing', requests.length === 0, requests.length);

await press('Enter');

/* --- Explore -------------------------------------------------------------- */

await until(() => document.querySelectorAll('li.kai-post').length > 0);

const rows = all('li.kai-post');
check('app mounts', all('#app').length === 1 && rows.length === 2, `explore rows: ${rows.length}`);
check('header renders a localised title', text('.kai-header__title') === 'nav_explore', text('.kai-header__title'));
check('first row starts selected', rows[0] && rows[0].getAttribute('nav-selected') === 'true', navState(rows));

const listRequest = requests[0];
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
check('one request is made for the post list', requests.length === 1, requests.length);

check(
  'rows show the author display name and handle',
  texts('.kai-post__author').map(tight).join('|') === 'iCat @iCat|Solsynth @Solsynth',
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
  'rows summarise attachments and count the ones they leave out',
  texts('.kai-post__attach').map(tight).join(' | ') ===
    '[post_attach_image] 810×1440 · 350 KB | post_more_attachments(n)',
  texts('.kai-post__attach').map(tight),
);
check(
  'a row shows the picture and reserves its box',
  (() => {
    const image = document.querySelector('li.kai-post .kai-attachment__image');
    return (
      Boolean(image) &&
      image.getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK' &&
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
  'rows show the reply, boost and reaction counts',
  // Vue condenses the whitespace between the three spans away, so compare the
  // label sequence rather than the rendered spacing.
  text('.kai-post__counts').replace(/\s+/g, '') ===
    'post_count_replies(n)post_count_boosts(n)post_count_reactions(n)',
  text('.kai-post__counts'),
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
  'DOWN at the end wraps to the top (design-guide list loop)',
  rows[0].getAttribute('nav-selected') === 'true',
  navState(rows),
);

await press('ArrowUp');
check('UP at the top wraps to the end', rows[1].getAttribute('nav-selected') === 'true', navState(rows));

check('softkey shows the centre action', text('.kai-softkey__key--center') === 'action_open', text('.kai-softkey__key--center'));
check(
  'Explore offers Back, and About is a dashboard entry instead of a softkey',
  text('.kai-softkey__key--left') === 'action_back' && text('.kai-softkey__key--right') === '',
  { left: text('.kai-softkey__key--left'), right: text('.kai-softkey__key--right') },
);

/* --- Post detail -------------------------------------------------------- */

await press('ArrowUp');
await press('Enter');
await until(() => document.querySelector('.kai-md h1'));

check('ENTER opens the selected post', text('.kai-header__title') === 'post_title', text('.kai-header__title'));
check(
  'back softkey appears on a sub-screen',
  text('.kai-softkey__key--left') === 'action_back',
  text('.kai-softkey__key--left'),
);

const detailRequests = requests.slice(1);
check(
  'the post and its replies are requested together',
  detailRequests.length === 2 &&
    detailRequests[0].url === 'https://api.solian.app/sphere/posts/' + FEED_POST_ID &&
    detailRequests[1].url === 'https://api.solian.app/sphere/posts/' + FEED_POST_ID + '/replies?take=20&offset=0',
  detailRequests.map((request) => request.url),
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
check(
  'focus starts in the post body',
  Boolean(bodyCard) && bodyCard.getAttribute('nav-selected') === 'true',
  bodyCard && bodyCard.getAttribute('nav-selected'),
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
  'attachments sit above the card, not inside it',
  all('.kai-post-extras .kai-post__attach').length === 1 &&
    all('.kai-content > div.kai-post .kai-post__attach').length === 0 &&
    all('.kai-post-extras .kai-attachment__image').length === 0 &&
    (document.querySelector('.kai-content').firstElementChild || {}).className === 'kai-post-extras',
  {
    extras: texts('.kai-post-extras .kai-post__attach').map(tight),
    insideCard: all('.kai-content > div.kai-post .kai-post__attach').length,
    firstChild: (document.querySelector('.kai-content').firstElementChild || {}).className,
  },
);
check(
  'the detail lists every attachment',
  texts('.kai-post-extras .kai-post__attach').map(tight).join(' | ') ===
    '[post_attach_file] notes.pdf · 1.5 KB',
  texts('.kai-post-extras .kai-post__attach').map(tight),
);
check(
  'an inline file image is rendered, and a foreign one is not fetched',
  (() => {
    const photos = all('.kai-md__photo');
    const marker = document.querySelector('.kai-md__image');
    const foreign = all('img').filter((image) => (image.getAttribute('src') || '').indexOf('example.com') !== -1);
    return (
      photos.length === 1 &&
      photos[0].getAttribute('src') === 'https://api.solian.app/drive/files/01M28ESTWBSXQSTMVVBYYFDXSK' &&
      photos[0].getAttribute('alt') === 'shot' &&
      Boolean(marker) &&
      marker.textContent === '[image]' &&
      foreign.length === 0
    );
  })(),
  {
    photos: all('.kai-md__photo').map((image) => image.getAttribute('src')),
    marker: text('.kai-md__image'),
    foreignImages: all('img').map((image) => image.getAttribute('src')),
  },
);
check(
  'a document attachment is a line, not a picture',
  all('.kai-post-extras .kai-attachment__image').length === 0,
  all('.kai-post-extras .kai-attachment__image').length,
);

const replyRows = all('li.kai-post');
check(
  'replies render under their own separator',
  text('.kai-separator') === 'post_replies' &&
    replyRows.length === 1 &&
    replyRows[0].textContent.indexOf('reply body') !== -1,
  { separator: text('.kai-separator'), replies: replyRows.length },
);

// The body has nothing to scroll in jsdom (scrollHeight is 0), so the press
// moves on — the `scrollFirst` behaviour needs a real layout box.
await press('ArrowDown');
check('DOWN leaves the body for the first reply', replyRows[0].getAttribute('nav-selected') === 'true', navState(replyRows));

await press('ArrowUp');
check('UP returns to the body', bodyCard.getAttribute('nav-selected') === 'true', bodyCard.getAttribute('nav-selected'));

/* --- Back, then the other screen ---------------------------------------- */

await press('SoftLeft');
await until(() => all('li.kai-post').length === 2);
check(
  'left softkey goes back to Explore',
  text('.kai-header__title') === 'nav_explore' && all('li.kai-post').length === 2,
  { title: text('.kai-header__title'), rows: all('li.kai-post').length },
);

// Explore is no longer the top level: its Back goes up to the dashboard, and the
// dashboard is where the platform takes Back.
await press('SoftLeft');
await until(() => document.querySelectorAll('.kai-list-item').length === 2);
check(
  'Back returns to the dashboard',
  text('.kai-header__title') === 'app_title' && all('.kai-list-item').length === 2,
  { title: text('.kai-header__title'), entries: all('.kai-list-item').length },
);

await press('ArrowDown');
check(
  'DOWN reaches the second dashboard entry',
  all('.kai-list-item')[1].getAttribute('nav-selected') === 'true',
  navState(all('.kai-list-item')),
);

await press('Enter');
await until(() => text('.kai-header__title') === 'nav_about');
const about = text('.kai-content');
check('About opens from the dashboard', text('.kai-header__title') === 'nav_about', text('.kai-header__title'));
// Guards the build-time `define` values: unreplaced, these render as nothing
// and the screen is silently blank.
check('About shows the compiled version', about.includes('0.2.0'), about);
check('About shows the compiled target', about.includes('KaiOS 2.5 (Gecko 48)'), about);

await press('SoftLeft');
await until(() => document.querySelectorAll('.kai-list-item').length === 2);

const backEvent = await press('Backspace');
check('Back at the top level is left to the platform', backEvent.defaultPrevented === false);

dom.window.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${steps} runtime checks failed on a Gecko 48-era realm.`);
  process.exit(1);
}

console.log(`\nruntime check passed: ${steps} assertions on a realm without post-ES2015 APIs.`);
