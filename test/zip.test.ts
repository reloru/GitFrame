import { describe, expect, it } from 'vitest';

import { MAX_ZIP_BYTES, buildZip, crc32, toDosDateTime } from '../src/lib/zip.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Read a little-endian unsigned integer out of the archive. */
function readUint(data: Uint8Array, offset: number, width: 2 | 4): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return width === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
}

describe('crc32', () => {
  it('matches the published checksums', () => {
    expect(crc32(bytes('')) >>> 0).toBe(0);
    // The canonical CRC-32 test vector.
    expect(crc32(bytes('123456789')) >>> 0).toBe(0xcbf43926);
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339);
  });

  it('is sensitive to a single flipped byte', () => {
    expect(crc32(bytes('hello'))).not.toBe(crc32(bytes('hellp')));
  });

  it('stays unsigned for high-bit results', () => {
    for (const sample of ['a', 'ab', 'abc', 'abcd', 'zzzzzzzzzz']) {
      expect(crc32(bytes(sample))).toBeGreaterThanOrEqual(0);
      expect(crc32(bytes(sample))).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('toDosDateTime', () => {
  it('encodes a date into the DOS pair', () => {
    const { time, date } = toDosDateTime(new Date(2024, 4, 17, 13, 45, 30));
    expect(date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it('clamps dates outside the DOS range', () => {
    expect(toDosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
    expect(toDosDateTime(new Date(2200, 0, 1)).date >> 9).toBe(2107 - 1980);
  });
});

describe('buildZip', () => {
  const fixed = new Date(2024, 0, 2, 3, 4, 6);

  it('produces a structurally valid archive', () => {
    const zip = buildZip([
      { name: 'a.txt', data: bytes('hello'), date: fixed },
      { name: 'b.txt', data: bytes('world!'), date: fixed },
    ]);

    // Local file header signature at the very start.
    expect(readUint(zip, 0, 4)).toBe(0x04034b50);

    // End-of-central-directory sits in the last 22 bytes.
    const eocd = zip.length - 22;
    expect(readUint(zip, eocd, 4)).toBe(0x06054b50);
    expect(readUint(zip, eocd + 8, 2)).toBe(2);
    expect(readUint(zip, eocd + 10, 2)).toBe(2);

    // The central directory offset it advertises must land on a central header.
    const centralOffset = readUint(zip, eocd + 16, 4);
    expect(readUint(zip, centralOffset, 4)).toBe(0x02014b50);

    // And its declared size must reach exactly the EOCD record.
    const centralSize = readUint(zip, eocd + 12, 4);
    expect(centralOffset + centralSize).toBe(eocd);
  });

  it('stores payloads uncompressed with correct sizes and checksums', () => {
    const payload = bytes('hello');
    const zip = buildZip([{ name: 'a.txt', data: payload, date: fixed }]);

    expect(readUint(zip, 8, 2)).toBe(0); // compression method: store
    expect(readUint(zip, 14, 4)).toBe(crc32(payload));
    expect(readUint(zip, 18, 4)).toBe(payload.length); // compressed
    expect(readUint(zip, 22, 4)).toBe(payload.length); // uncompressed

    const nameLength = readUint(zip, 26, 2);
    expect(nameLength).toBe(5);
    const dataStart = 30 + nameLength;
    expect(zip.slice(dataStart, dataStart + payload.length)).toEqual(payload);
  });

  it('flags names as UTF-8 and round-trips non-ASCII', () => {
    const zip = buildZip([{ name: 'café-☕.jpg', data: bytes('x'), date: fixed }]);
    expect(readUint(zip, 6, 2) & 0x0800).toBe(0x0800);

    const nameLength = readUint(zip, 26, 2);
    const name = new TextDecoder().decode(zip.slice(30, 30 + nameLength));
    expect(name).toBe('café-☕.jpg');
  });

  it('points each central directory entry at its local header', () => {
    const zip = buildZip([
      { name: 'one.bin', data: bytes('1111'), date: fixed },
      { name: 'two.bin', data: bytes('22'), date: fixed },
    ]);
    const eocd = zip.length - 22;
    const centralOffset = readUint(zip, eocd + 16, 4);

    const firstLocal = readUint(zip, centralOffset + 42, 4);
    expect(firstLocal).toBe(0);
    expect(readUint(zip, firstLocal, 4)).toBe(0x04034b50);

    const firstNameLength = readUint(zip, centralOffset + 28, 2);
    const secondCentral = centralOffset + 46 + firstNameLength;
    const secondLocal = readUint(zip, secondCentral + 42, 4);
    expect(readUint(zip, secondLocal, 4)).toBe(0x04034b50);
  });

  it('handles an empty archive', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(readUint(zip, 0, 4)).toBe(0x06054b50);
  });

  it('defaults the timestamp when none is given', () => {
    const zip = buildZip([{ name: 'a', data: bytes('x') }]);
    expect(zip.length).toBeGreaterThan(22);
  });

  it('refuses archives beyond the 32-bit size limit', () => {
    const huge = { name: 'big', data: { length: MAX_ZIP_BYTES + 1 } as unknown as Uint8Array };
    expect(() => buildZip([huge])).toThrow(RangeError);
  });
});
