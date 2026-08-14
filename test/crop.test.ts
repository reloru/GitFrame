import { describe, expect, it } from 'vitest';

import { buildConsensusCrop } from '../src/lib/crop.js';
import type { Side, SideInfo, VoidResultAuto } from '../src/lib/detect.js';

const emptySide: SideInfo = { px: 0, pct: 0, hex: null, alpha: null, name: null, nextPx: 0 };

/** A fake per-frame detection result, as if produced by detectVoidsAuto(). */
function sample(
  trims: Partial<Record<Side, number>>,
  overrides: Partial<Pick<VoidResultAuto, 'blankImage' | 'width' | 'height'>> = {},
): VoidResultAuto {
  const top = trims.top ?? 0;
  const bottom = trims.bottom ?? 0;
  const left = trims.left ?? 0;
  const right = trims.right ?? 0;
  return {
    width: overrides.width ?? 640,
    height: overrides.height ?? 360,
    top,
    bottom,
    left,
    right,
    sides: { top: emptySide, bottom: emptySide, left: emptySide, right: emptySide },
    crop: { x: left, y: top, width: 640 - left - right, height: 360 - top - bottom },
    blankImage: overrides.blankImage ?? false,
    hasVoid: top + bottom + left + right > 0,
    rotated: false,
    auto: true,
  };
}

const IMAGE = { width: 640, height: 360 };

describe('buildConsensusCrop', () => {
  it('takes the minimum trim per side, not the median or max', () => {
    const results = [sample({ top: 40, bottom: 40 }), sample({ top: 30, bottom: 50 }), sample({ top: 35, bottom: 45 })];
    const consensus = buildConsensusCrop(results, IMAGE);

    // Minimum of {40,30,35}=30 and {40,50,45}=40 — never the middle or the max.
    expect(consensus.crop).toEqual({ x: 0, y: 30, width: 640, height: 290 });
    expect(consensus.hasVoid).toBe(true);
  });

  it('discards a sample whose own top+bottom leaves no room for content', () => {
    // A dark scene's own detectVoidsAuto() can independently plateau-vote top
    // and bottom from DIFFERENT tolerances: one where dark content inflates
    // top, starving bottom's scan room (bottom's limit is height - top) in
    // that same run. If enough tolerances share the inflated top, that
    // out-votes the correct answer even though the frame is genuinely fine
    // content, never triggering blankImage. Left unfiltered, this sample's
    // impossible bottom=0 would win the minimum over every correct frame.
    const corrupted = sample({ top: 360, bottom: 0 }, { height: 360 }); // top+bottom == height
    const good = [sample({ top: 72, bottom: 72 }), sample({ top: 72, bottom: 72 })];
    const consensus = buildConsensusCrop([...good, corrupted], IMAGE);

    expect(consensus.crop).toEqual({ x: 0, y: 72, width: 640, height: 216 });
    expect(consensus.usableSamples).toBe(2);
  });

  it('discards a sample whose own left+right leaves no room for content', () => {
    const corrupted = sample({ left: 640, right: 0 }, { width: 640 });
    const good = [sample({ left: 20, right: 20 }), sample({ left: 20, right: 20 })];
    const consensus = buildConsensusCrop([...good, corrupted], IMAGE);

    expect(consensus.crop!.x).toBe(20);
    expect(consensus.usableSamples).toBe(2);
  });

  it('keeps a sample whose trims are large but still leave room for content', () => {
    // Must not be trigger-happy: a real, if unusually heavy, letterbox with
    // top+bottom just under the full height is still a legitimate reading.
    const heavy = sample({ top: 170, bottom: 170 }, { height: 360 }); // sums to 340 < 360
    const consensus = buildConsensusCrop([heavy], IMAGE);
    expect(consensus.usableSamples).toBe(1);
    expect(consensus.crop).toEqual({ x: 0, y: 170, width: 640, height: 20 });
  });

  it('protects against over-cropping from a dark scene', () => {
    // A dark scene's content sits near the letterbox black and measures a much
    // larger bar than really exists. One bright frame establishes the truth.
    const brightFrame = sample({ top: 40, bottom: 40 });
    const darkScene = sample({ top: 140, bottom: 130 }); // over-measured
    const consensus = buildConsensusCrop([brightFrame, darkScene], IMAGE);

    expect(consensus.crop).toEqual({ x: 0, y: 40, width: 640, height: 280 });
  });

  it('drops fades and cuts-to-black before taking the minimum', () => {
    const real = [sample({ top: 40, bottom: 40 }), sample({ top: 42, bottom: 38 })];
    const fade = sample({}, { blankImage: true });
    const withFade = buildConsensusCrop([...real, fade], IMAGE);
    const withoutFade = buildConsensusCrop(real, IMAGE);

    expect(withFade.crop).toEqual(withoutFade.crop);
    expect(withFade.usableSamples).toBe(2);
    expect(withFade.totalSamples).toBe(3);
  });

  it('keeps frames with content living in the bars, via the minimum', () => {
    // Burned-in subtitles inside the letterbox measure a smaller bar on those
    // frames. Minimum-consensus naturally keeps the subtitle frame's answer
    // rather than the quieter frames', which is the point.
    const quiet = sample({ bottom: 60 });
    const withSubtitle = sample({ bottom: 22 }); // subtitle eats into the bar
    const consensus = buildConsensusCrop([quiet, withSubtitle], IMAGE);

    expect(consensus.crop!.height).toBe(360 - 22);
  });

  it('reports no crop when nothing has bars', () => {
    const consensus = buildConsensusCrop([sample({}), sample({})], IMAGE);
    expect(consensus.crop).toBeNull();
    expect(consensus.hasVoid).toBe(false);
  });

  it('reports no crop when every sample is degenerate', () => {
    const consensus = buildConsensusCrop(
      [sample({}, { blankImage: true }), sample({}, { blankImage: true })],
      IMAGE,
    );
    expect(consensus.crop).toBeNull();
    expect(consensus.usableSamples).toBe(0);
    expect(consensus.totalSamples).toBe(2);
  });

  it('handles an empty sample set without throwing', () => {
    const consensus = buildConsensusCrop([], IMAGE);
    expect(consensus.crop).toBeNull();
    expect(consensus.totalSamples).toBe(0);
  });

  it('computes the spread per side, for flagging inconsistent bars', () => {
    const consensus = buildConsensusCrop(
      [sample({ bottom: 60 }), sample({ bottom: 20 }), sample({ bottom: 55 })],
      IMAGE,
    );
    expect(consensus.spreadPx.bottom).toBe(40); // 60 - 20
    expect(consensus.spreadPx.top).toBe(0);
  });

  it('rounds an odd crop dimension down to even', () => {
    const consensus = buildConsensusCrop([sample({ top: 41, bottom: 40 })], { width: 640, height: 360 });
    // Height would be 360-41-40=279 (odd) -> shrinks to 278.
    expect(consensus.crop!.height % 2).toBe(0);
    expect(consensus.crop!.height).toBe(278);
    expect(consensus.crop!.y).toBe(41);
  });

  it('never grows past what detection reported when rounding to even', () => {
    const consensus = buildConsensusCrop([sample({ left: 15 })], IMAGE);
    expect(consensus.crop!.width).toBeLessThanOrEqual(640 - 15);
  });
});
