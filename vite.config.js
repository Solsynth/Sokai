import { readFileSync } from 'node:fs';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { kaiosLegacy } from './scripts/vite-plugin-kaios-legacy.js';
import { kaiosManifest } from './scripts/vite-plugin-kaios-manifest.js';
import { KAIOS_ESBUILD_TARGET, TARGET_LABEL } from './scripts/target.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [vue(), kaiosLegacy(), kaiosManifest()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __KAIOS_TARGET__: JSON.stringify(TARGET_LABEL),
  },

  build: {
    // The bundler and its minifier are deliberately left at `esnext`:
    //  - esbuild's minifier rewrites *toward* its target, so pointing it at
    //    Gecko 48 lets it re-emit syntax the engine cannot parse.
    //  - Vite also transpiles the assembled chunk (`vite:esbuild-transpile`),
    //    which fails outright when handed this chunk and this target.
    // Babel owns the real target instead, and its final pass runs last
    // (scripts/vite-plugin-kaios-legacy.js).
    target: 'esnext',
    // CSS is the exception: esbuild lowers it completely and safely, and the
    // real target here stops nesting and other modern syntax from shipping.
    cssTarget: KAIOS_ESBUILD_TARGET,

    // Gecko 48 has no `type="module"` and no modulepreload.
    modulePreload: false,

    // One classic script + one stylesheet, fixed names: the manifest's
    // `launch_path` and the CSP for privileged apps both want predictable URLs.
    cssCodeSplit: false,

    // Three transpilers deep (esbuild, Babel, Babel) a map would be a chain of
    // approximations, and the package has to exclude it anyway. On-device
    // debugging on KaiOS is done through WebIDE's console.
    sourcemap: false,

    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'js/app.js',
        assetFileNames: ({ names }) =>
          names?.[0]?.endsWith('.css') ? 'css/app.css' : 'assets/[name][extname]',
      },
    },
  },
});
