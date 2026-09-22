import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_TOLERANCE_SECONDS,
  findDuplicate,
  isSameGrab,
  isSameMoment,
  outputSignature,
  videoKeyFor,
  type GrabIdentity,
} from '../src/lib/dedupe.js';
import { createSettings } from '../src/lib/settings.js';
import { MAX_FPS } from '../src/lib/time.js';

const SIG = 'jpeg:0.92:1920:none';

function grab(time: number, overrides: Partial<GrabIdentity> = {}): GrabIdentity {
  return { videoKey: 'clip', time, signature: SIG, ...overrides };
}

describe('videoKeyFor', () => {
  it('distinguishes files that differ in any identifying field', () => {
    const base = { name: 'clip.mp4', size: 1024, lastModified: 1700000000000 };
    const key = videoKeyFor(base);
    expect(videoKeyFor({ ...base })).toBe(key);
    expect(videoKeyFor({ ...base, name: 'other.mp4' })).not.toBe(key);
    expect(videoKeyFor({ ...base, size: 1025 })).not.toBe(key);
    expect(videoKeyFor({ ...base, lastModified: 1700000000001 })).not.toBe(key);
  });

  it('cannot be confused by a name containing the field separator', () => {
    // Size and mtime lead, so `name` is always the unambiguous remainder.
    expect(videoKeyFor({ name: '1:2:x.mp4', size: 3, lastModified: 4 })).not.toBe(
      videoKeyFor({ name: 'x.mp4', size: 3, lastModified: 4 }),
    );
  });

  it('yields an empty key for a missing or unreadable source', () => {
    expect(videoKeyFor(null)).toBe('');
    expect(videoKeyFor(undefined)).toBe('');
    expect(videoKeyFor({ name: 42, size: 'big', lastModified: Number.NaN })).toBe('-1:-1:');
  });
});

describe('outputSignature', () => {
  it('changes with every setting that changes the bytes produced', () => {
    const base = createSettings();
    const signature = outputSignature(base);

    expect(outputSignature(createSettings())).toBe(signature);
    expect(outputSignature(createSettings({ formatId: 'png' }))).not.toBe(signature);
    expect(outputSignature(createSettings({ maxEdge: 720 }))).not.toBe(signature);
    expect(outputSignature(createSettings({ quality: 0.5 }))).not.toBe(signature);
    expect(
      outputSignature(createSettings({ crop: { x: 0, y: 140, width: 1920, height: 800 } })),
    ).not.toBe(signature);
  });

  it('ignores quality for a lossless format, which does not use it', () => {
    expect(outputSignature(createSettings({ formatId: 'png', quality: 0.4 }))).toBe(
      outputSignature(createSettings({ formatId: 'png', quality: 0.9 })),
    );
  });

  it('separates two different crops of the same output size', () => {
    expect(
      outputSignature(createSettings({ crop: { x: 0, y: 0, width: 100, height: 100 } })),
    ).not.toBe(
      outputSignature(createSettings({ crop: { x: 50, y: 50, width: 100, height: 100 } })),
    );
  });
});

describe('isSameMoment', () => {
  it('matches within the tolerance and not beyond it', () => {
    expect(isSameMoment(grab(1), grab(1))).toBe(true);
    expect(isSameMoment(grab(1), grab(1 + DUPLICATE_TOLERANCE_SECONDS))).toBe(true);
    expect(isSameMoment(grab(1), grab(1 + DUPLICATE_TOLERANCE_SECONDS * 2))).toBe(false);
  });

  it('never spans two frames at the highest frame rate the app allows', () => {
    // The whole point of a fixed tolerance: at 240fps a frame lasts 4.17ms, so
    // a 1ms window cannot swallow the next one.
    expect(DUPLICATE_TOLERANCE_SECONDS).toBeLessThan(1 / MAX_FPS);
    expect(isSameMoment(grab(1), grab(1 + 1 / MAX_FPS))).toBe(false);
  });

  it('keeps different videos apart at the same timestamp', () => {
    expect(isSameMoment(grab(1), grab(1, { videoKey: 'other' }))).toBe(false);
  });

  it('refuses to match when the video could not be identified', () => {
    expect(isSameMoment(grab(1, { videoKey: '' }), grab(1, { videoKey: '' }))).toBe(false);
  });

  it('refuses to match an unusable timestamp', () => {
    expect(isSameMoment(grab(Number.NaN), grab(Number.NaN))).toBe(false);
    expect(isSameMoment(grab(-1), grab(-1))).toBe(false);
  });

  it('holds regardless of output settings', () => {
    expect(isSameMoment(grab(1), grab(1, { signature: 'png:-:720:none' }))).toBe(true);
  });
});

describe('isSameGrab', () => {
  it('requires the settings to match as well as the moment', () => {
    expect(isSameGrab(grab(1), grab(1))).toBe(true);
    expect(isSameGrab(grab(1), grab(1, { signature: 'png:-:720:none' }))).toBe(false);
  });
});

describe('findDuplicate', () => {
  const frames = [grab(1), grab(5, { signature: 'png:-:720:none' })];

  it('finds nothing in an empty gallery', () => {
    expect(findDuplicate([], grab(1))).toBeNull();
  });

  it('reports an identical capture as exact', () => {
    expect(findDuplicate(frames, grab(1))).toEqual({ frame: frames[0], kind: 'exact' });
  });

  it('reports the same moment at other settings separately', () => {
    const match = findDuplicate(frames, grab(5));
    expect(match).toEqual({ frame: frames[1], kind: 'settings' });
  });

  it('prefers an exact match over one that only shares the moment', () => {
    const settingsMatch = grab(2, { signature: 'png:-:720:none' });
    const exact = grab(2);
    expect(findDuplicate([settingsMatch, exact], grab(2))?.kind).toBe('exact');
    expect(findDuplicate([exact, settingsMatch], grab(2))?.frame).toBe(exact);
  });

  it('picks the nearest frame when several are in range', () => {
    const near = grab(2);
    const nearer = grab(2.0005);
    expect(findDuplicate([near, nearer], grab(2.0006))?.frame).toBe(nearer);
  });

  it('passes a novel timestamp through', () => {
    expect(findDuplicate(frames, grab(3))).toBeNull();
  });
});
