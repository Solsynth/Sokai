/**
 * Makes the built HTML loadable by Gecko 48.
 *
 * Vite emits the entry script as a module by default. Gecko 48 has no ES module
 * support at all, so two things have to happen to the final HTML:
 *
 *  - drop the module semantics (`type="module"`, `crossorigin`, modulepreload);
 *  - put back the deferred execution that came with them. A module script is
 *    deferred by specification, so without this the bundle becomes a classic
 *    script in `<head>` that runs *during* head parsing — before
 *    `<div id="app">` exists — and the app cannot mount. `async` is not an
 *    option: it fires on arrival, which is the same problem.
 *
 * `manifest.webapp` is not handled here: it lives in `public/`, which Vite
 * copies verbatim, so the repository root is deliberately not a valid app
 * package. Pointing KaiOS WebIDE at the project root used to silently package
 * the whole project — node_modules and all — and load the source `index.html`,
 * which shows up as an empty `#app` with no error anywhere.
 */
export function kaiosHtml() {
  return {
    name: 'kaios:html',
    apply: 'build',
    enforce: 'post',

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/\s+type="module"/g, '')
          .replace(/\s+crossorigin(?:="[^"]*")?/g, '')
          .replace(/[ \t]*<link[^>]+rel="modulepreload"[^>]*>\s*/g, '')
          .replace(/<script\b([^>]*\bsrc="[^"]*"[^>]*)>([\s\S]*?)<\/script>/g, (tag, attrs, body) =>
            /\sdefer\b/.test(attrs) ? tag : `<script${attrs} defer>${body}</script>`,
          );
      },
    },
  };
}
