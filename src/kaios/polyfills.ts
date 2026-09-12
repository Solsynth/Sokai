/**
 * Runtime `Promise.withResolvers` for engines that lack it (Gecko 48).
 *
 * The production build's Babel pass also injects the core-js polyfill, but the
 * dev server skips that pass — and the KaiOS simulator targets Gecko 48 — so
 * the app must not depend on the build pipeline for a six-line ES2015 helper.
 *
 * Must be imported before any module that calls it. All call sites (l10n, xhr,
 * session) are inside functions invoked after mount, so main.ts's first-import
 * order is belt and braces rather than load-bearing.
 */
if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T = unknown>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    } {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}
