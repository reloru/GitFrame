#!/usr/bin/env node
/** Bundles the client into dist/client, which the Worker serves as static assets. */

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ICON_DIR } from './icon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist/client');

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
await cp(resolve(root, ICON_DIR), outDir, { recursive: true });

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`built dist/client — app.js ${(bytes / 1024).toFixed(1)} kB`);
