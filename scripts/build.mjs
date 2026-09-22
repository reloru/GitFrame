#!/usr/bin/env node
/** Bundles the client into dist/client, which the Worker serves as static assets. */

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ICON, ICON_TARGETS, drawIcon } from './icon.mjs';
import { encodePng } from './png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist/client');

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await build({
    entryPoints: [resolve(root, 'src/app/main.ts')],
    outfile: resolve(outDir, 'app.js'),
    bundle: true,
    format: 'esm',
    target: ['es2020', 'safari15'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
  });

  await cp(resolve(root, 'src/index.html'), resolve(outDir, 'index.html'));
  await cp(resolve(root, 'src/styles.css'), resolve(outDir, 'styles.css'));
  await cp(resolve(root, 'src/manifest.webmanifest'), resolve(outDir, 'manifest.webmanifest'));
  await writeFile(resolve(outDir, 'icon.svg'), ICON, 'utf8');

  for (const target of ICON_TARGETS) {
    const png = encodePng(drawIcon(target.size, target.glyphScale), target.size, target.size);
    await writeFile(resolve(outDir, target.name), png);
  }

  /*
   * The service worker's cache name is a digest of everything it serves. That
   * is what makes a deploy actually supersede the copy already on the phone:
   * a stale cache name would keep serving the old app forever.
   *
   * Written last, and hashed over every other output, so no shell file can
   * change without changing the name.
   */
  const shell = (await readdir(outDir)).sort();
  const digest = createHash('sha256');
  for (const name of shell) {
    digest.update(name);
    digest.update(await readFile(resolve(outDir, name)));
  }
  const version = digest.digest('hex').slice(0, 12);

  const sw = await readFile(resolve(root, 'src/sw.js'), 'utf8');
  if (!sw.includes('__CACHE_VERSION__')) {
    throw new Error('src/sw.js no longer contains the __CACHE_VERSION__ placeholder');
  }
  await writeFile(resolve(outDir, 'sw.js'), sw.replaceAll('__CACHE_VERSION__', version), 'utf8');

  const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
  console.log(`built dist/client — app.js ${(bytes / 1024).toFixed(1)} kB, cache ${version}`);
}

await main();
