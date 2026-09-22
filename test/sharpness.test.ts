import { describe, expect, it } from 'vitest';

import type { RGBAImage } from '../src/lib/detect.js';
import { blurEffect, bySharpness, sharpnessScore } from '../src/lib/sharpness.js';

const W = 64;
const H = 48;

function grey(values: readonly number[], width = W, height = H): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  values.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  return { data, width, height };
}

/** A deterministic, detailed test card. */
function pattern(): number[] {
  const out: number[] = [];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) out.push((x * x * 3 + y * 5 + x * y) % 251);
  return out;
}

/** Integer 3×3 box blur with edge replication. */
function box3(src: readonly number[]): number[] {
  const at = (x: number, y: number): number =>
    src[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]!;
  const out: number[] = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += at(x + dx, y + dy);
      out.push(Math.floor(sum / 9));
    }
  }
  return out;
}

/** Blur along x only — a stand-in for horizontal motion blur. */
function smearX(src: readonly number[], taps: number): number[] {
  const half = Math.floor(taps / 2);
  const out: number[] = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let sum = 0;
      for (let k = -half; k <= half; k += 1) sum += src[y * W + Math.min(W - 1, Math.max(0, x + k))]!;
      out.push(Math.round(sum / taps));
    }
  }
  return out;
}

describe('blurEffect', () => {
  // Expected values come from an independent NumPy/SciPy implementation of
  // the paper's equations (1)–(6) with the same 3×3 median prefilter,
  // written with explicit whole-array operations rather than running sums.
  it('matches the reference implementation', () => {
    const sharp = pattern();
    const once = box3(sharp);
    const thrice = box3(box3(once));
    expect(blurEffect(grey(sharp))).toBeCloseTo(0.164954048588178, 6);
    expect(blurEffect(grey(once))).toBeCloseTo(0.20912776462088067, 6);
    expect(blurEffect(grey(thrice))).toBeCloseTo(0.30998318963179866, 6);
  });

  it('rises as the same picture gets blurrier', () => {
    const a = pattern();
    const b = box3(a);
    const c = box3(b);
    const d = box3(c);
    const scores = [a, b, c, d].map((img) => blurEffect(grey(img))!);
    for (let i = 1; i < scores.length; i += 1) expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
  });

  it('catches blur along one axis only, as motion blur is', () => {
    const sharp = blurEffect(grey(pattern()))!;
    const smeared = blurEffect(grey(smearX(pattern(), 9)))!;
    expect(smeared).toBeGreaterThan(sharp + 0.1);
  });

  it('ignores colour and reads luma', () => {
    const values = pattern();
    const data = new Uint8ClampedArray(W * H * 4);
    values.forEach((v, i) => {
      // Same luma as grey(v) to within rounding, carried mostly by green.
      data[i * 4] = 0;
      data[i * 4 + 1] = Math.min(255, Math.round(v / 0.587));
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    });
    const coloured = blurEffect({ data, width: W, height: H })!;
    // Clamping at 255 flattens the brightest greens, so allow a little drift.
    expect(Math.abs(coloured - blurEffect(grey(values))!)).toBeLessThan(0.05);
  });

  it('has nothing to judge on a flat frame', () => {
    expect(blurEffect(grey(new Array<number>(W * H).fill(0)))).toBeNull();
    expect(blurEffect(grey(new Array<number>(W * H).fill(128)))).toBeNull();
  });

  it('has nothing to judge on a frame too small for a neighbour', () => {
    expect(blurEffect(grey([10, 200], 2, 1))).toBeNull();
    expect(blurEffect(grey([10, 200], 1, 2))).toBeNull();
  });

  it('still scores detail that runs along one axis only', () => {
    // Horizontal bands: no variation along x at all, plenty along y.
    const bands: number[] = [];
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) bands.push(Math.floor(y / 2) % 2 === 0 ? 20 : 235);
    expect(blurEffect(grey(bands))).not.toBeNull();
  });

  it('does not let grain on a soft frame pass it off as sharp', () => {
    // Salt-and-pepper speckle on every 7th pixel — the isolated noise the
    // median is there to remove before the metric sees it.
    const sharp = blurEffect(grey(pattern()))!;
    const soft = box3(box3(pattern()));
    const speckled = soft.map((v, i) => (i % 7 === 0 ? (v > 127 ? 0 : 255) : v));
    expect(blurEffect(grey(speckled))!).toBeGreaterThan(sharp);
  });
});

describe('sharpnessScore', () => {
  it('turns blur into a 0–100 score where higher is sharper', () => {
    expect(sharpnessScore(grey(pattern()))).toBe(84);
    expect(sharpnessScore(grey(box3(box3(box3(pattern())))))).toBe(69);
  });

  it('passes through "no score"', () => {
    expect(sharpnessScore(grey(new Array<number>(W * H).fill(40)))).toBeNull();
  });
});

describe('bySharpness', () => {
  const f = (time: number, sharpness: number | null) => ({ time, sharpness });

  it('puts the sharpest first and unscored frames last', () => {
    const ordered = bySharpness([f(1, 40), f(2, null), f(3, 90), f(4, 65)]);
    expect(ordered.map((x) => x.time)).toEqual([3, 4, 1, 2]);
  });

  it('keeps time order among equal scores, scored or not', () => {
    const ordered = bySharpness([f(5, 70), f(2, null), f(1, 70), f(0, null)]);
    expect(ordered.map((x) => x.time)).toEqual([1, 5, 0, 2]);
  });

  it('does not reorder its input', () => {
    const input = [f(1, 10), f(2, 90)];
    bySharpness(input);
    expect(input.map((x) => x.time)).toEqual([1, 2]);
  });
});
