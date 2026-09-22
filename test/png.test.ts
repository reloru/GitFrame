import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ICON_TARGETS, drawIcon } from '../scripts/icon.mjs';
import { crc32, encodePng } from '../scripts/png.mjs';

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly crcValid: boolean;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Walk a PNG's chunks, checking each declared CRC against a recomputed one.
 *
 * The point of parsing rather than spot-checking bytes: a PNG with a wrong
 * length or CRC still "looks like" a PNG at offset 0, and would be rejected by
 * the phone rather than by us.
 */
function parsePng(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let cursor = SIGNATURE.length;

  while (cursor < bytes.length) {
    const length = view.getUint32(cursor, false);
    const type = new TextDecoder().decode(bytes.subarray(cursor + 4, cursor + 8));
    const data = bytes.subarray(cursor + 8, cursor + 8 + length);
    const declared = view.getUint32(cursor + 8 + length, false);
    chunks.push({
      type,
      data,
      crcValid: crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) === declared,
    });
    cursor += 12 + length;
  }
  return chunks;
}

describe('encodePng', () => {
  const width = 3;
  const height = 2;
  const pixels = new Uint8Array(width * height * 4).map((_, i) => (i * 7) % 256);

  it('emits a well-formed PNG with valid chunk CRCs', () => {
    const png = encodePng(pixels, width, height);

    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);

    const chunks = parsePng(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
  });

  it('declares the dimensions and colour format it was given', () => {
    const [ihdr] = parsePng(encodePng(pixels, width, height));
    const view = new DataView(ihdr!.data.buffer, ihdr!.data.byteOffset, ihdr!.data.byteLength);
    expect(view.getUint32(0, false)).toBe(width);
    expect(view.getUint32(4, false)).toBe(height);
    expect(ihdr!.data[8]).toBe(8); // bit depth
    expect(ihdr!.data[9]).toBe(6); // RGBA
    expect(ihdr!.data[12]).toBe(0); // not interlaced
  });

  it('round-trips the pixels through the deflate stream', () => {
    const chunks = parsePng(encodePng(pixels, width, height));
    const raw = new Uint8Array(inflateSync(chunks[1]!.data));

    // Each scanline is the filter byte 0 followed by that row's RGBA.
    const stride = width * 4;
    for (let y = 0; y < height; y += 1) {
      expect(raw[y * (stride + 1)]).toBe(0);
      expect([...raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))]).toEqual([
        ...pixels.subarray(y * stride, (y + 1) * stride),
      ]);
    }
  });

  it('refuses input that does not describe the stated image', () => {
    expect(() => encodePng(new Uint8Array(3), 2, 2)).toThrow(RangeError);
    expect(() => encodePng(new Uint8Array(0), 0, 4)).toThrow(RangeError);
    expect(() => encodePng(new Uint8Array(16), 1.5, 4)).toThrow(RangeError);
  });
});

describe('drawIcon', () => {
  it('fills every pixel opaquely', () => {
    // Small sizes on purpose: the artwork is resolution-independent, and
    // rendering 512x512 at 4x supersampling costs seconds on every CI run for
    // no extra signal. The shipped sizes are rendered by the build itself.
    for (const size of [24, 48]) {
      for (const target of ICON_TARGETS) {
        const rgba = drawIcon(size, target.glyphScale);
        expect(rgba).toHaveLength(size * size * 4);
        // A transparent pixel would show as a hole once iOS masks the corners.
        for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
      }
    }
  });

  it('ships an iOS icon and two maskable Android icons', () => {
    expect(ICON_TARGETS.map((target: { name: string }) => target.name)).toEqual([
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
    ]);
    // iOS masks the corners itself, so its icon runs to the edges; Android
    // crops harder, so those stay inside the safe zone.
    const [ios, ...android] = ICON_TARGETS as Array<{ glyphScale: number }>;
    expect(ios!.glyphScale).toBe(1);
    for (const target of android) expect(target.glyphScale).toBeLessThan(1);
  });

  it('draws the artwork, not a flat square', () => {
    const size = 64;
    const rgba = drawIcon(size, 1);
    const colours = new Set<string>();
    for (let i = 0; i < rgba.length; i += 4) {
      colours.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
    }
    // Background, blue body, green wedge, plus antialiased blends between them.
    expect(colours.size).toBeGreaterThan(3);
    expect(colours).toContain('11,15,20');
  });

  it('keeps a maskable icon clear of the corners Android crops', () => {
    const size = 64;
    const rgba = drawIcon(size, 0.85);
    const corner = (x: number, y: number): string => {
      const at = (y * size + x) * 4;
      return `${rgba[at]},${rgba[at + 1]},${rgba[at + 2]}`;
    };
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      expect(corner(x!, y!)).toBe('11,15,20');
    }
  });
});
