import { describe, expect, it, vi } from 'vitest';

import {
  CancelledError,
  ExtractionError,
  createCanvasRenderer,
  ensureMetadata,
  extractFrames,
  sampleVoids,
  seekTo,
  waitForEvent,
  waitForPresentedFrame,
} from '../src/app/extractor.js';
import type { RGBAImage } from '../src/lib/detect.js';
import { formatById } from '../src/lib/format.js';
import { SHARPNESS_MAX_EDGE } from '../src/lib/sharpness.js';
import { FakeCanvas, FakeVideo, flush, inertTimers, instantTimers } from './helpers/fakes.js';

const noYield = (): Promise<void> => Promise.resolve();

/** The renderer's first canvas is the output; any later one is for scoring sharpness. */
function canvasPair(output = new FakeCanvas(), analysis = new FakeCanvas()) {
  const factory = vi.fn((): FakeCanvas => (factory.mock.calls.length === 1 ? output : analysis));
  return { output, analysis, factory };
}

function makeRenderer(canvas = new FakeCanvas(), maxEdge = 0) {
  return createCanvasRenderer({
    format: formatById('jpeg'),
    quality: 0.8,
    maxEdge,
    createCanvas: canvasPair(canvas).factory,
  });
}

/** Vertical stripes one pixel wide: as sharp as an image gets along x. */
function stripes(width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.floor(x / 2) % 2 === 0 ? 20 : 235;
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('waitForEvent', () => {
  it('resolves on the awaited event and detaches its listeners', async () => {
    const video = new FakeVideo();
    const removeSpy = vi.spyOn(video, 'removeEventListener');

    const pending = waitForEvent(video, ['seeked'], {
      timeoutMs: 1000,
      timers: inertTimers,
      label: 'seek',
    });
    video.dispatchEvent(new Event('seeked'));
    await expect(pending).resolves.toBeUndefined();

    // The seek listener and the error listener both come off.
    expect(removeSpy).toHaveBeenCalledWith('seeked', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('rejects on a video error', async () => {
    const video = new FakeVideo();
    const pending = waitForEvent(video, ['seeked'], {
      timeoutMs: 1000,
      timers: inertTimers,
      label: 'seek',
    });
    video.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow(/Video error while waiting for seek/);
  });

  it('rejects when the deadline passes', async () => {
    const video = new FakeVideo();
    await expect(
      waitForEvent(video, ['seeked'], { timeoutMs: 1, timers: instantTimers, label: 'seek' }),
    ).rejects.toThrow(/Timed out waiting for seek/);
  });

  it('rejects when aborted', async () => {
    const video = new FakeVideo();
    const controller = new AbortController();
    const pending = waitForEvent(video, ['seeked'], {
      timeoutMs: 1000,
      timers: inertTimers,
      signal: controller.signal,
      label: 'seek',
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('settles only once when several signals race', async () => {
    const video = new FakeVideo();
    const pending = waitForEvent(video, ['seeked'], {
      timeoutMs: 1000,
      timers: inertTimers,
      label: 'seek',
    });
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('ensureMetadata', () => {
  it('returns immediately when metadata is already loaded', async () => {
    const video = new FakeVideo({ readyState: 4 });
    await expect(ensureMetadata(video, { timers: inertTimers })).resolves.toBeUndefined();
  });

  it('waits for loadedmetadata when it is not', async () => {
    const video = new FakeVideo({ readyState: 0 });
    const pending = ensureMetadata(video, { timers: inertTimers });
    video.emitMetadata();
    await expect(pending).resolves.toBeUndefined();
  });

  it('times out on a file that never reports metadata', async () => {
    const video = new FakeVideo({ readyState: 0 });
    await expect(ensureMetadata(video, { timers: instantTimers, timeoutMs: 1 })).rejects.toThrow(
      /video metadata/,
    );
  });
});

describe('waitForPresentedFrame', () => {
  it('is a no-op when requestVideoFrameCallback is unavailable', async () => {
    const video = new FakeVideo();
    await expect(waitForPresentedFrame(video, { timers: inertTimers })).resolves.toBeUndefined();
  });

  it('waits for the callback when it exists', async () => {
    const video = new FakeVideo({ withFrameCallback: true });
    await expect(waitForPresentedFrame(video, { timers: inertTimers })).resolves.toBeUndefined();
  });

  it('gives up quickly when the callback never fires', async () => {
    const video = new FakeVideo();
    video.requestVideoFrameCallback = () => 1; // registers, never calls back
    await expect(waitForPresentedFrame(video, { timers: instantTimers })).resolves.toBeUndefined();
  });

  it('recovers when the callback throws', async () => {
    const video = new FakeVideo();
    video.requestVideoFrameCallback = () => {
      throw new Error('nope');
    };
    await expect(waitForPresentedFrame(video, { timers: inertTimers })).resolves.toBeUndefined();
  });
});

describe('seekTo', () => {
  it('moves the playhead and waits for the seek to land', async () => {
    const video = new FakeVideo();
    await seekTo(video, 4.5, { timers: inertTimers });
    expect(video.currentTime).toBe(4.5);
    expect(video.seeks).toEqual([4.5]);
  });

  it('skips the seek when already at the requested time', async () => {
    const video = new FakeVideo();
    await seekTo(video, 0, { timers: inertTimers });
    expect(video.seeks).toHaveLength(0);
  });

  it('still seeks when parked at the right time but without data', async () => {
    const video = new FakeVideo({ readyState: 1 });
    await seekTo(video, 0, { timers: inertTimers });
    expect(video.seeks).toEqual([0]);
  });

  it('rejects when the decoder never lands', async () => {
    const video = new FakeVideo({ stall: true });
    await expect(seekTo(video, 3, { timers: instantTimers, timeoutMs: 1 })).rejects.toThrow(
      /Timed out/,
    );
  });

  it('rejects immediately when already aborted', async () => {
    const video = new FakeVideo();
    const controller = new AbortController();
    controller.abort();
    await expect(
      seekTo(video, 3, { timers: inertTimers, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('createCanvasRenderer', () => {
  it('draws the frame at full size and encodes it', async () => {
    const canvas = new FakeCanvas();
    const video = new FakeVideo({ videoWidth: 1280, videoHeight: 720 });

    const { blob, size } = await makeRenderer(canvas).render(video);

    expect(size).toEqual({ width: 1280, height: 720 });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(canvas.context.draws).toEqual([{ dw: 1280, dh: 720 }]);
    expect(canvas.context.clears).toEqual([{ w: 1280, h: 720 }]);
    expect(canvas.lastType).toBe('image/jpeg');
    expect(canvas.lastQuality).toBe(0.8);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('scales down to the configured longest edge', async () => {
    const canvas = new FakeCanvas();
    const video = new FakeVideo({ videoWidth: 3840, videoHeight: 2160 });
    const { size } = await makeRenderer(canvas, 1280).render(video);
    expect(size).toEqual({ width: 1280, height: 720 });
  });

  it('omits quality for lossless formats', async () => {
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer({
      format: formatById('png'),
      quality: 0.5,
      maxEdge: 0,
      createCanvas: () => canvas,
    });
    await renderer.render(new FakeVideo());
    expect(canvas.lastQuality).toBeUndefined();
    expect(canvas.lastType).toBe('image/png');
  });

  it('reuses its canvases across frames instead of allocating per frame', async () => {
    const { factory } = canvasPair();
    const renderer = createCanvasRenderer({
      format: formatById('jpeg'),
      quality: 0.9,
      maxEdge: 0,
      createCanvas: factory,
    });
    const video = new FakeVideo();
    await renderer.render(video);
    await renderer.render(video);
    await renderer.render(video);
    // One output canvas, one analysis canvas — no more however many frames.
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('scores sharpness at a fixed size, independent of the output size', async () => {
    const { analysis, factory } = canvasPair(new FakeCanvas(), new FakeCanvas({ imageData: (_x, _y, w, h) => stripes(w, h) }));
    const renderer = createCanvasRenderer({
      format: formatById('jpeg'),
      quality: 0.8,
      maxEdge: 720,
      createCanvas: factory,
    });

    const { size, sharpness } = await renderer.render(new FakeVideo({ videoWidth: 3840, videoHeight: 2160 }));

    expect(size).toEqual({ width: 720, height: 405 });
    expect(analysis.width).toBe(SHARPNESS_MAX_EDGE);
    expect(analysis.height).toBe(576);
    expect(analysis.context.draws).toEqual([{ dw: 1024, dh: 576 }]);
    expect(sharpness).toBeGreaterThan(50);
  });

  it('scores the cropped picture, not the bars', async () => {
    const { analysis, factory } = canvasPair();
    const renderer = createCanvasRenderer({
      format: formatById('jpeg'),
      quality: 0.8,
      maxEdge: 0,
      crop: { x: 0, y: 140, width: 1920, height: 800 },
      createCanvas: factory,
    });
    await renderer.render(new FakeVideo({ videoWidth: 1920, videoHeight: 1080 }));
    expect(analysis.context.draws).toEqual([{ sx: 0, sy: 140, sw: 1920, sh: 800, dw: 1024, dh: 427 }]);
  });

  it('reports no score for a frame with no detail', async () => {
    // FakeCanvas hands back a uniform grey frame by default.
    const { sharpness } = await makeRenderer().render(new FakeVideo());
    expect(sharpness).toBeNull();
  });

  it('keeps the frame when pixels cannot be read back for scoring', async () => {
    const unreadable = new FakeCanvas({
      imageData: () => {
        throw new Error('SecurityError: tainted canvas');
      },
    });
    const { factory } = canvasPair(new FakeCanvas(), unreadable);
    const renderer = createCanvasRenderer({ format: formatById('jpeg'), quality: 0.8, maxEdge: 0, createCanvas: factory });
    const result = await renderer.render(new FakeVideo());
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.sharpness).toBeNull();
  });

  it('keeps the frame when the analysis canvas has no 2D context', async () => {
    const { factory } = canvasPair(new FakeCanvas(), new FakeCanvas({ noContext: true }));
    const renderer = createCanvasRenderer({ format: formatById('jpeg'), quality: 0.8, maxEdge: 0, createCanvas: factory });
    const result = await renderer.render(new FakeVideo());
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.sharpness).toBeNull();
  });

  it('fails clearly when dimensions are not known yet', async () => {
    const video = new FakeVideo({ videoWidth: 0, videoHeight: 0 });
    await expect(makeRenderer().render(video)).rejects.toThrow(/no readable dimensions/);
  });

  it('fails clearly when the 2D context is refused', async () => {
    const canvas = new FakeCanvas({ noContext: true });
    await expect(makeRenderer(canvas).render(new FakeVideo())).rejects.toThrow(
      /context unavailable/,
    );
  });

  it('fails clearly when encoding produces nothing', async () => {
    const canvas = new FakeCanvas({ nullBlob: true });
    await expect(makeRenderer(canvas).render(new FakeVideo())).rejects.toThrow(/Could not encode/);
  });

  it('draws only the crop rectangle when one is configured', async () => {
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer({
      format: formatById('jpeg'),
      quality: 0.8,
      maxEdge: 0,
      crop: { x: 10, y: 40, width: 300, height: 200 },
      createCanvas: canvasPair(canvas).factory,
    });

    const { size } = await renderer.render(new FakeVideo({ videoWidth: 320, videoHeight: 280 }));

    expect(size).toEqual({ width: 300, height: 200 });
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(200);
    expect(canvas.context.draws).toEqual([{ sx: 10, sy: 40, sw: 300, sh: 200, dw: 300, dh: 200 }]);
  });

  it('scales maxEdge against the cropped size, not the original frame', async () => {
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer({
      format: formatById('jpeg'),
      quality: 0.8,
      maxEdge: 150,
      crop: { x: 0, y: 0, width: 400, height: 200 },
      createCanvas: canvasPair(canvas).factory,
    });

    // A 400x200 crop capped to 150 longest-edge -> 150x75, not scaled from
    // the original (much larger) 3840x2160 frame.
    const { size } = await renderer.render(new FakeVideo({ videoWidth: 3840, videoHeight: 2160 }));

    expect(size).toEqual({ width: 150, height: 75 });
    expect(canvas.context.draws).toEqual([{ sx: 0, sy: 0, sw: 400, sh: 200, dw: 150, dh: 75 }]);
  });
});

describe('extractFrames', () => {
  it('captures every requested timestamp in order', async () => {
    const video = new FakeVideo();
    const progress: number[] = [];

    const result = await extractFrames({
      video,
      times: [1, 2, 3],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: noYield,
      onProgress: (p) => progress.push(p.completed),
    });

    expect(result.frames.map((frame) => frame.time)).toEqual([1, 2, 3]);
    expect(result.failures).toHaveLength(0);
    expect(result.cancelled).toBe(false);
    expect(progress).toEqual([1, 2, 3]);
    expect(video.seeks).toEqual([1, 2, 3]);
  });

  it('streams frames out as they land', async () => {
    const seen: number[] = [];
    await extractFrames({
      video: new FakeVideo(),
      times: [1, 2],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: noYield,
      onFrame: (frame) => seen.push(frame.time),
    });
    expect(seen).toEqual([1, 2]);
  });

  it('records a failure and keeps going', async () => {
    const video = new FakeVideo();
    let call = 0;
    const flaky = {
      render: async () => {
        call += 1;
        if (call === 2) throw new Error('decode blew up');
        return { blob: new Blob(['x']), size: { width: 10, height: 10 }, sharpness: call * 10 };
      },
    };

    const result = await extractFrames({
      video,
      times: [1, 2, 3],
      renderer: flaky,
      timers: inertTimers,
      yieldToUi: noYield,
    });

    expect(result.frames).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(ExtractionError);
    expect(result.failures[0]!.time).toBe(2);
    expect(result.failures[0]!.message).toBe('decode blew up');
    expect(result.frames.map((frame) => frame.sharpness)).toEqual([10, 30]);
    expect(result.cancelled).toBe(false);
  });

  it('records non-Error throws too', async () => {
    const result = await extractFrames({
      video: new FakeVideo(),
      times: [1],
      renderer: {
        render: async () => {
          throw 'plain string';
        },
      },
      timers: inertTimers,
      yieldToUi: noYield,
    });
    expect(result.failures[0]!.message).toBe('plain string');
  });

  it('survives a clip where every seek times out', async () => {
    const result = await extractFrames({
      video: new FakeVideo({ stall: true }),
      times: [1, 2],
      renderer: makeRenderer(),
      timers: instantTimers,
      seekTimeoutMs: 1,
      yieldToUi: noYield,
    });
    expect(result.frames).toHaveLength(0);
    expect(result.failures).toHaveLength(2);
    expect(result.cancelled).toBe(false);
  });

  it('stops promptly when cancelled mid-run and keeps what it has', async () => {
    const controller = new AbortController();
    const result = await extractFrames({
      video: new FakeVideo(),
      times: [1, 2, 3, 4, 5],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: noYield,
      onProgress: (p) => {
        if (p.completed === 2) controller.abort();
      },
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.frames).toHaveLength(2);
  });

  it('reports cancellation even when it arrives during a seek', async () => {
    const video = new FakeVideo({ stall: true });
    const controller = new AbortController();
    const pending = extractFrames({
      video,
      times: [1, 2],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: noYield,
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.frames).toHaveLength(0);
  });

  it('does nothing for an empty plan', async () => {
    const result = await extractFrames({
      video: new FakeVideo(),
      times: [],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: noYield,
    });
    expect(result.frames).toHaveLength(0);
    expect(result.cancelled).toBe(false);
  });

  it('yields to the event loop between frames', async () => {
    const yields = vi.fn(async () => {});
    await extractFrames({
      video: new FakeVideo(),
      times: [1, 2, 3],
      renderer: makeRenderer(),
      timers: inertTimers,
      yieldToUi: yields,
    });
    expect(yields).toHaveBeenCalledTimes(3);
  });

  it('uses a real macrotask yield when none is supplied', async () => {
    const result = await extractFrames({
      video: new FakeVideo(),
      times: [1],
      renderer: makeRenderer(),
      timers: inertTimers,
    });
    expect(result.frames).toHaveLength(1);
  });
});

const flatImage = (width: number, height: number): RGBAImage => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 9;
    data[i + 1] = 9;
    data[i + 2] = 9;
    data[i + 3] = 255;
  }
  return { data, width, height };
};

/** A black top/bottom bar over high-variance "content", so it never reads flat. */
function letterboxImage(width: number, height: number, top: number, bottom: number): RGBAImage {
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

describe('sampleVoids', () => {
  it('measures every requested timestamp', async () => {
    const canvas = new FakeCanvas({ imageData: (_sx, _sy, w, h) => flatImage(w, h) });
    const video = new FakeVideo({ videoWidth: 200, videoHeight: 100 });

    const result = await sampleVoids({
      video,
      times: [1, 2, 3],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => canvas,
    });

    expect(result.cancelled).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(video.seeks).toEqual([1, 2, 3]);
  });

  it('analyzes a bounded proxy resolution rather than the native frame', async () => {
    const canvas = new FakeCanvas();
    const video = new FakeVideo({ videoWidth: 1920, videoHeight: 1080 });

    await sampleVoids({
      video,
      times: [1],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => canvas,
    });

    // 1920x1080 capped to a 640 longest edge -> 640x360, preserving aspect.
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(canvas.context.draws).toEqual([{ dw: 640, dh: 360 }]);
  });

  it('scales the measured trim back up to native pixels', async () => {
    const canvas = new FakeCanvas({
      // 640x360 proxy of a 1920x1080 frame; a 60px analysis-space top bar is a
      // 180px bar at native resolution (3x scale).
      imageData: (_sx, _sy, w, h) => letterboxImage(w, h, 60, 0),
    });
    const video = new FakeVideo({ videoWidth: 1920, videoHeight: 1080 });

    const result = await sampleVoids({
      video,
      times: [1],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => canvas,
    });

    expect(result.results[0]!.top).toBe(180);
    expect(result.results[0]!.width).toBe(1920);
    expect(result.results[0]!.height).toBe(1080);
    expect(result.results[0]!.crop).toEqual({ x: 0, y: 180, width: 1920, height: 900 });
  });

  it('leaves an already-small frame unscaled', async () => {
    const canvas = new FakeCanvas();
    const video = new FakeVideo({ videoWidth: 400, videoHeight: 300 });

    await sampleVoids({
      video,
      times: [1],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => canvas,
    });

    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
  });

  it('reuses a single canvas across every sample', async () => {
    const canvas = new FakeCanvas();
    const factory = vi.fn(() => canvas);

    await sampleVoids({
      video: new FakeVideo(),
      times: [1, 2, 3, 4],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reports progress after each sample', async () => {
    const progress: Array<{ completed: number; total: number }> = [];
    await sampleVoids({
      video: new FakeVideo(),
      times: [1, 2, 3],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => new FakeCanvas(),
      onProgress: (p) => progress.push(p),
    });
    expect(progress).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  it('skips a sample without dimensions instead of failing the run', async () => {
    const video = new FakeVideo({ videoWidth: 0, videoHeight: 0 });
    const result = await sampleVoids({
      video,
      times: [1, 2],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => new FakeCanvas(),
    });
    expect(result.results).toHaveLength(0);
    expect(result.cancelled).toBe(false);
  });

  it('skips a sample whose seek times out and keeps going', async () => {
    const video = new FakeVideo({ stall: true });
    const result = await sampleVoids({
      video,
      times: [1, 2],
      timers: instantTimers,
      seekTimeoutMs: 1,
      yieldToUi: noYield,
      createCanvas: () => new FakeCanvas(),
    });
    expect(result.results).toHaveLength(0);
    expect(result.cancelled).toBe(false);
  });

  it('stops promptly when cancelled and reports what it has so far', async () => {
    const controller = new AbortController();
    const result = await sampleVoids({
      video: new FakeVideo(),
      times: [1, 2, 3, 4, 5],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => new FakeCanvas(),
      signal: controller.signal,
      onProgress: (p) => {
        if (p.completed === 2) controller.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('reads whichever frame is actually current at each sample, not a stale buffer', async () => {
    const video = new FakeVideo({ videoWidth: 10, videoHeight: 10 });
    const canvas = new FakeCanvas({
      imageData: (_sx, _sy, w, h) => {
        // Each sample's colour is keyed off the seek that just landed, proving
        // detection reads the frame at THIS sample's time, not a cached one.
        const shade = Math.round(video.currentTime * 10);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = shade;
          data[i + 1] = shade;
          data[i + 2] = shade;
          data[i + 3] = 255;
        }
        return { data, width: w, height: h };
      },
    });

    const result = await sampleVoids({
      video,
      times: [1, 2],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => canvas,
    });

    // Both samples are still uniform frames (blankImage), but distinguishably so.
    expect(result.results.map((r) => r.blankImage)).toEqual([true, true]);
  });

  it('does nothing for an empty schedule', async () => {
    const result = await sampleVoids({
      video: new FakeVideo(),
      times: [],
      timers: inertTimers,
      yieldToUi: noYield,
      createCanvas: () => new FakeCanvas(),
    });
    expect(result.results).toHaveLength(0);
    expect(result.cancelled).toBe(false);
  });
});
