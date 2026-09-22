/**
 * No-reference sharpness score for a single frame.
 *
 * Implements the blur metric of Crété, Dolmière, Ladret and Nicolas, "The blur
 * effect: perception and estimation with a new no-reference perceptual blur
 * metric", Proc. SPIE 6492, Human Vision and Electronic Imaging XII (2007),
 * section 2.4, equations (1)–(6). The frame is re-blurred with a strong 9-tap
 * averaging filter along each axis; a frame that was already blurry loses
 * little neighbour-to-neighbour variation when blurred again, a sharp one loses
 * a lot. The paper's result runs 0 (sharp) to 1 (blurred) and takes the worse
 * of the two axes, so blur along either direction — motion blur included —
 * pulls the score down.
 *
 * Each frame is judged only against a blurred copy of itself, so its score
 * never depends on which other frames happen to be in the gallery.
 *
 * scikit-image's `blur_effect` cites the same paper but swaps the absolute
 * neighbour differences for Sobel gradients and uses an 11-tap filter; this
 * follows the paper as published instead, with one addition: a 3×3 median on
 * the luma first. The paper counts additive noise as sharpness (section 2.2),
 * which lets a grainy, out-of-focus low-light frame outscore a clean sharp
 * one. The median removes pixel-level grain while leaving edges — and so the
 * blur the metric is measuring — in place.
 */

import type { RGBAImage } from './detect.js';

/** Length of the paper's re-blurring filter, h_v = 1/9 · [1 1 1 1 1 1 1 1 1]. */
export const BLUR_TAPS = 9;

/**
 * Longest edge the metric is measured at.
 *
 * The metric is scale-dependent — shrinking a frame hides blur — so it runs at
 * one fixed size regardless of the output-size setting. Otherwise switching
 * the export size from Full to 720 would change every score.
 */
export const SHARPNESS_MAX_EDGE = 1024;

/** Paper's blur_F for one image, in [0, 1]; `null` when there is no variation to judge. */
export function blurEffect(image: RGBAImage): number | null {
  const { width, height, data } = image;
  if (width < 2 || height < 2) return null;

  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    luma[i] = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
  }

  const smoothed = median3x3(luma, width, height);
  const vertical = axisBlur(smoothed, height, width, width, 1);
  const horizontal = axisBlur(smoothed, width, height, 1, width);
  if (vertical === null && horizontal === null) return null;
  return Math.max(vertical ?? 0, horizontal ?? 0);
}

/** 3×3 median, edge samples repeated past the border. */
function median3x3(src: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(src.length);
  const p = new Float32Array(9);
  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1) * width;
    const mid = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const l = x > 0 ? x - 1 : 0;
      const r = x < width - 1 ? x + 1 : x;
      p[0] = src[up + l]!; p[1] = src[up + x]!; p[2] = src[up + r]!;
      p[3] = src[mid + l]!; p[4] = src[mid + x]!; p[5] = src[mid + r]!;
      p[6] = src[down + l]!; p[7] = src[down + x]!; p[8] = src[down + r]!;
      out[mid + x] = median9(p);
    }
  }
  return out;
}

/**
 * Median of nine values with a fixed 19-exchange network (the `opt_med9`
 * network in N. Devillard, "Fast median search: an ANSI C implementation",
 * 1998). Reorders `p` in place.
 */
function median9(p: Float32Array): number {
  const sort = (a: number, b: number): void => {
    if (p[a]! > p[b]!) {
      const t = p[a]!;
      p[a] = p[b]!;
      p[b] = t;
    }
  };
  sort(1, 2); sort(4, 5); sort(7, 8); sort(0, 1); sort(3, 4); sort(6, 7);
  sort(1, 2); sort(4, 5); sort(7, 8); sort(0, 3); sort(5, 8); sort(4, 7);
  sort(3, 6); sort(1, 4); sort(2, 5); sort(4, 7); sort(4, 2); sort(6, 4);
  sort(4, 2);
  return p[4]!;
}

/**
 * b_F along one axis (equations 1–5).
 *
 * The image is walked as `lines` independent lines of `length` samples, where
 * consecutive samples along the axis are `step` apart and consecutive lines
 * are `stride` apart — so one routine covers both the vertical pass (columns)
 * and the horizontal pass (rows).
 *
 * The paper does not say how the filter treats the border; samples past the
 * edge repeat the edge value. Its sums start at index 1 on both axes, so the
 * first line is excluded, as in equation (4).
 */
function axisBlur(
  luma: Float32Array,
  length: number,
  lines: number,
  step: number,
  stride: number,
): number | null {
  const half = (BLUR_TAPS - 1) / 2;
  const padded = new Float32Array(length + 2 * half);
  let sumF = 0;
  let sumV = 0;

  for (let line = 1; line < lines; line += 1) {
    const base = line * stride;
    for (let k = 0; k < length; k += 1) padded[half + k] = luma[base + k * step]!;
    for (let k = 0; k < half; k += 1) {
      padded[k] = padded[half]!;
      padded[half + length + k] = padded[half + length - 1]!;
    }

    let window = 0;
    for (let k = 0; k < BLUR_TAPS; k += 1) window += padded[k]!;
    let prevB = window / BLUR_TAPS;
    for (let k = 1; k < length; k += 1) {
      window += padded[k + 2 * half]! - padded[k - 1]!;
      const b = window / BLUR_TAPS;
      const dF = Math.abs(padded[half + k]! - padded[half + k - 1]!);
      const dB = Math.abs(b - prevB);
      sumF += dF;
      if (dF > dB) sumV += dF - dB;
      prevB = b;
    }
  }

  if (sumF <= 0) return null;
  return (sumF - sumV) / sumF;
}

/** 0–100, higher is sharper; `null` for a frame with no detail at all (e.g. solid black). */
export function sharpnessScore(image: RGBAImage): number | null {
  const blur = blurEffect(image);
  return blur === null ? null : Math.round((1 - blur) * 100);
}

/**
 * Sharpest first; frames with no score go last. Ties keep time order, so a
 * burst of equally sharp frames still reads left to right.
 */
export function bySharpness<T extends { readonly time: number; readonly sharpness: number | null }>(
  frames: readonly T[],
): T[] {
  return [...frames].sort((a, b) => {
    if (a.sharpness === b.sharpness) return a.time - b.time;
    if (a.sharpness === null) return 1;
    if (b.sharpness === null) return -1;
    return b.sharpness - a.sharpness;
  });
}
