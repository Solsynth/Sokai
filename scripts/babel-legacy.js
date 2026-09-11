import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import polyfillCorejs3 from 'babel-plugin-polyfill-corejs3';

import { KAIOS_BABEL_TARGETS } from './target.js';

const require = createRequire(import.meta.url);

let cachedCoreJs = null;

/**
 * core-js must be pinned to the exact installed version, otherwise the
 * polyfill provider injects imports for a different release than the one
 * Rollup actually bundles. Derived, never hardcoded.
 */
function installedCoreJsVersion() {
  if (cachedCoreJs !== null) return cachedCoreJs;

  let version = '3.0';
  try {
    const pkg = require.resolve('core-js/package.json');
    version = JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch {
    // Fall back to the plugin's own default; better than crashing the build.
  }

  cachedCoreJs = version;
  return version;
}

/**
 * Babel options for the KaiOS target. This is the only place that decides how
 * app code and dependencies are compiled down.
 *
 * Two halves, and both matter:
 *
 *  - `@babel/preset-env` lower *syntax*. Gecko 48 lacks async/await (FF52),
 *    object spread (FF55), optional chaining (FF74), class fields, and so on.
 *  - `babel-plugin-polyfill-corejs3` adds *libraries*. Syntax lowering alone
 *    produces code that parses and then throws, because FF48 is also missing
 *    Promise.finally, Object.fromEntries, Array.prototype.flat,
 *    NodeList.prototype.forEach, … `usage-global` injects only the core-js
 *    modules for APIs the code actually mentions, filtered by `targets`.
 *
 * `polyfills: false` is used for the second pass over the assembled chunk:
 * by then the output is a string and injected `import`s could not be resolved.
 */
export function legacyBabelOptions({ polyfills = true } = {}) {
  return {
    // Rollup owns module semantics; Babel must never rewrite import/export.
    presets: [['@babel/preset-env', { targets: KAIOS_BABEL_TARGETS, modules: false }]],
    plugins: polyfills
      ? [
          [
            polyfillCorejs3,
            {
              method: 'usage-global',
              version: installedCoreJsVersion(),
              targets: KAIOS_BABEL_TARGETS,
            },
          ],
        ]
      : [],
  };
}
