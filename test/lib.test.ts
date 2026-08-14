import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FORMAT_ID,
  DEFAULT_QUALITY,
  IMAGE_FORMATS,
  formatBytes,
  formatById,
  qualityFor,
} from '../src/lib/format.js';
import {
  frameFileName,
  sanitizeBaseName,
  sequenceWidth,
  uniqueName,
  zipFileName,
} from '../src/lib/naming.js';
import { MAX_PLAN_FRAMES, buildPlan, describePlan } from '../src/lib/plan.js';
import { DEFAULT_MAX_EDGE, SIZE_PRESETS, estimateFrameBytes, fitToMaxEdge } from '../src/lib/scale.js';
import {
  DEFAULT_SETTINGS,
  MAX_FRAME_COUNT,
  createSettings,
  normalizeSettings,
} from '../src/lib/settings.js';
import {
  DEFAULT_FPS,
  MAX_FPS,
  clamp,
  formatShortDuration,
  formatTimecode,
  frameDuration,
  frameIndexAt,
  isUsableTime,
  normalizeFps,
  stepByFrames,
  timeForFrame,
  timecodeSlug,
} from '../src/lib/time.js';

describe('time', () => {
  it('clamps into range and treats NaN as the floor', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
  });

  it('recognises usable times', () => {
    expect(isUsableTime(0)).toBe(true);
    expect(isUsableTime(1.5)).toBe(true);
    expect(isUsableTime(-1)).toBe(false);
    expect(isUsableTime(Number.NaN)).toBe(false);
    expect(isUsableTime(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUsableTime('4')).toBe(false);
    expect(isUsableTime(undefined)).toBe(false);
  });

  it('formats timecodes, widening past an hour', () => {
    expect(formatTimecode(0)).toBe('0:00.000');
    expect(formatTimecode(9.5)).toBe('0:09.500');
    expect(formatTimecode(75.25)).toBe('1:15.250');
    expect(formatTimecode(3725.5)).toBe('1:02:05.500');
    expect(formatTimecode(Number.NaN)).toBe('0:00.000');
  });

  it('formats short durations', () => {
    expect(formatShortDuration(0)).toBe('0:00');
    expect(formatShortDuration(65)).toBe('1:05');
    expect(formatShortDuration(3725)).toBe('1:02:05');
    expect(formatShortDuration(-4)).toBe('0:00');
  });

  it('builds file-safe timecode slugs', () => {
    expect(timecodeSlug(0)).toBe('00h00m00s000');
    expect(timecodeSlug(3725.5)).toBe('01h02m05s500');
    expect(timecodeSlug(Number.NaN)).toBe('00h00m00s000');
  });

  it('normalises frame rates', () => {
    expect(normalizeFps(24)).toBe(24);
    expect(normalizeFps('29.97')).toBeCloseTo(29.97);
    expect(normalizeFps(0)).toBe(DEFAULT_FPS);
    expect(normalizeFps(-5)).toBe(DEFAULT_FPS);
    expect(normalizeFps('nonsense')).toBe(DEFAULT_FPS);
    expect(normalizeFps(null, 12)).toBe(12);
    expect(normalizeFps(9999)).toBe(MAX_FPS);
    expect(normalizeFps(0.1)).toBe(1);
  });

  it('converts between times and frame indices', () => {
    expect(frameDuration(25)).toBeCloseTo(0.04);
    expect(frameIndexAt(1, 30)).toBe(30);
    expect(frameIndexAt(0, 30)).toBe(0);
    expect(frameIndexAt(Number.NaN, 30)).toBe(0);
    expect(timeForFrame(0, 30)).toBeCloseTo(1 / 60);
    expect(timeForFrame(-4, 30)).toBeCloseTo(1 / 60);
    expect(timeForFrame(2, 10)).toBeCloseTo(0.25);
  });

  it('steps whole frames without drifting past the ends', () => {
    expect(stepByFrames(1, 1, 25, 10)).toBeCloseTo(1.04);
    expect(stepByFrames(1, -1, 25, 10)).toBeCloseTo(0.96);
    expect(stepByFrames(0, -5, 25, 10)).toBe(0);
    expect(stepByFrames(9.99, 10, 25, 10)).toBeLessThanOrEqual(10);
    expect(stepByFrames(Number.NaN, 1, 25, 10)).toBeCloseTo(0.04);
    // A zero-length clip has nowhere to step to.
    expect(stepByFrames(0, 1, 25, 0)).toBe(0);
  });

  it('round-trips repeated steps without accumulating error', () => {
    let t = 0;
    for (let i = 0; i < 10; i += 1) t = stepByFrames(t, 1, 30, 100);
    expect(t).toBeCloseTo(10 / 30, 6);
  });
});

describe('format', () => {
  it('looks formats up and falls back to the default', () => {
    expect(formatById('png').mime).toBe('image/png');
    expect(formatById('webp').ext).toBe('webp');
    expect(formatById('bogus').id).toBe(DEFAULT_FORMAT_ID);
    expect(formatById(null).id).toBe(DEFAULT_FORMAT_ID);
    expect(formatById(undefined).id).toBe(DEFAULT_FORMAT_ID);
  });

  it('exposes exactly one lossless format', () => {
    expect(IMAGE_FORMATS.filter((f) => !f.lossy)).toHaveLength(1);
  });

  it('only applies quality to lossy formats', () => {
    expect(qualityFor(formatById('png'), 0.5)).toBeUndefined();
    expect(qualityFor(formatById('jpeg'), 0.5)).toBe(0.5);
    expect(qualityFor(formatById('jpeg'), 5)).toBe(1);
    expect(qualityFor(formatById('jpeg'), 0)).toBe(0.3);
    expect(qualityFor(formatById('jpeg'), Number.NaN)).toBe(DEFAULT_QUALITY);
  });

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(-1)).toBe('0 KB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GB');
    expect(formatBytes(1024 * 150)).toBe('150 KB');
  });
});

describe('scale', () => {
  it('scales down to the longest edge and never up', () => {
    expect(fitToMaxEdge({ width: 3840, height: 2160 }, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(fitToMaxEdge({ width: 1080, height: 1920 }, 1280)).toEqual({ width: 720, height: 1280 });
    expect(fitToMaxEdge({ width: 640, height: 480 }, 1920)).toEqual({ width: 640, height: 480 });
  });

  it('treats a non-positive max edge as "keep original"', () => {
    expect(fitToMaxEdge({ width: 3840, height: 2160 }, 0)).toEqual({ width: 3840, height: 2160 });
    expect(fitToMaxEdge({ width: 800, height: 600 }, Number.NaN)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('rejects unusable dimensions', () => {
    expect(fitToMaxEdge({ width: 0, height: 0 }, 1920)).toEqual({ width: 0, height: 0 });
    expect(fitToMaxEdge({ width: -4, height: 10 }, 1920)).toEqual({ width: 0, height: 0 });
    expect(fitToMaxEdge({ width: Number.NaN, height: 10 }, 100)).toEqual({ width: 0, height: 0 });
  });

  it('never scales an edge below one pixel', () => {
    const tiny = fitToMaxEdge({ width: 2000, height: 3 }, 10);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
  });

  it('estimates memory cost', () => {
    expect(estimateFrameBytes({ width: 100, height: 50 })).toBe(20000);
    expect(estimateFrameBytes({ width: 0, height: 50 })).toBe(0);
  });

  it('offers a default among the presets', () => {
    expect(SIZE_PRESETS.some((preset) => preset.value === DEFAULT_MAX_EDGE)).toBe(true);
  });
});

describe('naming', () => {
  it('sanitises base names', () => {
    expect(sanitizeBaseName('My Holiday Video.mp4')).toBe('My-Holiday-Video');
    expect(sanitizeBaseName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeBaseName('!!!.mov')).toBe('frame');
    expect(sanitizeBaseName('')).toBe('frame');
    expect(sanitizeBaseName(null)).toBe('frame');
    expect(sanitizeBaseName(undefined, 'clip')).toBe('clip');
    expect(sanitizeBaseName('a'.repeat(200)).length).toBe(48);
  });

  it('picks a sequence width wide enough for the total', () => {
    expect(sequenceWidth(0)).toBe(3);
    expect(sequenceWidth(9)).toBe(3);
    expect(sequenceWidth(1200)).toBe(4);
    expect(sequenceWidth(Number.NaN)).toBe(3);
  });

  it('builds frame file names', () => {
    expect(frameFileName({ base: 'clip.mp4', index: 4, time: 12.5, ext: 'jpg' })).toBe(
      'clip_004_00h00m12s500.jpg',
    );
    expect(frameFileName({ base: 'clip', index: 4, time: 0, ext: 'png', total: 1000 })).toBe(
      'clip_0004_00h00m00s000.png',
    );
    // Index is floored to at least 1 so a zero never produces `_000`.
    expect(frameFileName({ base: 'clip', index: 0, time: 0, ext: 'png' })).toContain('_001_');
  });

  it('names the archive', () => {
    expect(zipFileName('My Clip.mp4')).toBe('My-Clip_frames.zip');
  });

  it('de-duplicates names', () => {
    const taken = new Set(['a.jpg']);
    expect(uniqueName('b.jpg', taken)).toBe('b.jpg');
    expect(uniqueName('a.jpg', taken)).toBe('a-2.jpg');
    taken.add('a-2.jpg');
    expect(uniqueName('a.jpg', taken)).toBe('a-3.jpg');
    expect(uniqueName('noext', new Set(['noext']))).toBe('noext-2');
  });
});

describe('plan', () => {
  it('spaces interval captures across the clip', () => {
    const plan = buildPlan({ mode: 'interval', duration: 10, intervalSeconds: 2, fps: 30 });
    expect(plan.times).toHaveLength(5);
    expect(plan.truncated).toBe(false);
    expect(plan.times[0]).toBeGreaterThan(0);
    expect(plan.times[4]).toBeLessThan(10);
    for (let i = 1; i < plan.times.length; i += 1) {
      expect(plan.times[i]!).toBeGreaterThan(plan.times[i - 1]!);
    }
  });

  it('spreads a fixed count evenly', () => {
    const plan = buildPlan({ mode: 'count', duration: 12, count: 4, fps: 30 });
    expect(plan.times).toHaveLength(4);
    expect(plan.requested).toBe(4);
  });

  it('handles a single requested frame', () => {
    const plan = buildPlan({ mode: 'count', duration: 12, count: 1, fps: 30 });
    expect(plan.times).toHaveLength(1);
  });

  it('walks every frame in every-frame mode', () => {
    const plan = buildPlan({ mode: 'every-frame', duration: 1, fps: 10 });
    expect(plan.times).toHaveLength(10);
  });

  it('honours in/out points', () => {
    const plan = buildPlan({
      mode: 'interval',
      duration: 30,
      start: 10,
      end: 20,
      intervalSeconds: 5,
      fps: 30,
    });
    expect(plan.times).toHaveLength(2);
    expect(plan.times[0]!).toBeGreaterThanOrEqual(10);
    expect(plan.times.at(-1)!).toBeLessThan(20);
  });

  it('caps runaway requests and spreads them across the whole range', () => {
    const plan = buildPlan({ mode: 'interval', duration: 10_000, intervalSeconds: 1, fps: 30 });
    expect(plan.times).toHaveLength(MAX_PLAN_FRAMES);
    expect(plan.truncated).toBe(true);
    expect(plan.requested).toBe(10_000);
    // Still reaches the far end of the clip rather than stopping early.
    expect(plan.times.at(-1)!).toBeGreaterThan(9000);
  });

  it('respects a custom cap', () => {
    const plan = buildPlan({
      mode: 'count',
      duration: 100,
      count: 50,
      fps: 30,
      maxFrames: 10,
    });
    expect(plan.times).toHaveLength(10);
    expect(plan.truncated).toBe(true);
  });

  it('returns nothing for unusable input', () => {
    expect(buildPlan({ mode: 'interval', duration: 0, intervalSeconds: 1 }).times).toHaveLength(0);
    expect(buildPlan({ mode: 'interval', duration: 10, intervalSeconds: 0 }).times).toHaveLength(0);
    expect(buildPlan({ mode: 'count', duration: 10, count: 0 }).times).toHaveLength(0);
    expect(
      buildPlan({ mode: 'interval', duration: 10, start: 8, end: 4, intervalSeconds: 1 }).times,
    ).toHaveLength(0);
    expect(
      buildPlan({ mode: 'interval', duration: Number.NaN, intervalSeconds: 1 }).times,
    ).toHaveLength(0);
  });

  it('keeps every timestamp inside the clip', () => {
    const plan = buildPlan({ mode: 'interval', duration: 3, intervalSeconds: 0.05, fps: 30 });
    for (const time of plan.times) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThan(3);
    }
  });

  it('describes plans in words', () => {
    expect(describePlan({ times: [], truncated: false, requested: 0 })).toBe('Nothing to extract');
    expect(describePlan({ times: [1], truncated: false, requested: 1 })).toBe('1 frame');
    expect(describePlan({ times: [1, 2], truncated: false, requested: 2 })).toBe('2 frames');
    expect(describePlan({ times: [1, 2], truncated: true, requested: 90 })).toContain('capped');
  });
});

describe('settings', () => {
  it('provides usable defaults', () => {
    const settings = createSettings();
    expect(settings.formatId).toBe(DEFAULT_SETTINGS.formatId);
    expect(settings.mode).toBe('interval');
    expect(settings.rangeStart).toBe(0);
    expect(settings.rangeEnd).toBe(0);
  });

  it('applies overrides', () => {
    expect(createSettings({ mode: 'count', frameCount: 8 }).frameCount).toBe(8);
  });

  it('clamps hostile input', () => {
    const settings = normalizeSettings({
      formatId: 42,
      quality: 99,
      maxEdge: -5,
      fps: 'abc',
      mode: 'nonsense',
      intervalSeconds: 0,
      frameCount: 9999,
    });
    expect(settings.formatId).toBe(DEFAULT_SETTINGS.formatId);
    expect(settings.quality).toBe(1);
    expect(settings.maxEdge).toBe(0);
    expect(settings.fps).toBe(DEFAULT_FPS);
    expect(settings.mode).toBe('interval');
    expect(settings.intervalSeconds).toBeGreaterThan(0);
    expect(settings.frameCount).toBe(MAX_FRAME_COUNT);
  });

  it('survives non-objects', () => {
    expect(normalizeSettings(null).fps).toBe(DEFAULT_FPS);
    expect(normalizeSettings('nope').fps).toBe(DEFAULT_FPS);
    expect(normalizeSettings(undefined).mode).toBe('interval');
  });

  it('keeps count mode when asked', () => {
    expect(normalizeSettings({ mode: 'count' }).mode).toBe('count');
  });

  it('defaults crop to null and passes an already-computed one through', () => {
    expect(normalizeSettings({}).crop).toBeNull();
    const crop = { x: 1, y: 2, width: 3, height: 4 };
    expect(normalizeSettings({ crop }).crop).toEqual(crop);
  });

  it('carries a trim range through and rejects negative values', () => {
    expect(normalizeSettings({ rangeStart: 5, rangeEnd: 20 })).toMatchObject({
      rangeStart: 5,
      rangeEnd: 20,
    });
    expect(normalizeSettings({ rangeStart: -5, rangeEnd: -1 })).toMatchObject({
      rangeStart: 0,
      rangeEnd: 0,
    });
    expect(normalizeSettings({}).rangeStart).toBe(0);
    expect(normalizeSettings({}).rangeEnd).toBe(0);
  });
});
