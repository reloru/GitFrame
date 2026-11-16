/**
 * Seek-and-capture engine.
 *
 * Every browser API here is behind a narrow interface so the whole pipeline can
 * be exercised without a real decoder. Three rules keep the UI responsive:
 *
 *  1. Nothing spins — every wait is an event plus a timeout, never a busy loop.
 *  2. Every seek has a deadline, so one undecodable frame can't wedge the run.
 *  3. Control returns to the event loop between frames, so taps and the cancel
 *     button stay live while a few hundred frames are pulled.
 */

import { cropRect, detectVoidsAuto, type CropRect, type RGBAImage, type VoidResultAuto } from '../lib/detect.js';
import type { ImageFormat } from '../lib/format.js';
import { qualityFor } from '../lib/format.js';
import { fitToMaxEdge, type Size } from '../lib/scale.js';
import { SHARPNESS_MAX_EDGE, sharpnessScore } from '../lib/sharpness.js';

/** The slice of HTMLVideoElement this module needs. */
export interface VideoLike {
  currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(
    callback: (now: number, metadata?: { readonly mediaTime?: number }) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export interface TimerLike {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;

/** Seeks land within a few ms; anything closer than this is already there. */
export const SEEK_EPSILON = 0.001;
export const DEFAULT_SEEK_TIMEOUT_MS = 8000;
/** A presented-frame callback that never fires shouldn't cost more than a beat. */
export const PRESENT_TIMEOUT_MS = 250;

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly time: number,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Extraction cancelled');
    this.name = 'CancelledError';
  }
}

const defaultTimers: TimerLike = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * Wait for one of `events` on `target`, rejecting on timeout, `error`, or abort.
 * Always tears its listeners down, including on the happy path.
 */
export function waitForEvent(
  target: VideoLike,
  events: readonly string[],
  options: { timeoutMs: number; timers?: TimerLike; signal?: AbortSignal; label: string },
): Promise<void> {
  const timers = options.timers ?? defaultTimers;
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function cleanup(): void {
      settled = true;
      timers.clearTimeout(timer);
      for (const event of events) target.removeEventListener(event, onDone);
      target.removeEventListener('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
    }

    function onDone(): void {
      if (settled) return;
      cleanup();
      resolve();
    }
    function onError(): void {
      if (settled) return;
      cleanup();
      reject(new Error(`Video error while waiting for ${options.label}`));
    }
    function onAbort(): void {
      if (settled) return;
      cleanup();
      reject(new CancelledError());
    }

    // Armed before any listener is attached, so no handler can observe an
    // unassigned timer handle.
    const timer = timers.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`Timed out waiting for ${options.label}`));
    }, options.timeoutMs);

    for (const event of events) target.addEventListener(event, onDone);
    target.addEventListener('error', onError);
    options.signal?.addEventListener('abort', onAbort);
  });
}

export interface SeekOptions {
  readonly timeoutMs?: number;
  readonly timers?: TimerLike;
  readonly signal?: AbortSignal;
}

/** Ensure metadata is loaded so dimensions and duration are readable. */
export async function ensureMetadata(video: VideoLike, options: SeekOptions = {}): Promise<void> {
  if (video.readyState >= HAVE_METADATA) return;
  await waitForEvent(video, ['loadedmetadata'], {
    timeoutMs: options.timeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS,
    timers: options.timers,
    signal: options.signal,
    label: 'video metadata',
  });
}

/**
 * A presented frame further than this from the seek target belongs to an
 * earlier seek, not this one. Generous on purpose: the frame shown for a
 * target starts up to one frame duration before it, and that duration is not
 * reliably known here.
 */
export const PRESENT_MATCH_SECONDS = 0.5;

interface PresentWatch {
  /** Resolves once the frame has been presented, or after a short deadline. */
  wait(): Promise<void>;
  cancel(): void;
}

/**
 * Start listening for the frame at `target` (or, with no target, the next
 * frame) being painted.
 *
 * Listening has to start before the seek is issued: browsers may present the
 * new frame before they dispatch `seeked`, and a callback registered after
 * that point never fires, which costs the whole deadline on every frame.
 */
function watchPresentedFrame(video: VideoLike, target: number | null, timers: TimerLike): PresentWatch {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return { wait: () => Promise.resolve(), cancel: () => {} };
  }

  let presented = false;
  let cancelled = false;
  let handle: number | undefined;
  let notify: (() => void) | null = null;

  const listen = (): void => {
    try {
      handle = video.requestVideoFrameCallback!((_now, metadata) => {
        if (cancelled) return;
        const mediaTime = metadata?.mediaTime;
        if (
          target !== null &&
          typeof mediaTime === 'number' &&
          Math.abs(mediaTime - target) > PRESENT_MATCH_SECONDS
        ) {
          listen();
          return;
        }
        presented = true;
        notify?.();
      });
    } catch {
      presented = true;
      notify?.();
    }
  };

  const cancel = (): void => {
    cancelled = true;
    if (handle !== undefined) {
      try {
        video.cancelVideoFrameCallback?.(handle);
      } catch {
        // Nothing to cancel.
      }
    }
  };

  listen();

  return {
    cancel,
    wait: () =>
      new Promise<void>((resolve) => {
        if (presented) {
          resolve();
          return;
        }
        const finish = (): void => {
          timers.clearTimeout(timer);
          notify = null;
          cancel();
          resolve();
        };
        const timer = timers.setTimeout(finish, PRESENT_TIMEOUT_MS);
        notify = finish;
      }),
  };
}

/**
 * Wait until the frame at the current position has actually been painted.
 *
 * Without this, `drawImage` right after `seeked` can capture the *previous*
 * frame on Safari and older Chrome. `requestVideoFrameCallback` is the reliable
 * signal; when it's missing or silent we fall through quickly rather than stall.
 */
export async function waitForPresentedFrame(
  video: VideoLike,
  options: SeekOptions = {},
): Promise<void> {
  await watchPresentedFrame(video, null, options.timers ?? defaultTimers).wait();
}

/** Move the playhead to `time` and wait for the decoder to catch up. */
export async function seekTo(
  video: VideoLike,
  time: number,
  options: SeekOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await ensureMetadata(video, options);

  const alreadyThere =
    Math.abs(video.currentTime - time) < SEEK_EPSILON && video.readyState >= HAVE_CURRENT_DATA;
  if (alreadyThere) {
    await waitForPresentedFrame(video, options);
    return;
  }

  const settled = waitForEvent(video, ['seeked'], {
    timeoutMs: options.timeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS,
    timers: options.timers,
    signal: options.signal,
    label: `seek to ${time.toFixed(3)}s`,
  });
  const presented = watchPresentedFrame(video, time, options.timers ?? defaultTimers);
  video.currentTime = time;
  try {
    await settled;
  } catch (error) {
    presented.cancel();
    throw error;
  }
  await presented.wait();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface Canvas2dLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality?: 'low' | 'medium' | 'high';
  drawImage(source: never, dx: number, dy: number, dw: number, dh: number): void;
  /** Draws only the [sx,sy,sw,sh] source rectangle — how a crop gets applied. */
  drawImage(
    source: never,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): RGBAImage;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): Canvas2dLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface RenderResult {
  readonly blob: Blob;
  readonly size: Size;
  /** 0–100 (see lib/sharpness.ts), or `null` when it could not be measured. */
  readonly sharpness: number | null;
  /** A small JPEG of the frame for gallery tiles, or `null` when none was made. */
  readonly thumb: Blob | null;
}

export interface FrameRenderer {
  render(video: VideoLike): Promise<RenderResult>;
}

export interface RendererOptions {
  readonly format: ImageFormat;
  readonly quality: number;
  readonly maxEdge: number;
  readonly createCanvas?: () => CanvasLike;
  /** When set, only this source rectangle is drawn — e.g. to trim detected letterbox bars. */
  readonly crop?: CropRect;
  /**
   * Longest edge of the gallery thumbnail made alongside each frame; omit for
   * none. A tile that shows the full-size image makes the browser decode all
   * of it — tens of megabytes per 4K frame — to paint a thumb-sized picture.
   */
  readonly thumbEdge?: number;
}

export const THUMB_QUALITY = 0.8;
/** An output this close to thumbnail size is its own thumbnail. */
const THUMB_WORTHWHILE_RATIO = 1.5;

function defaultCanvasFactory(): CanvasLike {
  return document.createElement('canvas') as unknown as CanvasLike;
}

/**
 * Draw frames onto a single reused canvas.
 *
 * Reusing one canvas matters: allocating a fresh one per frame is what makes
 * long extraction runs stutter and eventually get the tab killed on iOS.
 *
 * Sharpness is measured on a second canvas, also reused, at a fixed size —
 * scoring the output canvas would make the score depend on the export-size
 * setting. It is created on the first render rather than up front.
 */
export function createCanvasRenderer(options: RendererOptions): FrameRenderer {
  const factory = options.createCanvas ?? defaultCanvasFactory;
  const canvas = factory();
  let analysisCanvas: CanvasLike | null = null;
  let thumbCanvas: CanvasLike | null = null;
  const thumbEdge = options.thumbEdge ?? 0;
  const quality = qualityFor(options.format, options.quality);
  const crop = options.crop;

  function measureSharpness(video: VideoLike, source: Size): number | null {
    const size = fitToMaxEdge(source, SHARPNESS_MAX_EDGE);
    analysisCanvas ??= factory();
    analysisCanvas.width = size.width;
    analysisCanvas.height = size.height;
    const ctx = analysisCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    if (crop) {
      ctx.drawImage(video as never, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
    } else {
      ctx.drawImage(video as never, 0, 0, size.width, size.height);
    }
    return sharpnessScore(ctx.getImageData(0, 0, size.width, size.height));
  }

  /** Scale the frame already on the output canvas down to a thumbnail. */
  async function makeThumb(size: Size): Promise<Blob | null> {
    if (thumbEdge <= 0 || Math.max(size.width, size.height) <= thumbEdge * THUMB_WORTHWHILE_RATIO) {
      return null;
    }
    const small = fitToMaxEdge(size, thumbEdge);
    thumbCanvas ??= factory();
    thumbCanvas.width = small.width;
    thumbCanvas.height = small.height;
    const ctx = thumbCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas as never, 0, 0, small.width, small.height);
    const target = thumbCanvas;
    return new Promise<Blob | null>((resolve) => {
      target.toBlob(resolve, 'image/jpeg', THUMB_QUALITY);
    });
  }

  return {
    async render(video: VideoLike): Promise<RenderResult> {
      // maxEdge scales the POST-crop frame — a "1920 longest edge" setting
      // should apply to the trimmed picture, not the original.
      const sourceSize = crop ? { width: crop.width, height: crop.height } : { width: video.videoWidth, height: video.videoHeight };
      const size = fitToMaxEdge(sourceSize, options.maxEdge);
      if (size.width <= 0 || size.height <= 0) {
        throw new Error('Video has no readable dimensions yet');
      }

      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size.width, size.height);
      if (crop) {
        ctx.drawImage(video as never, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
      } else {
        ctx.drawImage(video as never, 0, 0, size.width, size.height);
      }

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, options.format.mime, quality);
      });
      if (!blob) throw new Error('Could not encode frame');

      // A score is a nice-to-have; failing to read pixels back must never cost
      // the frame itself.
      let sharpness: number | null = null;
      try {
        sharpness = measureSharpness(video, sourceSize);
      } catch {
        // Tainted or unreadable canvas — keep the frame, drop the score.
      }

      let thumb: Blob | null = null;
      try {
        thumb = await makeThumb(size);
      } catch {
        // The tile falls back to the full image.
      }
      return { blob, size, sharpness, thumb };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Batch extraction                                                    */
/* ------------------------------------------------------------------ */

export interface CapturedFrame {
  readonly time: number;
  readonly blob: Blob;
  readonly size: Size;
  readonly sharpness: number | null;
  readonly thumb: Blob | null;
}

export interface ExtractProgress {
  readonly completed: number;
  readonly total: number;
  readonly failed: number;
  readonly time: number;
}

export interface ExtractOptions {
  readonly video: VideoLike;
  readonly times: readonly number[];
  readonly renderer: FrameRenderer;
  readonly signal?: AbortSignal;
  readonly timers?: TimerLike;
  readonly seekTimeoutMs?: number;
  readonly onProgress?: (progress: ExtractProgress) => void;
  readonly onFrame?: (frame: CapturedFrame) => void;
  /** Hands control back to the browser between frames. */
  readonly yieldToUi?: () => Promise<void>;
  /**
   * Awaited before each frame; holds the run while it is pending. Used to wait
   * out the page being in the background, where seeks stall and would each be
   * written off as a failed frame.
   */
  readonly gate?: () => Promise<void>;
  /**
   * True while the page cannot decode (it is in the background). A frame that
   * fails then is tried once more, after `gate`, instead of being skipped.
   */
  readonly isSuspended?: () => boolean;
}

export interface ExtractResult {
  readonly frames: readonly CapturedFrame[];
  readonly failures: readonly ExtractionError[];
  readonly cancelled: boolean;
}

const defaultYield = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Capture every timestamp in `times`.
 *
 * A frame that fails is recorded and skipped rather than aborting the run —
 * one bad seek near the end of a clip shouldn't throw away 200 good frames.
 */
export async function extractFrames(options: ExtractOptions): Promise<ExtractResult> {
  const frames: CapturedFrame[] = [];
  const failures: ExtractionError[] = [];
  const total = options.times.length;
  const yieldToUi = options.yieldToUi ?? defaultYield;
  let cancelled = false;
  let retried = -1;

  for (let index = 0; index < total; index += 1) {
    const time = options.times[index]!;
    await options.gate?.();
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }

    try {
      await seekTo(options.video, time, {
        timeoutMs: options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS,
        timers: options.timers,
        signal: options.signal,
      });
      const { blob, size, sharpness, thumb } = await options.renderer.render(options.video);
      const frame: CapturedFrame = { time, blob, size, sharpness, thumb };
      frames.push(frame);
      options.onFrame?.(frame);
    } catch (error) {
      if (error instanceof CancelledError) {
        cancelled = true;
        break;
      }
      if (retried !== index && options.isSuspended?.()) {
        retried = index;
        index -= 1;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.push(new ExtractionError(message, time));
    }

    options.onProgress?.({
      completed: frames.length,
      total,
      failed: failures.length,
      time,
    });

    // Yield even on the last iteration so the caller's final progress paint
    // lands before the export UI takes over.
    await yieldToUi();
  }

  return { frames, failures, cancelled };
}

/* ------------------------------------------------------------------ */
/* Letterbox / pillarbox detection                                     */
/* ------------------------------------------------------------------ */

export interface DetectVoidsOptions {
  readonly video: VideoLike;
  readonly times: readonly number[];
  readonly signal?: AbortSignal;
  readonly timers?: TimerLike;
  readonly seekTimeoutMs?: number;
  readonly createCanvas?: () => CanvasLike;
  /** Hands control back to the browser between samples. */
  readonly yieldToUi?: () => Promise<void>;
  readonly onProgress?: (progress: { completed: number; total: number }) => void;
}

export interface DetectVoidsResult {
  /** One entry per sample that was actually read; a failed seek is skipped, not recorded. */
  readonly results: readonly VoidResultAuto[];
  readonly cancelled: boolean;
}

/**
 * Longest edge analyzed for void detection.
 *
 * A perfectly uniform frame is the algorithm's worst case — nothing ever
 * triggers its early-exit, so it scans every row and column at all ten swept
 * tolerances. At native 4K that measured over a second on a single sample in
 * testing; a fade-to-black or cut lands on exactly that worst case. Bars are
 * tens to hundreds of pixels wide at any real resolution, so measuring them on
 * a downscaled proxy loses at most a pixel or two — well inside what the even-
 * dimension rounding in buildConsensusCrop() already allows for — while making
 * every sample's cost bounded regardless of source resolution or content.
 */
export const DETECTION_MAX_EDGE = 640;

/** Scale a detection result computed on a downscaled proxy back to native pixels. */
function scaleToNative(result: VoidResultAuto, native: Size, analysis: Size): VoidResultAuto {
  const scaleX = native.width / analysis.width;
  const scaleY = native.height / analysis.height;
  const top = Math.round(result.top * scaleY);
  const bottom = Math.round(result.bottom * scaleY);
  const left = Math.round(result.left * scaleX);
  const right = Math.round(result.right * scaleX);
  return {
    ...result,
    width: native.width,
    height: native.height,
    top,
    bottom,
    left,
    right,
    crop: cropRect(native, { top, bottom, left, right }),
    hasVoid: top + bottom + left + right > 0,
  };
}

/**
 * Sample stills across a clip and measure the blank bands in each.
 *
 * This answers "where are the bands in each of these frames" — one still at a
 * time. Turning that into one crop for the whole clip (dropping degenerate
 * frames, taking the minimum trim per side) is buildConsensusCrop()'s job in
 * lib/crop.ts, not this function's: sampling here stays a plain seek-and-read
 * loop, matching extractFrames' shape, so both are easy to reason about
 * separately.
 *
 * A sample that fails to seek or decode is skipped rather than aborting the
 * whole run — buildConsensusCrop() tolerates a reduced sample set, and even
 * an empty one.
 */
export async function sampleVoids(options: DetectVoidsOptions): Promise<DetectVoidsResult> {
  const factory = options.createCanvas ?? defaultCanvasFactory;
  const canvas = factory();
  const results: VoidResultAuto[] = [];
  const total = options.times.length;
  const yieldToUi = options.yieldToUi ?? defaultYield;
  let cancelled = false;

  for (let index = 0; index < total; index += 1) {
    const time = options.times[index]!;
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }

    try {
      await seekTo(options.video, time, {
        timeoutMs: options.seekTimeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS,
        timers: options.timers,
        signal: options.signal,
      });

      const native = { width: options.video.videoWidth, height: options.video.videoHeight };
      if (native.width > 0 && native.height > 0) {
        const analysis = fitToMaxEdge(native, DETECTION_MAX_EDGE);
        canvas.width = analysis.width;
        canvas.height = analysis.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(options.video as never, 0, 0, analysis.width, analysis.height);
          const raw = detectVoidsAuto(ctx.getImageData(0, 0, analysis.width, analysis.height));
          results.push(scaleToNative(raw, native, analysis));
        }
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        cancelled = true;
        break;
      }
      // Anything else (timeout, decode hiccup) — skip this sample and keep going.
    }

    options.onProgress?.({ completed: index + 1, total });
    await yieldToUi();
  }

  return { results, cancelled };
}
