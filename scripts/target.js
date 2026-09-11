/**
 * The single source of truth for the runtime this app is compiled against.
 *
 * KaiOS 2.5 ships the Gecko 48 engine (Firefox 48). That one fact has to be
 * spelled differently for each tool, because they disagree about how to name
 * it:
 *
 *  - Browserslist (autoprefixer, and anything reading package.json) knows
 *    `kaios 2.5`.
 *  - Babel's compat data does not: `@babel/helper-compilation-targets` throws
 *    "'kaios' is not a valid target", and the core-js polyfill provider then
 *    falls back to "no targets", which polyfills the entire library — measured
 *    at 431 core-js modules and 229kB instead of the intended subset. So Babel
 *    is given the engine name.
 *  - esbuild (Vite's transform *and* its minifier) takes the joined form.
 *
 * The esbuild target is not cosmetic. With it set to `esnext` while Babel
 * lowered syntax, the minifier optimised the already-lowered output back up to
 * modern syntax — Babel turned `catch {}` into `catch (_unused) {}`, the
 * minifier dropped the unused binding again, and the shipped bundle did not
 * parse on Gecko 48. Every tool that can emit syntax must be given the target.
 */
export const KAIOS_BROWSERSLIST = 'kaios 2.5';

/** Gecko 48 — the engine inside KaiOS 2.5, in Babel's target shape. */
export const KAIOS_BABEL_TARGETS = { firefox: '48' };

/** The same target in esbuild's shape, for `build.target` / `build.cssTarget`. */
export const KAIOS_ESBUILD_TARGET = `firefox${KAIOS_BABEL_TARGETS.firefox}`;

/** Human-readable name used in build output and on the About screen. */
export const TARGET_LABEL = 'KaiOS 2.5 (Gecko 48)';
