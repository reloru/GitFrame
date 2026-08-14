/**
 * Turn several single-frame void detections into one crop for a whole clip.
 *
 * detectVoidsAuto() answers "where are the blank bands in this ONE still
 * image" — a different question from "where are the bands in this video".
 * Detecting per-frame and cropping to whatever one frame says would make the
 * crop jitter, and a single dark frame or a fade to black would wreck it.
 */

import { cropRect, type CropRect, type Side, type VoidResultAuto } from './detect.js';

const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];

export interface ConsensusCrop {
  /** Null when nothing should be trimmed — either no bars found, or no usable samples. */
  readonly crop: CropRect | null;
  readonly hasVoid: boolean;
  readonly usableSamples: number;
  readonly totalSamples: number;
  /** Per-side (max - min) across usable samples. Large values mean the bars aren't a fixed size across the clip — e.g. burned-in subtitles living inside them. */
  readonly spreadPx: Readonly<Record<Side, number>>;
}

const ZERO_SPREAD: Readonly<Record<Side, number>> = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * A single sample can measure geometrically impossible trims without ever
 * setting its own blankImage flag. detectVoidsAuto() picks top and bottom
 * (and left and right) via independent plateau votes over the same ten
 * tolerances, and on a dark scene the two votes can be won by DIFFERENT
 * tolerances: a run where dark content blends into the bar inflates top,
 * which starves bottom's scan room in that same run (bottom's limit is
 * height - top); if enough tolerances share that inflated top, "bottom
 * crushed to ~0" can out-vote the correct answer even though most
 * individual tolerances got it right. The frame itself isn't blank — it's
 * genuinely fine content — so blankImage never catches this. But the
 * result is self-contradictory (no room left for the content this sample
 * demonstrably has), and it lands on a side's floor: 0 always wins a
 * minimum, so one such sample overrides every other frame's correct
 * measurement for that side. A sample is trustworthy only if its own top
 * and bottom (and left and right) leave positive room for content.
 */
function isPlausible(result: VoidResultAuto, image: { readonly width: number; readonly height: number }): boolean {
  return result.top + result.bottom < image.height && result.left + result.right < image.width;
}

/**
 * Combine per-frame detections into one crop.
 *
 * Frames that are entirely one colour (fades, cuts to black) are dropped
 * first — a uniform frame says nothing about where the bars are, and letting
 * one through would report a trim of the whole frame. Frames whose own
 * measurement is internally impossible (see isPlausible()) are dropped too.
 *
 * The surviving samples are combined by taking the MINIMUM trim per side,
 * never the median or max. Minimum is the only choice that cannot over-crop:
 * a dark scene's content sits close to the letterbox black and measures a
 * bar far larger than it really is, but it can only ever pull the answer
 * toward "trim less" — one bright frame is enough to establish the true edge.
 */
export function buildConsensusCrop(
  results: readonly VoidResultAuto[],
  image: { readonly width: number; readonly height: number },
): ConsensusCrop {
  const usable = results.filter((r) => !r.blankImage && isPlausible(r, image));

  if (usable.length === 0) {
    return {
      crop: null,
      hasVoid: false,
      usableSamples: 0,
      totalSamples: results.length,
      spreadPx: ZERO_SPREAD,
    };
  }

  const min = {} as Record<Side, number>;
  const spreadPx = {} as Record<Side, number>;
  for (const side of SIDES) {
    const values = usable.map((r) => r[side]);
    const lo = Math.min(...values);
    min[side] = lo;
    spreadPx[side] = Math.max(...values) - lo;
  }

  const hasVoid = min.top + min.bottom + min.left + min.right > 0;

  return {
    crop: hasVoid ? roundToEven(cropRect(image, min), image) : null,
    hasVoid,
    usableSamples: usable.length,
    totalSamples: results.length,
    spreadPx,
  };
}

/**
 * Shrink width/height down to even numbers if needed.
 *
 * GitFrame only ever exports still images, which have no such constraint —
 * this exists so the crop stays safe to reuse if it's ever fed to a video
 * codec instead, most of which are yuv420p and reject odd dimensions.
 * Always shrinks, never grows: growing could reclaim a pixel of bar that
 * detection specifically decided to trim.
 */
function roundToEven(
  crop: CropRect,
  image: { readonly width: number; readonly height: number },
): CropRect {
  const width = crop.width % 2 === 0 ? crop.width : crop.width - 1;
  const height = crop.height % 2 === 0 ? crop.height : crop.height - 1;
  return {
    x: crop.x,
    y: crop.y,
    width: Math.max(1, Math.min(width, image.width - crop.x)),
    height: Math.max(1, Math.min(height, image.height - crop.y)),
  };
}
