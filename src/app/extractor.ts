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

import type { ImageFormat } from '../lib/format.js';
import { qualityFor } from '../lib/format.js';
import { fitToMaxEdge, type Size } from '../lib/scale.js';

/** The slice of HTMLVideoElement this module needs. */
export interface VideoLike {
  currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(callback: () => void): number;
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
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  const timers = options.timers ?? defaultTimers;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve();
    };
    const timer = timers.setTimeout(finish, PRESENT_TIMEOUT_MS);
    try {
      video.requestVideoFrameCallback!(finish);
    } catch {
      finish();
    }
  });
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
  video.currentTime = time;
  await settled;
  await waitForPresentedFrame(video, options);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface Canvas2dLike {
  imageSmoothingEnabled: boolean;
  drawImage(source: never, dx: number, dy: number, dw: number, dh: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
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
}

export interface FrameRenderer {
  render(video: VideoLike): Promise<RenderResult>;
}

export interface RendererOptions {
  readonly format: ImageFormat;
  readonly quality: number;
  readonly maxEdge: number;
  readonly createCanvas?: () => CanvasLike;
}

function defaultCanvasFactory(): CanvasLike {
  return document.createElement('canvas') as unknown as CanvasLike;
}

/**
 * Draw frames onto a single reused canvas.
 *
 * Reusing one canvas matters: allocating a fresh one per frame is what makes
 * long extraction runs stutter and eventually get the tab killed on iOS.
 */
export function createCanvasRenderer(options: RendererOptions): FrameRenderer {
  const factory = options.createCanvas ?? defaultCanvasFactory;
  const canvas = factory();
  const quality = qualityFor(options.format, options.quality);

  return {
    async render(video: VideoLike): Promise<RenderResult> {
      const size = fitToMaxEdge(
        { width: video.videoWidth, height: video.videoHeight },
        options.maxEdge,
      );
      if (size.width <= 0 || size.height <= 0) {
        throw new Error('Video has no readable dimensions yet');
      }

      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.drawImage(video as never, 0, 0, size.width, size.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, options.format.mime, quality);
      });
      if (!blob) throw new Error('Could not encode frame');
      return { blob, size };
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
      const { blob, size } = await options.renderer.render(options.video);
      const frame: CapturedFrame = { time, blob, size };
      frames.push(frame);
      options.onFrame?.(frame);
    } catch (error) {
      if (error instanceof CancelledError) {
        cancelled = true;
        break;
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
