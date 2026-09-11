import { reactive } from 'vue';

/**
 * Bumped whenever strings are (re)loaded, so any template that called `t()`
 * re-renders. See `l10n.js`.
 */
export const l10nState = reactive({ version: 0 });

/**
 * How long to wait for `navigator.mozL10n` before painting anyway. The l10n
 * library is a separate classic script in index.html and only exists on
 * Firefox OS / KaiOS, so this must never be able to hang startup.
 */
const READY_TIMEOUT_MS = 500;

/**
 * Looks up a localised string. Reading `l10nState.version` is deliberate: it
 * registers the caller (a render effect) as a dependency, so strings that
 * arrive after first paint still show up.
 *
 * @param {string} id
 * @param {object} [args] webL10n context data for `{{ }}` placeholders
 */
export function t(id, args) {
  void l10nState.version;

  const l10n = navigator.mozL10n;
  let value = null;
  if (l10n && typeof l10n.get === 'function') {
    value = l10n.get(id, args);
  }

  // `mozL10n.get` returns an empty string when the locale data could not be
  // loaded — for example when the built package is opened over `file://`, where
  // the browser blocks the XHR that fetches the .properties files. Showing the
  // id keeps missing translations visible instead of rendering blank chrome.
  return value === undefined || value === null || value === '' ? id : value;
}

/**
 * Registers for locale changes and resolves once strings are available.
 * @returns {Promise<void>}
 */
export function initL10n() {
  window.addEventListener('languagechange', () => {
    l10nState.version += 1;
  });

  // webL10n dispatches this once the default locale has been applied.
  window.addEventListener('localized', () => {
    l10nState.version += 1;
  });

  const l10n = navigator.mozL10n;
  if (!l10n || typeof l10n.once !== 'function') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      l10nState.version += 1;
      resolve();
    };

    l10n.once(finish);
    setTimeout(finish, READY_TIMEOUT_MS);
  });
}
