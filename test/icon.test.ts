import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  BACKGROUND,
  ICON_DIR,
  MASKABLE_SCALE,
  RASTER_ICONS,
  SHAPES,
  crc32,
  encodePng,
  iconSvg,
  rasterize,
} from '../scripts/icon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
}

/**
 * Walk every chunk and check its CRC. A PNG with a bad length or checksum
 * still starts with the right signature, and would be rejected by the phone
 * rather than by CI.
 */
function readChunks(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const typeAndData = png.subarray(offset + 4, offset + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    expect(view.getUint32(offset + 8 + length), `CRC of ${type}`).toBe(crc32(typeAndData));
    chunks.push({ type, data: typeAndData.subarray(4) });
    offset += 12 + length;
  }
  expect(offset).toBe(png.length);
  return chunks;
}

const hex = (rgb: ArrayLike<number>): string =>
  `#${[...Array.from(rgb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function pixelAt(pixels: Uint8Array, size: number, u: number, v: number): string {
  const x = Math.floor((u / 100) * size);
  const y = Math.floor((v / 100) * size);
  return hex(pixels.subarray((y * size + x) * 3, (y * size + x) * 3 + 3));
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    // CRC-32/ISO-HDLC of the ASCII digits "123456789" is 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('encodePng', () => {
  it('writes a well-formed PNG whose pixels decode back unchanged', () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const chunks = readChunks(encodePng(pixels, 2, 2));
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    const ihdr = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset, 13);
    expect(ihdr.getUint32(0)).toBe(2);
    expect(ihdr.getUint32(4)).toBe(2);
    expect([...chunks[0]!.data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);

    const raw = inflateSync(chunks[1]!.data);
    // Each row: filter byte 0, then RGB.
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 10, 20, 30]);
  });
});

describe('rasterize', () => {
  const size = 200;
  const pixels = rasterize(size);

  it('fills the square edge to edge with the background', () => {
    for (const [u, v] of [[0, 0], [99.9, 0], [0, 99.9], [99.9, 99.9]] as const) {
      expect(pixelAt(pixels, size, u, v)).toBe(BACKGROUND);
    }
  });

  it('paints each facet and the frost mark in its own colour', () => {
    const fills = SHAPES.map((s) => s.fill);
    expect(pixelAt(pixels, size, 40, 50)).toBe(fills[0]); // left facet
    expect(pixelAt(pixels, size, 60, 42)).toBe(fills[1]); // upper facet
    expect(pixelAt(pixels, size, 60, 58)).toBe(fills[2]); // lower facet
    expect(pixelAt(pixels, size, 74, 24)).toBe('#22c98a'); // centre of the frost mark
  });

  it('keeps maskable artwork inside the circle every launcher mask contains', () => {
    const big = 256;
    const masked = rasterize(big, MASKABLE_SCALE);
    const bg = BACKGROUND;
    const safe = 0.4 * big;
    let painted = 0;
    for (let y = 0; y < big; y += 1) {
      for (let x = 0; x < big; x += 1) {
        const at = hex(masked.subarray((y * big + x) * 3, (y * big + x) * 3 + 3));
        if (at === bg) continue;
        painted += 1;
        expect(Math.hypot(x + 0.5 - big / 2, y + 0.5 - big / 2)).toBeLessThanOrEqual(safe);
      }
    }
    expect(painted).toBeGreaterThan(big * big * 0.05);
  });
});

describe('iconSvg', () => {
  it('draws the same shapes as the PNGs, on a rounded tile', () => {
    const svg = iconSvg();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">')).toBe(true);
    expect(svg).toContain(`<rect width="100" height="100" rx="22" fill="${BACKGROUND}"/>`);
    for (const shape of SHAPES) {
      expect(svg).toContain(shape.type === 'polygon' ? `fill="${shape.fill}"` : `stroke="${shape.fill}"`);
    }
    expect(svg.match(/<path /g)).toHaveLength(SHAPES.length);
  });
});

describe('committed icons', () => {
  const stale = 'out of date with scripts/icon.mjs — run `npm run icons`';

  it.each(RASTER_ICONS)('$file matches the icon geometry pixel for pixel', ({ file, size, scale }) => {
    const chunks = readChunks(new Uint8Array(readFileSync(resolve(root, ICON_DIR, file))));
    const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
    const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    expect([view.getUint32(0), view.getUint32(4)], `${file} size`).toEqual([size, size]);

    // Compare decoded pixels, not file bytes: the same pixels can deflate to
    // different bytes under a different zlib build.
    const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
    const raw = inflateSync(idat);
    const stride = size * 3;
    const committed = new Uint8Array(size * stride);
    for (let y = 0; y < size; y += 1) {
      expect(raw[y * (stride + 1)], `${file} row ${y} filter`).toBe(0);
      committed.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
    }
    expect(Buffer.compare(committed, rasterize(size, scale)), `${file} is ${stale}`).toBe(0);
    // Redrawing a 512 px icon with 16 samples per pixel takes seconds, more on a
    // loaded CI runner; the default 5 s would make this check flaky, not stricter.
  }, 30_000);

  it('has an SVG favicon drawn from the same geometry', () => {
    expect(readFileSync(resolve(root, ICON_DIR, 'icon.svg'), 'utf8'), `icon.svg is ${stale}`).toBe(iconSvg());
  });
});

describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/manifest.webmanifest'), 'utf8')) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  const html = readFileSync(resolve(root, 'src/index.html'), 'utf8');

  it('names the app and opens it standalone', () => {
    expect(manifest.name).toBe('GitFrame');
    expect(manifest.short_name).toBe('GitFrame');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('only references icons that ship, at their real size', () => {
    for (const icon of manifest.icons) {
      const built = RASTER_ICONS.find((r) => `/${r.file}` === icon.src);
      expect(built, icon.src).toBeDefined();
      expect(icon.sizes).toBe(`${built!.size}x${built!.size}`);
      expect(icon.type).toBe('image/png');
      expect(icon.purpose === 'maskable').toBe(built!.scale < 1);
    }
  });

  it('offers the sizes Android asks for, including a maskable one', () => {
    const any = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('matches the page it belongs to', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(manifest.theme_color).toBe(/name="theme-color" content="([^"]+)"/.exec(html)?.[1]);
    expect(manifest.background_color).toBe(BACKGROUND);
  });

  it('gives iOS its own full-bleed icon, which ships', () => {
    const href = /<link rel="apple-touch-icon" href="\/([^"]+)"/.exec(html)?.[1];
    const built = RASTER_ICONS.find((r) => r.file === href);
    expect(built).toEqual({ file: 'apple-touch-icon.png', size: 180, scale: 1 });
  });
});
