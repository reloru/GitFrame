#!/usr/bin/env node
/**
 * Regenerates the committed icons in src/icons from the geometry in icon.mjs.
 * Run after changing the icon; test/icon.test.ts fails until you do.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_DIR, RASTER_ICONS, encodePng, iconSvg, rasterize } from './icon.mjs';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', ICON_DIR);

await writeFile(resolve(dir, 'icon.svg'), iconSvg(), 'utf8');
for (const { file, size, scale } of RASTER_ICONS) {
  await writeFile(resolve(dir, file), encodePng(rasterize(size, scale), size, size));
}
console.log(`wrote icon.svg and ${RASTER_ICONS.length} PNGs to ${ICON_DIR}`);
