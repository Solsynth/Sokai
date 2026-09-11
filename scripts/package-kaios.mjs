#!/usr/bin/env node
/**
 * Packages `dist/` as a KaiOS app ZIP.
 *
 * Two packaging rules matter and both are silent failures if broken:
 *  - `manifest.webapp` must sit at the ZIP root, with no wrapping directory,
 *    or the device and the store treat the archive as an arbitrary zip.
 *  - the archive must not contain build-time artefacts; source maps in
 *    particular are pure weight on a 256MB phone.
 *
 * Signing is out of scope: sideloading through WebIDE accepts an unsigned
 * package, and store submission is signed by KaiOS.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const OUT_DIR = path.resolve('build');
const EXCLUDES = ['*.map', '.DS_Store'];

const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.webapp'), 'utf8'));
const archiveName = `sokai-${manifest.version}.zip`;
const archive = path.join(OUT_DIR, archiveName);

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

try {
  run('zip', ['--version']);
} catch {
  console.error('The `zip` command is required to package the app (present on macOS and most Linux).');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
rmSync(archive, { force: true });

// `-X` drops extra file attributes; `-r` recurses; `-x` prunes build artefacts.
run('zip', ['-rX', archive, '.', '-x', ...EXCLUDES], { cwd: DIST });

const entries = run('unzip', ['-Z1', archive]).trim().split('\n');

if (!entries.includes('manifest.webapp')) {
  console.error('manifest.webapp is not at the ZIP root — the app will not be recognised.');
  process.exit(1);
}

const size = statSync(archive).size;
console.log(`  archive  build/${archiveName}`);
console.log(`  size     ${(size / 1024).toFixed(1)} kB`);
console.log(`  entries  ${entries.length}`);
console.log(`  manifest manifest.webapp (root), version ${manifest.version}`);
