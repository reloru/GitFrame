import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { type BlobLike, readFrameTiming } from '../src/lib/mp4.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* ------------------------------------------------------------------ */
/* A tiny box writer, so each case states exactly the bytes it tests.  */
/* ------------------------------------------------------------------ */

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number): number[] => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

function mdhd(timescale: number, version: 0 | 1 = 0): number[] {
  return version === 1
    ? box('mdhd', [1, 0, 0, 0], u64(0), u64(0), u32(timescale), u64(0), [0, 0, 0, 0])
    : box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(0), [0, 0, 0, 0]);
}

const hdlr = (handler: string): number[] => box('hdlr', [0, 0, 0, 0], u32(0), ascii(handler), u32(0), u32(0), u32(0), [0]);

function stts(runs: ReadonlyArray<readonly [number, number]>): number[] {
  return box('stts', [0, 0, 0, 0], u32(runs.length), ...runs.map(([count, delta]) => [...u32(count), ...u32(delta)]));
}

function trak(handler: string, timescale: number, runs: ReadonlyArray<readonly [number, number]>, version: 0 | 1 = 0): number[] {
  return box('trak', box('mdia', mdhd(timescale, version), hdlr(handler), box('minf', box('stbl', stts(runs)))));
}

const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2mp41'));

/** A Blob stand-in that records which byte ranges were read. */
function fakeFile(bytes: number[], size = bytes.length): BlobLike & { reads: Array<[number, number]> } {
  const data = new Uint8Array(bytes);
  const reads: Array<[number, number]> = [];
  return {
    size,
    reads,
    slice(start: number, end: number) {
      reads.push([start, end]);
      return { arrayBuffer: async () => data.slice(start, end).buffer };
    },
  };
}

function fixture(name: string): BlobLike {
  return new Blob([readFileSync(resolve(fixtures, name))]);
}

describe('readFrameTiming', () => {
  it('reads an NTSC rate exactly from the timescale and frame duration', async () => {
    const file = fakeFile([...ftyp, ...box('moov', trak('vide', 30000, [[60, 1001]]))]);
    expect(await readFrameTiming(file)).toEqual({ fps: 30000 / 1001, constant: true, frames: 60 });
  });

  it('finds moov after the video data without reading the video data', async () => {
    const mdat = box('mdat', new Array<number>(5000).fill(0));
    const file = fakeFile([...ftyp, ...mdat, ...box('moov', trak('vide', 600, [[240, 5]]))]);
    expect((await readFrameTiming(file))?.fps).toBe(120);
    const readBytes = file.reads.reduce((n, [a, b]) => n + (b - a), 0);
    expect(readBytes).toBeLessThan(500);
  });

  it('follows a 64-bit box size past a large mdat', async () => {
    const payload = new Array<number>(40).fill(0);
    const mdat64 = [...u32(1), ...ascii('mdat'), ...u64(16 + payload.length), ...payload];
    const file = fakeFile([...ftyp, ...mdat64, ...box('moov', trak('vide', 90000, [[10, 3000]]))]);
    expect((await readFrameTiming(file))?.fps).toBe(30);
  });

  it('treats a size of zero as running to the end of the file', async () => {
    const moov = box('moov', trak('vide', 24, [[24, 1]]));
    moov.splice(0, 4, ...u32(0));
    expect((await readFrameTiming(fakeFile([...ftyp, ...moov])))?.fps).toBe(24);
  });

  it('reads a version 1 media header', async () => {
    const file = fakeFile(box('moov', trak('vide', 48000, [[10, 200]], 1)));
    expect((await readFrameTiming(file))?.fps).toBe(240);
  });

  it('skips audio tracks to find the video track', async () => {
    const moov = box('moov', trak('soun', 44100, [[100, 1024]]), trak('vide', 25, [[50, 1]]));
    expect((await readFrameTiming(fakeFile(moov)))?.fps).toBe(25);
  });

  it('reports the dominant rate, and flags a clip whose frame durations vary', async () => {
    const steady = await readFrameTiming(fakeFile(box('moov', trak('vide', 600, [[95, 10], [5, 11]]))));
    expect(steady).toEqual({ fps: 60, constant: true, frames: 100 });
    const uneven = await readFrameTiming(fakeFile(box('moov', trak('vide', 600, [[60, 10], [20, 30]]))));
    expect(uneven).toEqual({ fps: 60, constant: false, frames: 80 });
  });

  it('returns null when there is no timing to read', async () => {
    const cases = [
      box('moov', trak('soun', 44100, [[100, 1024]])), // no video track
      box('moov', trak('vide', 30, [])), // fragmented: timing lives in moof
      box('moov', trak('vide', 0, [[10, 1]])), // no timescale
      [...ftyp, ...box('mdat', [1, 2, 3])], // no moov at all
      [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0], // WebM / Matroska
      [...ftyp.slice(0, 6)], // truncated
    ];
    for (const bytes of cases) expect(await readFrameTiming(fakeFile(bytes))).toBeNull();
  });

  it('refuses a moov too large to be real rather than loading it', async () => {
    const size = 200 * 1024 * 1024;
    const huge = fakeFile([...u32(size), ...ascii('moov')], size);
    expect(await readFrameTiming(huge)).toBeNull();
    // Only the header was read; the claimed 200 MB never was.
    expect(huge.reads).toEqual([[0, 16]]);
  });

  it('returns null rather than throwing when reading fails', async () => {
    const broken: BlobLike = {
      size: 100,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    };
    expect(await readFrameTiming(broken)).toBeNull();
  });

  describe('on files written by ffmpeg', () => {
    it('reads 29.97 fps from an MP4 with its index up front', async () => {
      const timing = await readFrameTiming(fixture('fps29.97-faststart.mp4'));
      expect(timing?.fps).toBeCloseTo(29.97003, 5);
      expect(timing).toMatchObject({ constant: true, frames: 60 });
    });

    it('reads 240 fps from a QuickTime file with its index after the video data', async () => {
      expect(await readFrameTiming(fixture('fps240-moov-at-end.mov'))).toEqual({ fps: 240, constant: true, frames: 480 });
    });

    it('flags a variable-rate recording', async () => {
      // 60 fps for a second, then every third frame kept.
      expect(await readFrameTiming(fixture('variable-rate.mp4'))).toEqual({ fps: 60, constant: false, frames: 80 });
    });
  });
});
