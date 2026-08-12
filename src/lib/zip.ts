/**
 * Minimal store-only ZIP writer.
 *
 * Frames are already-compressed PNG/JPEG/WebP, so deflating them would burn
 * phone CPU for ~0% gain. Storing keeps the writer to a hundred lines with no
 * dependencies, and stays fast enough to run on the main thread between yields.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20;

/** ZIP stores 32-bit sizes; beyond this we would need Zip64. */
export const MAX_ZIP_BYTES = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly date?: Date;
}

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

/** CRC-32 (IEEE) of `bytes`, returned as an unsigned 32-bit value. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Encode a Date into the DOS time/date pair ZIP headers use. */
export function toDosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  // DOS epoch starts in 1980 and cannot represent anything earlier.
  const safeYear = year < 1980 ? 1980 : Math.min(year, 2107);
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = ((safeYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

class ByteWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  pushHeader(values: ReadonlyArray<readonly [size: 2 | 4, value: number]>): void {
    const size = values.reduce((sum, [width]) => sum + width, 0);
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);
    let cursor = 0;
    for (const [width, value] of values) {
      if (width === 2) {
        view.setUint16(cursor, value & 0xffff, true);
      } else {
        view.setUint32(cursor, value >>> 0, true);
      }
      cursor += width;
    }
    this.push(buffer);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let cursor = 0;
    for (const part of this.parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }
}

/**
 * Build a ZIP archive containing `entries`.
 * Throws if the result would exceed the 4 GB limit of the non-Zip64 format.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const body = new ByteWriter();
  const central = new ByteWriter();

  const totalPayload = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (totalPayload > MAX_ZIP_BYTES) {
    throw new RangeError('Archive too large for ZIP format — export in smaller batches.');
  }

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { time, date } = toDosDateTime(entry.date ?? new Date());
    const localOffset = body.offset;

    body.pushHeader([
      [4, LOCAL_SIG],
      [2, VERSION],
      [2, UTF8_FLAG],
      [2, 0],
      [2, time],
      [2, date],
      [4, crc],
      [4, size],
      [4, size],
      [2, nameBytes.length],
      [2, 0],
    ]);
    body.push(nameBytes);
    body.push(entry.data);

    central.pushHeader([
      [4, CENTRAL_SIG],
      [2, VERSION],
      [2, VERSION],
      [2, UTF8_FLAG],
      [2, 0],
      [2, time],
      [2, date],
      [4, crc],
      [4, size],
      [4, size],
      [2, nameBytes.length],
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, localOffset],
    ]);
    central.push(nameBytes);
  }

  const centralOffset = body.offset;
  const centralBytes = central.concat();

  const out = new ByteWriter();
  out.push(body.concat());
  out.push(centralBytes);
  out.pushHeader([
    [4, EOCD_SIG],
    [2, 0],
    [2, 0],
    [2, entries.length],
    [2, entries.length],
    [4, centralBytes.length],
    [4, centralOffset],
    [2, 0],
  ]);

  return out.concat();
}
