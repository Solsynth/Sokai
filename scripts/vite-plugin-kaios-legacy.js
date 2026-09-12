import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { transformAsync } from '@babel/core';

import { legacyBabelOptions } from './babel-legacy.js';

// `.vue` arrives here already compiled to JS by plugin-vue; `.ts` modules
// arrive with their types intact and are stripped by the TypeScript preset in
// the same Babel pass (see babel-legacy.js) — which is what lets the core-js
// polyfill provider see the module's real API usage before the bundler runs.
const JS_ID = /\.(m?js|vue|ts)$/;

// core-js is the polyfill library itself: injecting polyfills into it is
// pointless. It is also actively harmful — the injected `import` statements
// change how `@rollup/plugin-commonjs` orders its interop prologue, and the
// bundle ends up calling a module's `require…()` before the
// `var name = { exports: {} }` it depends on (measured as
// "Cannot set properties of undefined (setting 'exports')" at app startup).
// core-js's own syntax is still lowered, by the final pass below.
const SKIP_ID = /[\\/]node_modules[\\/]core-js[\\/]/;

/**
 * Compiles everything Vite emits down to what Gecko 48 can actually execute.
 *
 * Three passes, and the placement of each one is load-bearing:
 *
 *  1. `transform` (per module, before the bundler concatenates).
 *     The core-js polyfill provider injects `import 'core-js/...'` statements,
 *     and the bundler can only resolve those while it is still building the
 *     module graph. This pass also covers `node_modules` — modern dependencies
 *     ship post-ES2015 syntax and built-ins, so an "our source only" pass would
 *     leak both. Nothing may be excluded here: core-js itself uses optional
 *     catch binding, and skipping it put `catch {}` in the shipped bundle.
 *
 *  2. The bundler and its minifier, both told to target `esnext`.
 *
 *  3. `writeBundle` (the assembled file, after everything else has written it).
 *     This is the pass that decides what actually ships, so it has to be last.
 *     Anything that runs after it can undo it: with the final pass wired to
 *     `renderChunk`, esbuild's minifier ran afterwards and optimised Babel's
 *     lowered output back up to modern syntax — Babel wrote
 *     `catch (_unused) {}`, the minifier dropped the unused binding, and the
 *     bundle stopped parsing on Gecko 48. It rewrites the file in place, so
 *     nothing downstream can reintroduce syntax the engine cannot read.
 */
export function kaiosLegacy() {
  return {
    name: 'kaios:legacy',
    apply: 'build',
    // Must run after `@vitejs/plugin-vue` has turned SFCs into JavaScript.
    enforce: 'post',

    async transform(code, id) {
      if (!JS_ID.test(id) || SKIP_ID.test(id)) return null;

      const result = await transformAsync(code, {
        ...legacyBabelOptions(),
        filename: id.split('?')[0],
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        caller: {
          name: 'kaios-legacy',
          supportsStaticESM: true,
          supportsDynamicImport: false,
        },
      });

      return { code: result.code, map: null };
    },

    async writeBundle(outputOptions, bundle) {
      const outDir = outputOptions.dir;
      if (!outDir) return;

      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith('.js')) continue;

        const file = path.join(outDir, fileName);
        const result = await transformAsync(readFileSync(file, 'utf8'), {
          ...legacyBabelOptions({ polyfills: false }),
          filename: fileName,
          babelrc: false,
          configFile: false,
          compact: true,
          comments: false,
          sourceMaps: false,
        });

        writeFileSync(file, result.code);
      }
    },
  };
}
