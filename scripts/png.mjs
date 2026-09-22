/**
 * Minimal PNG encoder for the build's icon generation.
 *
 * GitFrame ships no image tooling — there is no sharp, no ImageMagick, no
 * canvas polyfill — and adding one for three static icons would break the
 * zero-dependency rule for a build-time concern. Everything here is built on
 * `node:zlib`, which ships with Node.
 *
 * Only what the icons need: 8-bit RGBA, no interlacing, one IDAT.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/*
 * CRC-32 (IEEE, polynomial 0xEDB88320) — the same algorithm as crc32() in
 * src/lib/zip.ts, deliberately duplicated rather than shared. This file is a
 * plain .mjs build script and cannot import the TypeScript source without
 * adding a compile step for ten lines, and zlib.crc32() only exists from Node
 * 20.15/22.2 while package.json declares >=20.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, then a CRC over type+data. PNG is big-endian. */
function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body), false);
  return out;
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * Every scanline is prefixed with filter byte 0 (None). Filtering exists to
 * make the deflate step compress better; on flat-colour artwork like this icon
 * it earns almost nothing, so the simplest correct option wins.
 */
export function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('PNG dimensions must be positive integers');
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(
      `Expected ${width * height * 4} bytes of RGBA, received ${rgba.length}`,
    );
  }

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlacing

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}
