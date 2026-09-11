import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Makes the bundle a valid KaiOS Open Web App package.
 *
 *  - copies `manifest.webapp` from the repo root into the bundle (Vite only
 *    copies `publicDir`, and the manifest is a root-level source file);
 *  - strips the module semantics Vite adds to the entry script. Gecko 48 has no
 *    ES module support at all, so `type="module"`, `crossorigin` and
 *    `modulepreload` must not survive into the shipped HTML.
 *
 * Validation lives in `scripts/verify-legacy.mjs` so there is exactly one place
 * that decides whether a bundle is shippable.
 */
export function kaiosManifest({ manifestPath = 'manifest.webapp' } = {}) {
  let root = process.cwd();

  return {
    name: 'kaios:manifest',
    apply: 'build',
    enforce: 'post',

    configResolved(config) {
      root = config.root;
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/\s+type="module"/g, '')
          .replace(/\s+crossorigin(?:="[^"]*")?/g, '')
          .replace(/[ \t]*<link[^>]+rel="modulepreload"[^>]*>\s*/g, '');
      },
    },

    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webapp',
        source: readFileSync(path.resolve(root, manifestPath), 'utf8'),
      });
    },
  };
}
