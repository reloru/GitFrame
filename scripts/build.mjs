#!/usr/bin/env node
/** Bundles the client into dist/client, which the Worker serves as static assets. */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist/client');

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10" fill="#0b0f14"/>
  <rect x="7" y="13" width="24" height="22" rx="3" fill="none" stroke="#3d8bff" stroke-width="3"/>
  <path d="M33 21l8-5v16l-8-5z" fill="#22c98a"/>
  <circle cx="15" cy="21" r="2.5" fill="#3d8bff"/>
</svg>
`;

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
await writeFile(resolve(outDir, 'icon.svg'), ICON, 'utf8');

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`built dist/client — app.js ${(bytes / 1024).toFixed(1)} kB`);
