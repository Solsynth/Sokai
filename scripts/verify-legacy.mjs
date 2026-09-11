#!/usr/bin/env node
/**
 * Static shippability gate for the KaiOS bundle.
 *
 * Run after `vite build`. Everything here is a property of `dist/` that must
 * hold for a KaiOS 2.5 (Gecko 48) device to run the app at all — the kind of
 * thing that otherwise gets discovered by sideloading onto a handset:
 *
 *  - syntax the engine cannot parse (it has no ES modules, no async/await,
 *    no object spread, no optional chaining, no `**`)
 *  - HTML that asks for ES modules, which Gecko 48 silently ignores
 *  - APIs forbidden by the privileged-app Content Security Policy
 *  - CSS that Gecko 48 has no support for and cannot degrade gracefully
 *    (CSS Grid and flex `gap` do not "look slightly off" — layout collapses)
 *  - a manifest whose `launch_path` or icons do not exist in the package
 */

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'acorn';

import { KAIOS_BROWSERSLIST } from './target.js';

const DIST = path.resolve('dist');
const failures = [];
const findings = [];

function fail(check, message) {
  failures.push({ check, message });
}

function note(check, message) {
  findings.push({ check, message });
}

function listFiles(dir) {
  const entries = readdirSync(dir);
  let files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files = files.concat(listFiles(full));
    } else {
      files.push(full);
    }
  }

  return files;
}

function relative(file) {
  return path.relative(DIST, file);
}

/** Maps a root-absolute URL from index.html onto a file in dist. */
function distPathForUrl(url) {
  const clean = url.split('?')[0].split('#')[0];
  return path.join(DIST, clean.replace(/^\//, ''));
}

/* --- Layout -------------------------------------------------------------- */

if (!existsSync(DIST)) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

const files = listFiles(DIST);
const htmlFile = path.join(DIST, 'index.html');
const jsFiles = files.filter((file) => file.endsWith('.js'));
const cssFiles = files.filter((file) => file.endsWith('.css'));

if (!existsSync(htmlFile)) fail('layout', 'dist/index.html is missing');

/* --- JavaScript syntax --------------------------------------------------- */

// ecmaVersion 6 is exactly Gecko 48's syntax level: Firefox 48 has ES2015, and
// anything newer (`**` is ES2016, async is ES2017, spread properties are
// ES2018, optional chaining is ES2020) is a parse error on device.
for (const file of jsFiles) {
  const code = readFileSync(file, 'utf8');

  try {
    parse(code, {
      ecmaVersion: 6,
      sourceType: 'script',
      allowHashBang: true,
      locations: true,
    });
  } catch (error) {
    const where = error.loc ? `:${error.loc.line}:${error.loc.column}` : '';
    fail('syntax', `${relative(file)}${where} — ${error.message}`);
  }

  // Privileged apps run under a CSP without 'unsafe-eval'.
  if (/new Function\s*\(/.test(code)) {
    fail('csp', `${relative(file)} — contains new Function(...)`);
  }
  if (/(?<![\w.$])eval\s*\(/.test(code)) {
    fail('csp', `${relative(file)} — contains a bare eval(...) call`);
  }
}

/* --- HTML ---------------------------------------------------------------- */

if (existsSync(htmlFile)) {
  const html = readFileSync(htmlFile, 'utf8');

  if (/type\s*=\s*"module"/.test(html)) {
    fail('html', 'index.html still has type="module"; Gecko 48 cannot execute it');
  }
  if (/rel\s*=\s*"modulepreload"/.test(html)) {
    fail('html', 'index.html still asks for modulepreload');
  }
  if (/crossorigin/.test(html)) {
    fail('html', 'index.html still has crossorigin attributes');
  }

  const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  for (const tag of scriptTags) {
    const src = /src\s*=\s*"([^"]*)"/.exec(tag);
    if (!src) {
      const body = tag.replace(/<[^>]*>/g, '').trim();
      if (body.length > 0) {
        fail('html', 'index.html contains an inline script, which privileged apps forbid');
      }
      continue;
    }
    if (!existsSync(distPathForUrl(src[1]))) {
      fail('html', `<script src="${src[1]}"> does not exist in the package`);
    }
  }

  const linkTags = html.match(/<link\b[^>]*>/g) || [];
  for (const tag of linkTags) {
    const href = /href\s*=\s*"([^"]*)"/.exec(tag);
    if (!href || /rel\s*=\s*"prefetch"/.test(tag)) continue;
    if (!existsSync(distPathForUrl(href[1]))) {
      fail('html', `<link href="${href[1]}"> does not exist in the package`);
    }
  }
}

/* --- CSS ----------------------------------------------------------------- */

// Each rule is a feature Gecko 48 lacks with no usable fallback.
const CSS_RULES = [
  [/display\s*:\s*(inline-)?grid\b/, 'CSS Grid is Firefox 52+; use flexbox'],
  [/(^|[;{\s-])(row-|column-)?gap\s*:/, 'flex/grid `gap` is Firefox 63+; use margins'],
  [/(^|[;{\s])inset\s*:/, '`inset` is Firefox 66+'],
  [/aspect-ratio\s*:/, '`aspect-ratio` is Firefox 89+'],
  [/\bclamp\(|\bmin\(|\bmax\(/, '`min()`/`max()`/`clamp()` are Firefox 75+'],
  [/:placeholder-shown/, ':placeholder-shown is Firefox 51+'],
  [/:focus-within/, ':focus-within is Firefox 52+'],
  [/:focus-visible/, ':focus-visible is Firefox 85+'],
  [/:is\(|:where\(|:has\(/, ':is()/:where()/:has() are Firefox 78+'],
  [/:not\([^)]*,/, 'multi-selector :not() is Firefox 84+'],
  [/:dir\(|::marker|:any-link/, 'Firefox 49+ selectors'],
  [/backdrop-filter/, '`backdrop-filter` is Firefox 103+'],
  [/clip-path/, '`clip-path` is Firefox 54+'],
  [/conic-gradient/, '`conic-gradient` is Firefox 83+'],
  [/(^|[;{\s])mask\s*:/, '`mask` is Firefox 53+'],
  [/overscroll-behavior/, '`overscroll-behavior` is Firefox 59+'],
  [/caret-color|accent-color/, '`caret-color`/`accent-color` are Firefox 53/92+'],
  [/(^|[;{\s])fit-content\b/, 'unprefixed `fit-content` is Firefox 94+'],
  [/@container/, 'container queries are Firefox 110+'],
  [/\b(dvh|svh|lvh)\b/, 'viewport-relative `dvh`/`svh`/`lvh` are Firefox 101+'],
  [/(^|\n)\s*&[\s:.[#>]/, 'CSS nesting is Firefox 117+'],
];

for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8');
  for (const [pattern, reason] of CSS_RULES) {
    if (pattern.test(css)) {
      fail('css', `${relative(file)} — ${reason}`);
    }
  }
}

/* --- Manifest ------------------------------------------------------------ */

const manifestFile = path.join(DIST, 'manifest.webapp');
const sourceManifest = 'manifest.webapp';

if (!existsSync(manifestFile)) {
  fail('manifest', 'dist/manifest.webapp is missing');
} else {
  const raw = readFileSync(manifestFile, 'utf8');

  if (existsSync(sourceManifest) && raw !== readFileSync(sourceManifest, 'utf8')) {
    fail('manifest', 'dist/manifest.webapp does not match the manifest in the repo root');
  }

  let manifest = null;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail('manifest', `dist/manifest.webapp is not valid JSON — ${error.message}`);
  }

  if (manifest) {
    if (!existsSync(distPathForUrl(manifest.launch_path || ''))) {
      fail('manifest', `launch_path "${manifest.launch_path}" does not exist in the package`);
    }
    for (const [size, icon] of Object.entries(manifest.icons || {})) {
      if (!existsSync(distPathForUrl(icon))) {
        fail('manifest', `icon ${size} ("${icon}") does not exist in the package`);
      }
    }
    if (!manifest.permissions || !manifest.permissions.systemXHR) {
      note('manifest', 'systemXHR is not requested; privileged XHR will fall back to CORS');
    }
  }
}

/* --- Report -------------------------------------------------------------- */

const bundle = path.join(DIST, 'js', 'app.js');
if (existsSync(bundle)) {
  const bytes = readFileSync(bundle);
  note(
    'size',
    `js/app.js ${(bytes.length / 1024).toFixed(1)} kB (${(gzipSync(bytes).length / 1024).toFixed(1)} kB gzip)`,
  );
}
note('target', `${KAIOS_BROWSERSLIST} — compiled by Babel for Gecko 48`);
note('files', `${files.length} files in the package`);

for (const item of findings) {
  console.log(`  ${item.check.padEnd(9)} ${item.message}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) would break the app on Gecko 48:\n`);
  for (const item of failures) {
    console.error(`  [${item.check}] ${item.message}`);
  }
  process.exit(1);
}

console.log('\nlegacy check passed: the bundle parses as ES2015 and packages cleanly.');
