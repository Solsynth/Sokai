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
 * completes a privileged request.
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

  /* Deterministic stand-in for public/js/libs/l10n.js: get() echoes the id, so
     assertions also prove strings flow through the l10n layer. once() is
     synchronous, which turns the real page's mount race into a hard failure. */
  window.navigator.mozL10n = {
    get: function (id) { return id; },
    once: function (callback) { callback(); }
  };

  /* Stands in for XMLHttpRequest so the privileged path can be inspected. */
  window.__requests = [];
  window.XMLHttpRequest = function (options) {
    this.options = options;
    this.responseType = '';
    this.timeout = 0;
    this.status = 0;
  };
  window.XMLHttpRequest.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  window.XMLHttpRequest.prototype.send = function () {
    window.__requests.push(this);
  };
  window.XMLHttpRequest.prototype.respond = function (status, body) {
    this.status = status;
    this.response = body;
    this.onload();
  };
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

/* --- Boot ---------------------------------------------------------------- */

const items = all('.kai-list-item');
check('app mounts', all('#app').length === 1 && items.length === 2, `list items: ${items.length}`);
check('header renders a localised title', text('.kai-header__title') === 'app_title', text('.kai-header__title'));
check(
  'first item starts selected',
  items[0] && items[0].getAttribute('nav-selected') === 'true',
  navState(items),
);

/* --- D-pad -------------------------------------------------------------- */

await press('ArrowDown');
check(
  'DOWN moves the highlight',
  items[0].getAttribute('nav-selected') === 'false' && items[1].getAttribute('nav-selected') === 'true',
  navState(items),
);

await press('ArrowDown');
check(
  'DOWN at the end wraps to the top (design-guide list loop)',
  items[0].getAttribute('nav-selected') === 'true',
  navState(items),
);

await press('ArrowUp');
check('UP at the top wraps to the end', items[1].getAttribute('nav-selected') === 'true', navState(items));

check(
  'softkey shows the centre action',
  text('.kai-softkey__key--center') === 'action_select',
  text('.kai-softkey__key--center'),
);

/* --- Navigate ----------------------------------------------------------- */

// Back onto the first item, which is the screen this exercises.
await press('ArrowUp');
await press('Enter');

check(
  'ENTER opens the selected screen',
  text('.kai-header__title') === 'nav_search',
  text('.kai-header__title'),
);
check(
  'back softkey appears on a sub-screen',
  text('.kai-softkey__key--left') === 'action_back',
  text('.kai-softkey__key--left'),
);

/* --- Privileged request ------------------------------------------------- */

const input = document.querySelector('.kai-field__input');
check('text field is focusable and selected', Boolean(input) && document.activeElement === input, {
  present: Boolean(input),
  focused: document.activeElement && document.activeElement.tagName,
});

input.value = 'array';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await flush();

await press('Enter');

const request = requests[0];
check('ENTER sends a request', Boolean(request));
if (request) {
  check('request uses the systemXHR privilege', request.options && request.options.mozSystem === true);
  check('request is a GET', request.method === 'GET');
  check('request URL carries the search term', request.url.includes('q=array'), request.url);
}

if (request) {
  request.respond(200, {
    items: [
      {
        full_name: 'solsynth/sokai',
        html_url: 'https://github.com/solsynth/sokai',
      },
    ],
  });
  await flush();
}

check('results render', all('.kai-result').length === 1, `results: ${all('.kai-result').length}`);
check(
  'result shows the remote title',
  text('.kai-result').startsWith('solsynth/sokai'),
  text('.kai-result'),
);

/* --- Back, then the other screen ---------------------------------------- */

await press('SoftLeft');
check('left softkey goes back', text('.kai-header__title') === 'app_title', text('.kai-header__title'));

await press('ArrowDown');
await press('Enter');
const about = text('.kai-content');
check('second screen opens', text('.kai-header__title') === 'nav_about', text('.kai-header__title'));
// Guards the build-time `define` values: unreplaced, these render as nothing
// and the screen is silently blank.
check('About shows the compiled version', about.includes('0.2.0'), about);
check('About shows the compiled target', about.includes('KaiOS 2.5 (Gecko 48)'), about);

await press('SoftLeft');

const backEvent = await press('Backspace');
check('Back at the top level is left to the platform', backEvent.defaultPrevented === false);

dom.window.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${steps} runtime checks failed on a Gecko 48-era realm.`);
  process.exit(1);
}

console.log(`\nruntime check passed: ${steps} assertions on a realm without post-ES2015 APIs.`);
