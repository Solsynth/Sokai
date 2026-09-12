import { isMonitor } from '~/src/kaios/screen.js';
import type { ViewEntry } from '~/src/kaios/views.js';

/**
 * Dev-browser path sync.
 *
 * On a handset there is no address bar, no URL entry, and the hardware Back
 * key is the app's own history — a URL is invisible and browser-history
 * entries would fight the platform's Back. So the screen stack deliberately
 * stays memory-only on device (`views.ts`).
 *
 * In the desktop browser the same app is a web page: the URL should reflect
 * where you are, a refresh should come back to the same screen, and a screen
 * should be bookmarkable. This module gives the dev server (and `npm run
 * preview`) that, gated on the same `screen`-is-a-monitor test the status-bar
 * inset uses — so it never runs on a handset.
 *
 * The hash is written with `history.replaceState` (Firefox 4+, so Gecko 48 is
 * fine): each screen change replaces the current entry instead of stacking
 * history, so the browser's Back never fights the app's own Back. Only an
 * external change — a bookmark load, a manual hash edit — fires `hashchange`,
 * and that rebuilds the stack.
 *
 * Format: `#/view?a=b/view2` — the dashboard is implicit (it is always the
 * root), each segment is a stack entry with its parameters. Unknown view names
 * are dropped rather than rendered as a blank screen.
 */

let enabled = false;
let lastWritten = '';
let allowedNames: string[] = [];
let applyStack: ((entries: ViewEntry[]) => void) | null = null;

const ROOT: ViewEntry = { name: 'dashboard', params: {} };

/**
 * Enables hash sync where `screen` is a monitor and restores any hash the
 * browser was loaded with. Call during setup — before first render — so a
 * bookmarked screen mounts directly instead of flashing the dashboard.
 */
export function installHashSync({
  allowedNames: names,
  applyStack: apply,
}: {
  allowedNames: string[];
  applyStack: (entries: ViewEntry[]) => void;
}): void {
  allowedNames = names;
  applyStack = apply;
  if (!isMonitor()) return;

  enabled = true;
  const initial = parse(window.location.hash);
  if (initial.length > 1) apply(initial);

  window.addEventListener('hashchange', () => {
    // Belt and braces: `replaceState` does not fire `hashchange`, but if a
    // host ever echoes our own write back, do not rebuild from it.
    if (window.location.hash === lastWritten) return;
    apply(parse(window.location.hash));
  });
}

/**
 * Reflects the stack in the URL. A no-op on a handset, where there is no URL
 * to show and history entries would fight the platform Back.
 */
export function writeStackHash(stack: ViewEntry[]): void {
  if (!enabled) return;

  const hash = serialize(stack);
  if (hash === window.location.hash) return;

  lastWritten = hash;
  try {
    window.history.replaceState(null, '', hash);
  } catch (error) {
    // A host that rejects the write (the verify gates' jsdom refuses
    // hash-only changes on `file://`) simply keeps the URL as it is; the app
    // never depends on the affordance.
  }
}

/** The dashboard is the root and is never spelled out: `#/explore/post?id=x`. */
function serialize(stack: ViewEntry[]): string {
  const segments: string[] = [];
  for (const entry of stack) {
    if (entry.name === 'dashboard') continue;
    const keys = Object.keys(entry.params || {}).sort();
    if (!keys.length) {
      segments.push(entry.name);
      continue;
    }
    segments.push(
      entry.name +
        '?' +
        keys
          .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(entry.params[key]))
          .join('&'),
    );
  }
  return '#/' + segments.join('/');
}

/** `#/explore/post?id=x` → `[dashboard, { explore }, { post, id }]`. */
function parse(hash: string): ViewEntry[] {
  const clean = String(hash || '').replace(/^#\/?/, '');
  if (!clean) return [ROOT];

  const entries: ViewEntry[] = [ROOT];
  const segments = clean.split('/').filter(Boolean);
  for (const segment of segments) {
    const queryIndex = segment.indexOf('?');
    const name = queryIndex === -1 ? segment : segment.slice(0, queryIndex);
    if (allowedNames.indexOf(name) === -1) continue;

    const params: Record<string, string> = {};
    if (queryIndex !== -1) {
      const pairs = segment.slice(queryIndex + 1).split('&');
      for (const pair of pairs) {
        if (!pair) continue;
        const equals = pair.indexOf('=');
        if (equals === -1) continue;
        try {
          params[decodeURIComponent(pair.slice(0, equals))] = decodeURIComponent(
            pair.slice(equals + 1),
          );
        } catch (error) {
          // A malformed escape: drop just that pair, keep the rest.
        }
      }
    }
    entries.push({ name, params });
  }
  return entries;
}
