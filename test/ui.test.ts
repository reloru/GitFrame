// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppHandle, type ShareCandidate, type ShareOutcome, type UiDeps } from '../src/app/ui.js';
import { FakeCanvas } from './helpers/fakes.js';
import { mountMarkup, patchVideo, setFiles, tick, type FakeMedia } from './helpers/dom.js';

interface Harness {
  app: AppHandle;
  media: FakeMedia;
  downloads: Array<{ blob: Blob; filename: string }>;
  revoked: string[];
  canvas: FakeCanvas;
  shareCalls: Array<readonly ShareCandidate[]>;
  el: <T extends HTMLElement>(id: string) => T;
  click: (id: string) => void;
  loadVideo: (name?: string) => Promise<void>;
}

function setup(
  options: {
    duration?: number;
    stall?: boolean;
    shareFiles?: (files: readonly ShareCandidate[]) => Promise<ShareOutcome>;
  } = {},
): Harness {
  mountMarkup(document);

  const downloads: Array<{ blob: Blob; filename: string }> = [];
  const revoked: string[] = [];
  const shareCalls: Array<readonly ShareCandidate[]> = [];
  const canvas = new FakeCanvas();
  let urlCounter = 0;

  const video = document.getElementById('video') as HTMLVideoElement;
  // Duration stays NaN until a file is "loaded", exactly as in a browser.
  const media = patchVideo(video, options.stall ? { stall: true } : {});

  const deps: UiDeps = {
    document,
    createObjectURL: () => `blob:${(urlCounter += 1)}`,
    revokeObjectURL: (url) => revoked.push(url),
    triggerDownload: (blob, filename) => downloads.push({ blob, filename }),
    createCanvas: () => canvas,
    yieldToUi: () => Promise.resolve(),
    ...(options.shareFiles
      ? {
          shareFiles: (files: readonly ShareCandidate[]) => {
            shareCalls.push(files);
            return options.shareFiles!(files);
          },
        }
      : {}),
  };

  const app = createApp(deps);
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const click = (id: string): void => {
    el<HTMLButtonElement>(id).click();
  };

  return {
    app,
    media,
    downloads,
    revoked,
    canvas,
    shareCalls,
    el,
    click,
    async loadVideo(name = 'My Clip.mp4') {
      const input = el<HTMLInputElement>('file-input');
      setFiles(input, [new File(['data'], name, { type: 'video/mp4' })]);
      input.dispatchEvent(new Event('change'));
      // The decoder only reports a duration once metadata arrives.
      media.setDuration(options.duration ?? 10);
      media.emitMetadata();
      await tick();
    },
  };
}

describe('initial state', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('shows only the picker', () => {
    expect(h.el('empty-state').hidden).toBe(false);
    expect(h.el('workspace').hidden).toBe(true);
    expect(h.el('gallery-section').hidden).toBe(true);
    expect(h.el('dock').hidden).toBe(true);
    expect(h.el('progress-overlay').hidden).toBe(true);
  });

  it('builds the format and size choosers from the shared definitions', () => {
    const formats = h.el('format-group').querySelectorAll('button');
    expect(formats).toHaveLength(3);
    expect([...formats].map((b) => b.textContent)).toEqual(['PNG', 'JPG', 'WebP']);
    // Exactly one is active, and it matches the default.
    expect(h.el('format-group').querySelectorAll('.is-active')).toHaveLength(1);
    expect(h.el('size-group').querySelectorAll('button').length).toBeGreaterThan(1);
  });

  it('cannot extract before a video is loaded', () => {
    expect(h.el<HTMLButtonElement>('auto-btn').disabled).toBe(true);
    expect(h.el('plan-summary').textContent).toBe('Load a video first');
  });

  it('throws a clear error when the markup is missing an element', () => {
    document.getElementById('grab-btn')?.remove();
    expect(() =>
      createApp({
        document,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => {},
        triggerDownload: () => {},
      }),
    ).toThrow(/Missing required element #grab-btn/);
  });
});

describe('loading a video', () => {
  it('reveals the workspace and reports the clip', async () => {
    const h = setup({ duration: 65 });
    h.click('pick-btn');
    await h.loadVideo();

    expect(h.el('empty-state').hidden).toBe(true);
    expect(h.el('workspace').hidden).toBe(false);
    expect(h.el('time-total').textContent).toBe('1:05');
    expect(h.el('video-meta').textContent).toBe('1920×1080 · 1:05');
    expect(h.el<HTMLInputElement>('scrub').max).toBe('65');
    expect(h.el<HTMLButtonElement>('auto-btn').disabled).toBe(false);
  });

  it('opens the file picker from both entry points', async () => {
    const h = setup();
    const input = h.el<HTMLInputElement>('file-input');
    const spy = vi.spyOn(input, 'click').mockImplementation(() => {});

    h.click('pick-btn');
    await h.loadVideo();
    h.click('change-video');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ignores a change event with no file', () => {
    const h = setup();
    const input = h.el<HTMLInputElement>('file-input');
    setFiles(input, []);
    input.dispatchEvent(new Event('change'));
    expect(h.el('workspace').hidden).toBe(true);
  });

  it('releases the previous object URL when swapping videos', async () => {
    const h = setup();
    await h.loadVideo('one.mp4');
    await h.loadVideo('two.mp4');
    expect(h.revoked).toContain('blob:1');
  });

  it('surfaces an undecodable file and returns to the picker', async () => {
    const h = setup();
    await h.loadVideo();
    h.media.emitError();

    expect(h.el('load-error').hidden).toBe(false);
    expect(h.el('load-error').textContent).toMatch(/couldn't be decoded/);
    expect(h.el('workspace').hidden).toBe(true);
    expect(h.el('empty-state').hidden).toBe(false);
  });

  it('shows the plan summary with output dimensions', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    expect(h.el('plan-summary').textContent).toBe('10 frames · 1920×1080');
  });
});

describe('transport controls', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup({ duration: 10 });
    await h.loadVideo();
  });

  it('steps by whole seconds without leaving the clip', () => {
    h.click('fwd-second');
    expect(h.el<HTMLInputElement>('scrub').value).toBe('1');
    h.click('back-second');
    expect(h.el<HTMLInputElement>('scrub').value).toBe('0');
    // Already at zero — cannot go negative.
    h.click('back-second');
    expect(h.el<HTMLInputElement>('scrub').value).toBe('0');
  });

  it('steps by single frames at the configured rate', () => {
    h.click('fwd-frame');
    const video = h.el<HTMLVideoElement>('video');
    expect(video.currentTime).toBeCloseTo(1 / 30, 5);
    h.click('back-frame');
    expect(video.currentTime).toBeCloseTo(0, 5);
  });

  it('updates the read-out while scrubbing and stops fighting timeupdate', () => {
    const scrub = h.el<HTMLInputElement>('scrub');
    scrub.value = '4.5';
    scrub.dispatchEvent(new Event('input'));

    expect(h.el('time-current').textContent).toBe('0:04.500');
    expect(h.el<HTMLVideoElement>('video').currentTime).toBe(4.5);

    scrub.dispatchEvent(new Event('change'));
    h.el<HTMLVideoElement>('video').dispatchEvent(new Event('timeupdate'));
    expect(h.el('time-current').textContent).toBe('0:04.500');
  });

  it('clamps a seek beyond the end of the clip', () => {
    const scrub = h.el<HTMLInputElement>('scrub');
    scrub.value = '999';
    scrub.dispatchEvent(new Event('input'));
    expect(h.el<HTMLVideoElement>('video').currentTime).toBe(10);
  });

  it('toggles playback and swaps the button label', () => {
    h.click('play-toggle');
    expect(h.media.playing()).toBe(true);
    expect(h.el('play-icon').textContent).toBe('❚❚');
    expect(h.el('play-toggle').getAttribute('aria-label')).toBe('Pause');

    h.click('play-toggle');
    expect(h.media.playing()).toBe(false);
    expect(h.el('play-icon').textContent).toBe('▶');
  });

  it('recovers when the browser refuses to play', async () => {
    const video = h.el<HTMLVideoElement>('video');
    video.play = () => Promise.reject(new Error('gesture required'));
    h.click('play-toggle');
    await tick();
    expect(h.el('toast').hidden).toBe(false);
  });

  it('recovers when play throws outright', () => {
    const video = h.el<HTMLVideoElement>('video');
    video.play = () => {
      throw new Error('no media stack');
    };
    h.click('play-toggle');
    expect(h.el('toast').textContent).toMatch(/Playback unavailable/);
  });
});

describe('settings', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup({ duration: 10 });
    await h.loadVideo();
  });

  it('switches format and hides quality for lossless output', () => {
    const png = [...h.el('format-group').querySelectorAll('button')].find(
      (b) => b.textContent === 'PNG',
    )!;
    png.click();

    expect(h.app.settings.formatId).toBe('png');
    expect(h.el('quality-field').hidden).toBe(true);
    expect(png.getAttribute('aria-checked')).toBe('true');

    const jpg = [...h.el('format-group').querySelectorAll('button')].find(
      (b) => b.textContent === 'JPG',
    )!;
    jpg.click();
    expect(h.el('quality-field').hidden).toBe(false);
  });

  it('switches output size and reflects it in the plan summary', () => {
    const preset = [...h.el('size-group').querySelectorAll('button')].find(
      (b) => b.textContent === '720',
    )!;
    preset.click();

    expect(h.app.settings.maxEdge).toBe(720);
    expect(h.el('plan-summary').textContent).toContain('720×405');
  });

  it('moves the quality slider', () => {
    const quality = h.el<HTMLInputElement>('quality');
    quality.value = '55';
    quality.dispatchEvent(new Event('input'));
    expect(h.app.settings.quality).toBeCloseTo(0.55);
    expect(h.el('quality-value').textContent).toBe('55%');
  });

  it('switches between interval and count modes', () => {
    h.click('mode-count');
    expect(h.app.settings.mode).toBe('count');
    expect(h.el('count-field').hidden).toBe(false);
    expect(h.el('interval-field').hidden).toBe(true);
    expect(h.el('mode-count').getAttribute('aria-checked')).toBe('true');

    h.click('mode-interval');
    expect(h.el('interval-field').hidden).toBe(false);
  });

  it('steps the interval in sensible increments', () => {
    h.click('interval-minus');
    expect(h.app.settings.intervalSeconds).toBeCloseTo(0.9);
    h.click('interval-plus');
    expect(h.app.settings.intervalSeconds).toBeCloseTo(1);
    h.click('interval-plus');
    expect(h.app.settings.intervalSeconds).toBeCloseTo(2);
  });

  it('steps the frame count faster once it is large', () => {
    h.click('mode-count');
    h.click('count-plus');
    expect(h.app.settings.frameCount).toBe(34);
    h.click('count-minus');
    expect(h.app.settings.frameCount).toBe(24);
  });

  it('steps and clamps the frame rate', () => {
    h.click('fps-plus');
    expect(h.app.settings.fps).toBe(31);
    h.click('fps-minus');
    expect(h.app.settings.fps).toBe(30);
  });

  it('accepts typed values and rejects nonsense', () => {
    const input = h.el<HTMLInputElement>('interval-input');
    input.value = '2.5';
    input.dispatchEvent(new Event('change'));
    expect(h.app.settings.intervalSeconds).toBe(2.5);

    input.value = 'banana';
    input.dispatchEvent(new Event('change'));
    expect(h.app.settings.intervalSeconds).toBe(2.5);
    // The field is repainted with the value actually in force.
    expect(input.value).toBe('2.5');

    input.dispatchEvent(new Event('blur'));
    expect(input.value).toBe('2.5');
  });

  it('recomputes the plan when settings change', () => {
    expect(h.el('plan-summary').textContent).toContain('10 frames');
    h.click('interval-plus');
    expect(h.el('plan-summary').textContent).toContain('5 frames');
  });
});

describe('clip range', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup({ duration: 10 });
    await h.loadVideo();
  });

  function scrubTo(seconds: number): void {
    const scrub = h.el<HTMLInputElement>('scrub');
    scrub.value = String(seconds);
    scrub.dispatchEvent(new Event('input'));
    scrub.dispatchEvent(new Event('change'));
  }

  it('defaults to the whole clip', () => {
    expect(h.app.settings.rangeStart).toBe(0);
    expect(h.app.settings.rangeEnd).toBe(0);
    expect(h.el('range-start-time').textContent).toBe('0:00.000');
    expect(h.el('range-end-time').textContent).toBe('End of clip');
    expect(h.el<HTMLButtonElement>('range-reset').hidden).toBe(true);
  });

  it('sets the start from wherever the scrubber currently is', () => {
    scrubTo(3);
    h.click('range-start-btn');

    expect(h.app.settings.rangeStart).toBe(3);
    expect(h.el('range-start-time').textContent).toBe('0:03.000');
    expect(h.el<HTMLButtonElement>('range-reset').hidden).toBe(false);
  });

  it('sets the end from wherever the scrubber currently is', () => {
    scrubTo(7);
    h.click('range-end-btn');

    expect(h.app.settings.rangeEnd).toBe(7);
    expect(h.el('range-end-time').textContent).toBe('0:07.000');
  });

  it('shrinks the plan to the chosen span', () => {
    scrubTo(2);
    h.click('range-start-btn');
    scrubTo(5);
    h.click('range-end-btn');

    // 1s interval over a 3s span -> 3 frames, not the 10 the full clip gives.
    expect(h.el('plan-summary').textContent).toContain('3 frames');
  });

  it('flags an inverted range instead of silently discarding a side', () => {
    scrubTo(5);
    h.click('range-end-btn');
    scrubTo(7);
    h.click('range-start-btn');

    // Both taps are honoured — nothing gets quietly reset behind the user's back.
    expect(h.app.settings.rangeStart).toBe(7);
    expect(h.app.settings.rangeEnd).toBe(5);
    expect(h.el('plan-summary').textContent).toBe('Start must be before end');
    expect(h.el<HTMLButtonElement>('auto-btn').disabled).toBe(true);
    expect(h.el('range-end-btn').classList.contains('is-invalid')).toBe(true);
  });

  it('resets to the whole clip', () => {
    scrubTo(2);
    h.click('range-start-btn');
    scrubTo(8);
    h.click('range-end-btn');

    h.click('range-reset');

    expect(h.app.settings.rangeStart).toBe(0);
    expect(h.app.settings.rangeEnd).toBe(0);
    expect(h.el('range-start-time').textContent).toBe('0:00.000');
    expect(h.el('range-end-time').textContent).toBe('End of clip');
    expect(h.el<HTMLButtonElement>('range-reset').hidden).toBe(true);
  });

  it('confines a batch extraction to the chosen span', async () => {
    scrubTo(2);
    h.click('range-start-btn');
    scrubTo(5);
    h.click('range-end-btn');

    h.click('auto-btn');
    await h.app.whenIdle();

    expect(h.app.store.count).toBe(3);
    for (const frame of h.app.store.all) {
      expect(frame.time).toBeGreaterThanOrEqual(2);
      expect(frame.time).toBeLessThan(5);
    }
  });

  it('clears a previously set range when a different video is loaded', async () => {
    scrubTo(3);
    h.click('range-start-btn');
    expect(h.app.settings.rangeStart).toBe(3);

    await h.loadVideo('another.mp4');

    expect(h.app.settings.rangeStart).toBe(0);
    expect(h.app.settings.rangeEnd).toBe(0);
  });
});

/** Black top/bottom bars over high-variance "content", as fractions of height. */
function letterboxImage(width: number, height: number, topFrac: number, bottomFrac: number) {
  const top = Math.round(height * topFrac);
  const bottom = Math.round(height * bottomFrac);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inBar = y < top || y >= height - bottom;
      data[o] = inBar ? 0 : (x * 53 + y * 97) % 256;
      data[o + 1] = inBar ? 0 : (x * 29 + y * 61) % 256;
      data[o + 2] = inBar ? 0 : (x * 83 + y * 13) % 256;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

/** High-variance "content" filling the whole frame — no bars anywhere. */
function busyImage(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = (x * 53 + y * 97) % 256;
      data[o + 1] = (x * 29 + y * 61) % 256;
      data[o + 2] = (x * 83 + y * 13) % 256;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('crop', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup({ duration: 10 });
    await h.loadVideo();
  });

  it('has no crop applied by default', () => {
    expect(h.app.settings.crop).toBeNull();
    expect(h.el<HTMLButtonElement>('crop-clear-btn').hidden).toBe(true);
    expect(h.el('crop-preview').hidden).toBe(true);
  });

  it('detects a letterboxed clip and applies the crop to real captures', async () => {
    h.canvas.context.imageData = (_sx, _sy, w, hh) => letterboxImage(w, hh, 0.2, 0.2);

    h.click('crop-detect-btn');
    await h.app.whenIdle();

    // 20% top/bottom bars on a 1080-tall source trim to roughly 60% of that,
    // allowing for rounding through the downscaled analysis pass.
    const crop = h.app.settings.crop;
    expect(crop).not.toBeNull();
    expect(crop!.width).toBe(1920);
    expect(crop!.height).toBeGreaterThan(600);
    expect(crop!.height).toBeLessThan(700);
    expect(crop!.x).toBe(0);

    expect(h.el<HTMLButtonElement>('crop-clear-btn').hidden).toBe(false);
    expect(h.el('crop-preview').hidden).toBe(false);
    expect(h.el('crop-preview-img').getAttribute('src')).toBeTruthy();
    expect(h.el('crop-preview-caption').textContent).toContain('Trimmed');
    expect(h.el('toast').textContent).toBe('Black bars removed');

    // The crop must actually reach a real capture, not just settings.
    h.click('grab-btn');
    await h.app.whenIdle();
    const frame = h.app.store.all[0]!;
    expect(frame.width).toBe(crop!.width);
    expect(frame.height).toBe(crop!.height);
  });

  it('reports no black bars for a clip that already fills the frame', async () => {
    h.canvas.context.imageData = (_sx, _sy, w, hh) => busyImage(w, hh);

    h.click('crop-detect-btn');
    await h.app.whenIdle();

    expect(h.app.settings.crop).toBeNull();
    expect(h.el<HTMLButtonElement>('crop-clear-btn').hidden).toBe(true);
    expect(h.el('toast').textContent).toBe('No black bars found');
  });

  it('lets a detected crop be removed', async () => {
    h.canvas.context.imageData = (_sx, _sy, w, hh) => letterboxImage(w, hh, 0.2, 0.2);
    h.click('crop-detect-btn');
    await h.app.whenIdle();
    expect(h.app.settings.crop).not.toBeNull();

    h.click('crop-clear-btn');

    expect(h.app.settings.crop).toBeNull();
    expect(h.el<HTMLButtonElement>('crop-clear-btn').hidden).toBe(true);
    expect(h.el('crop-preview').hidden).toBe(true);
    expect(h.el('toast').textContent).toBe('Crop removed');
  });

  it('can be cancelled mid-detection without applying anything', async () => {
    const stalling = setup({ duration: 10, stall: true });
    await stalling.loadVideo();

    stalling.click('crop-detect-btn');
    await tick();
    expect(stalling.el('progress-overlay').hidden).toBe(false);
    stalling.click('cancel-btn');
    await stalling.app.whenIdle();

    expect(stalling.app.settings.crop).toBeNull();
    expect(stalling.el('toast').textContent).toBe('Detection cancelled');
    expect(stalling.el('progress-overlay').hidden).toBe(true);
    expect(stalling.el<HTMLButtonElement>('crop-detect-btn').disabled).toBe(false);
  });

  it('restores the playhead after detecting', async () => {
    h.canvas.context.imageData = (_sx, _sy, w, hh) => letterboxImage(w, hh, 0.1, 0.1);
    h.click('fwd-second');
    const before = h.el<HTMLVideoElement>('video').currentTime;

    h.click('crop-detect-btn');
    await h.app.whenIdle();

    expect(h.el<HTMLVideoElement>('video').currentTime).toBeCloseTo(before, 5);
  });

  it('clears a detected crop when a different video is loaded', async () => {
    h.canvas.context.imageData = (_sx, _sy, w, hh) => letterboxImage(w, hh, 0.2, 0.2);
    h.click('crop-detect-btn');
    await h.app.whenIdle();
    expect(h.app.settings.crop).not.toBeNull();

    await h.loadVideo('another.mp4');

    expect(h.app.settings.crop).toBeNull();
    expect(h.el('crop-preview').hidden).toBe(true);
  });
});

describe('grabbing a single frame', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup({ duration: 10 });
    await h.loadVideo();
  });

  it('captures the current frame into the gallery', async () => {
    h.click('fwd-second');
    h.click('grab-btn');
    await h.app.whenIdle();

    expect(h.app.store.count).toBe(1);
    expect(h.el('gallery-section').hidden).toBe(false);
    expect(h.el('dock').hidden).toBe(false);
    expect(h.el('gallery-count').textContent).toBe('1');
    expect(h.el('gallery').querySelectorAll('.tile')).toHaveLength(1);
    expect(h.el('toast').textContent).toBe('Grabbed 0:01.000');
  });

  it('records the encoding each frame was captured with', async () => {
    h.click('grab-btn');
    await h.app.whenIdle();
    expect(h.app.store.all[0]!.ext).toBe('jpg');
  });

  it('honours the chosen format and quality', async () => {
    const quality = h.el<HTMLInputElement>('quality');
    quality.value = '50';
    quality.dispatchEvent(new Event('input'));

    h.click('grab-btn');
    await h.app.whenIdle();

    expect(h.canvas.lastType).toBe('image/jpeg');
    expect(h.canvas.lastQuality).toBeCloseTo(0.5);
  });

  it('reports an encoder failure without losing the app', async () => {
    const failing = setup({ duration: 10 });
    await failing.loadVideo();
    const video = failing.el<HTMLVideoElement>('video');
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 0 });

    failing.click('grab-btn');
    await failing.app.whenIdle();

    expect(failing.app.store.count).toBe(0);
    expect(failing.el('toast').textContent).toMatch(/no readable dimensions/);
    expect(failing.el<HTMLButtonElement>('grab-btn').disabled).toBe(false);
  });
});

describe('batch extraction', () => {
  it('extracts the whole plan and reports it', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('interval-plus'); // 2s apart -> 5 frames

    h.click('auto-btn');
    await h.app.whenIdle();

    expect(h.app.store.count).toBe(5);
    expect(h.el('toast').textContent).toBe('Extracted 5 frames');
    expect(h.el('progress-overlay').hidden).toBe(true);
    expect(h.el<HTMLButtonElement>('auto-btn').disabled).toBe(false);
  });

  it('opens the progress overlay while it runs', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();

    h.click('auto-btn');
    await tick();
    expect(h.el('progress-overlay').hidden).toBe(false);
    expect(h.el('progress-label').textContent).toBe('Extracting frames…');

    await h.app.whenIdle();
    expect(h.el('progress-bar').style.width).toBe('100%');
  });

  it('restores the playhead afterwards', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('fwd-second');
    const before = h.el<HTMLVideoElement>('video').currentTime;

    h.click('auto-btn');
    await h.app.whenIdle();

    expect(h.el<HTMLVideoElement>('video').currentTime).toBeCloseTo(before, 5);
  });

  it('stops when the user taps Stop and keeps what it captured', async () => {
    const h = setup({ duration: 60 });
    await h.loadVideo();

    h.click('auto-btn');
    await tick();
    h.click('cancel-btn');
    await h.app.whenIdle();

    expect(h.el('toast').textContent).toMatch(/^Stopped — kept \d+ frames$/);
    expect(h.app.store.count).toBeLessThan(60);
    expect(h.el('progress-overlay').hidden).toBe(true);
  });

  it('keeps going when individual frames fail', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('interval-plus');

    let calls = 0;
    const original = h.canvas.toBlob.bind(h.canvas);
    h.canvas.toBlob = (cb, type, quality) => {
      calls += 1;
      if (calls === 2) {
        cb(null);
        return;
      }
      original(cb, type, quality);
    };

    h.click('auto-btn');
    await h.app.whenIdle();

    expect(h.el('toast').textContent).toBe('Got 4, skipped 1');
    expect(h.app.store.count).toBe(4);
  });

  it('refuses to run an empty plan', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.media.setDuration(0);
    h.el<HTMLVideoElement>('video').dispatchEvent(new Event('loadedmetadata'));

    h.el<HTMLButtonElement>('auto-btn').disabled = false;
    h.click('auto-btn');
    await h.app.whenIdle();

    expect(h.el('toast').textContent).toBe('Nothing to extract');
    expect(h.app.store.count).toBe(0);
  });

  it('caps a plan against the remaining gallery capacity', async () => {
    const h = setup({ duration: 100000 });
    await h.loadVideo();
    expect(h.el('plan-summary').textContent).toContain('capped');
  });
});

describe('gallery', () => {
  async function withFrames(count: number): Promise<Harness> {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    for (let i = 0; i < count; i += 1) {
      h.click('fwd-second');
      h.click('grab-btn');
      await h.app.whenIdle();
    }
    return h;
  }

  it('selects and deselects by tapping a tile', async () => {
    const h = await withFrames(2);
    const tile = h.el('gallery').querySelector<HTMLElement>('.tile')!;

    tile.click();
    expect(h.app.store.selectedCount).toBe(1);
    expect(h.el('gallery').querySelector('.tile')!.classList.contains('is-selected')).toBe(true);
    expect(h.el('gallery-hint').textContent).toMatch(/^1 selected · /);
    expect(h.el('download-label').textContent).toBe('Download 1 selected');

    h.el('gallery').querySelector<HTMLElement>('.tile')!.click();
    expect(h.app.store.selectedCount).toBe(0);
    expect(h.el('download-label').textContent).toBe('Download all 2');
  });

  it('registers a tap on the tile artwork, not just its border', async () => {
    const h = await withFrames(1);
    h.el('gallery').querySelector<HTMLElement>('.tile__img')!.click();
    expect(h.app.store.selectedCount).toBe(1);
  });

  it('ignores taps on the empty gutter', async () => {
    const h = await withFrames(1);
    h.el('gallery').click();
    expect(h.app.store.selectedCount).toBe(0);
  });

  it('toggles select-all', async () => {
    const h = await withFrames(3);
    h.click('select-all');
    expect(h.app.store.selectedCount).toBe(3);
    h.click('select-all');
    expect(h.app.store.selectedCount).toBe(0);
  });

  it('deletes the selection and releases its URLs', async () => {
    const h = await withFrames(3);
    h.el('gallery').querySelector<HTMLElement>('.tile')!.click();
    h.click('delete-selected');

    expect(h.app.store.count).toBe(2);
    expect(h.el('toast').textContent).toBe('Deleted 1');
    expect(h.revoked.length).toBeGreaterThan(0);
  });

  it('disables delete when nothing is selected', async () => {
    const h = await withFrames(1);
    expect(h.el<HTMLButtonElement>('delete-selected').disabled).toBe(true);
  });

  it('clears everything and hides the gallery again', async () => {
    const h = await withFrames(2);
    h.click('clear-all');

    expect(h.app.store.count).toBe(0);
    expect(h.el('gallery-section').hidden).toBe(true);
    expect(h.el('dock').hidden).toBe(true);
  });

  it('labels each tile with its timecode', async () => {
    const h = await withFrames(2);
    const times = [...h.el('gallery').querySelectorAll('.tile__time')].map((n) => n.textContent);
    expect(times).toEqual(['0:01.000', '0:02.000']);
  });
});

/** Pull the entry names out of a store-only archive by walking its local headers. */
async function readZipNames(blob: Blob): Promise<string[]> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const names: string[] = [];
  let cursor = 0;
  while (cursor + 30 <= data.length && view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    names.push(new TextDecoder().decode(data.slice(cursor + 30, cursor + 30 + nameLength)));
    cursor += 30 + nameLength + extraLength + size;
  }
  return names;
}

describe('export', () => {
  async function withFrames(
    count: number,
    shareFiles?: (files: readonly ShareCandidate[]) => Promise<ShareOutcome>,
  ): Promise<Harness> {
    const h = setup({ duration: 10, ...(shareFiles ? { shareFiles } : {}) });
    await h.loadVideo();
    for (let i = 0; i < count; i += 1) {
      h.click('fwd-second');
      h.click('grab-btn');
      await h.app.whenIdle();
    }
    return h;
  }

  it('saves a lone frame as a plain image, not an archive', async () => {
    const h = await withFrames(1);
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]!.filename).toBe('My-Clip_001_00h00m01s000.jpg');
    expect(h.el('toast').textContent).toBe('Saved 1 frame');
  });

  it('bundles several frames into a zip named after the video', async () => {
    const h = await withFrames(3);
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]!.filename).toBe('My-Clip_frames.zip');
    expect(h.downloads[0]!.blob.type).toBe('application/zip');
    expect(h.downloads[0]!.blob.size).toBeGreaterThan(22);
    expect(h.el('toast').textContent).toMatch(/^Saved 3 frames · /);
  });

  it('numbers archived frames sequentially in time order', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('interval-plus'); // 2s apart -> 5 frames
    h.click('auto-btn');
    await h.app.whenIdle();

    h.click('download-zip');
    await h.app.whenIdle();

    const names = await readZipNames(h.downloads[0]!.blob);
    expect(names).toEqual([
      'My-Clip_001_00h00m00s017.jpg',
      'My-Clip_002_00h00m02s017.jpg',
      'My-Clip_003_00h00m04s017.jpg',
      'My-Clip_004_00h00m06s017.jpg',
      'My-Clip_005_00h00m08s017.jpg',
    ]);
  });

  it('numbers a mixed batch and single grab without repeating a sequence', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('grab-btn');
    await h.app.whenIdle();
    h.click('interval-plus');
    h.click('auto-btn');
    await h.app.whenIdle();

    h.click('download-zip');
    await h.app.whenIdle();

    const names = await readZipNames(h.downloads[0]!.blob);
    const sequences = names.map((name) => name.split('_')[1]);
    expect(new Set(sequences).size).toBe(names.length);
    expect(sequences).toEqual([...sequences].sort());
  });

  it('exports only the selection when one exists', async () => {
    const h = await withFrames(3);
    h.el('gallery').querySelector<HTMLElement>('.tile')!.click();
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads[0]!.filename).toBe('My-Clip_001_00h00m01s000.jpg');
  });

  it('can be cancelled mid-package', async () => {
    const h = await withFrames(3);
    h.click('download-zip');
    await tick();
    h.click('cancel-btn');
    await h.app.whenIdle();

    expect(h.el('progress-overlay').hidden).toBe(true);
    expect(h.el<HTMLButtonElement>('download-zip').disabled).toBe(false);
  });

  it('says so when there is nothing to save', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('download-zip');
    await h.app.whenIdle();
    expect(h.el('toast').textContent).toBe('No frames to download');
  });

  it('reports a packaging failure instead of hanging', async () => {
    const h = await withFrames(2);
    const first = h.app.store.all[0]!;
    Object.defineProperty(first.blob, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.reject(new Error('read failed')),
    });

    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.el('toast').textContent).toBe('read failed');
    expect(h.el('progress-overlay').hidden).toBe(true);
  });
});

describe('export via the share sheet', () => {
  async function withFrames(
    count: number,
    shareFiles: (files: readonly ShareCandidate[]) => Promise<ShareOutcome>,
  ): Promise<Harness> {
    const h = setup({ duration: 10, shareFiles });
    await h.loadVideo();
    for (let i = 0; i < count; i += 1) {
      h.click('fwd-second');
      h.click('grab-btn');
      await h.app.whenIdle();
    }
    return h;
  }

  it('offers a single frame to the share sheet instead of downloading it', async () => {
    const h = await withFrames(1, () => Promise.resolve('shared'));
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(0);
    expect(h.shareCalls).toHaveLength(1);
    expect(h.shareCalls[0]).toEqual([{ blob: h.app.store.all[0]!.blob, filename: 'My-Clip_001_00h00m01s000.jpg' }]);
    expect(h.el('toast').textContent).toBe('Shared 1 frame');
  });

  it('offers a whole batch as raw images rather than zipping them first', async () => {
    const h = await withFrames(3, () => Promise.resolve('shared'));
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(0);
    expect(h.shareCalls).toHaveLength(1);
    const shared = h.shareCalls[0]!;
    expect(shared).toHaveLength(3);
    expect(shared.map((f) => f.filename)).toEqual([
      'My-Clip_001_00h00m01s000.jpg',
      'My-Clip_002_00h00m02s000.jpg',
      'My-Clip_003_00h00m03s000.jpg',
    ]);
    // Every frame goes over as its own image — nothing gets zipped first.
    for (const file of shared) expect(file.blob.type).toBe('image/jpeg');
    expect(h.el('toast').textContent).toBe('Shared 3 frames');
  });

  it('falls back to a plain download when the share sheet is unsupported', async () => {
    const h = await withFrames(1, () => Promise.resolve('unsupported'));
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.shareCalls).toHaveLength(1);
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]!.filename).toBe('My-Clip_001_00h00m01s000.jpg');
    expect(h.el('toast').textContent).toBe('Saved 1 frame');
  });

  it('falls back to zipping a batch when the share sheet is unsupported', async () => {
    const h = await withFrames(3, () => Promise.resolve('unsupported'));
    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]!.filename).toBe('My-Clip_frames.zip');
    expect(h.el('toast').textContent).toMatch(/^Saved 3 frames · /);
  });

  it('does nothing further when the user backs out of the share sheet', async () => {
    const h = await withFrames(2, () => Promise.resolve('cancelled'));
    const before = h.el('toast').textContent;

    h.click('download-zip');
    await h.app.whenIdle();

    expect(h.downloads).toHaveLength(0);
    expect(h.el('progress-overlay').hidden).toBe(true);
    // Backing out of the OS sheet is not an error — nothing should announce it.
    expect(h.el('toast').textContent).toBe(before);
  });

  it('never opens the packaging overlay while the share sheet is up', async () => {
    let resolveShare!: (outcome: ShareOutcome) => void;
    const pending = new Promise<ShareOutcome>((resolve) => {
      resolveShare = resolve;
    });
    const h = await withFrames(3, () => pending);

    h.click('download-zip');
    await tick();
    expect(h.el('progress-overlay').hidden).toBe(true);

    resolveShare('shared');
    await h.app.whenIdle();
    expect(h.el('progress-overlay').hidden).toBe(true);
  });
});

describe('teardown', () => {
  it('aborts work, releases URLs and detaches listeners', async () => {
    const h = setup({ duration: 10 });
    await h.loadVideo();
    h.click('grab-btn');
    await h.app.whenIdle();

    h.app.destroy();

    expect(h.app.store.count).toBe(0);
    // The source URL plus every frame URL comes back.
    expect(h.revoked.length).toBeGreaterThanOrEqual(2);

    // Listeners are gone: a click no longer moves the playhead.
    const before = h.el<HTMLVideoElement>('video').currentTime;
    h.click('fwd-second');
    expect(h.el<HTMLVideoElement>('video').currentTime).toBe(before);
  });
});
