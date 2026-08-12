/** Test doubles for the browser APIs the app depends on. */

import type { Canvas2dLike, CanvasLike, TimerLike, VideoLike } from '../../src/app/extractor.js';

export interface FakeVideoOptions {
  duration?: number;
  readyState?: number;
  videoWidth?: number;
  videoHeight?: number;
  /** When set, seeks never complete — used to exercise the timeout path. */
  stall?: boolean;
  /** When set, a seek dispatches `error` instead of `seeked`. */
  failSeek?: boolean;
  withFrameCallback?: boolean;
}

/** Minimal stand-in for HTMLVideoElement, driven by an EventTarget. */
export class FakeVideo extends EventTarget implements VideoLike {
  duration: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  stall: boolean;
  failSeek: boolean;
  /** Every position the test asked for, in order. */
  readonly seeks: number[] = [];

  private time = 0;

  constructor(options: FakeVideoOptions = {}) {
    super();
    this.duration = options.duration ?? 10;
    this.readyState = options.readyState ?? 4;
    this.videoWidth = options.videoWidth ?? 1920;
    this.videoHeight = options.videoHeight ?? 1080;
    this.stall = options.stall ?? false;
    this.failSeek = options.failSeek ?? false;
    if (options.withFrameCallback) {
      this.requestVideoFrameCallback = (callback: () => void): number => {
        setTimeout(callback, 0);
        return 1;
      };
    }
  }

  requestVideoFrameCallback?: (callback: () => void) => number;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.seeks.push(value);
    if (this.stall) return;
    setTimeout(() => {
      this.dispatchEvent(new Event(this.failSeek ? 'error' : 'seeked'));
    }, 0);
  }

  /** Force metadata to arrive later, for the `ensureMetadata` path. */
  emitMetadata(readyState = 4): void {
    this.readyState = readyState;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
}

export class FakeContext implements Canvas2dLike {
  imageSmoothingEnabled = false;
  readonly draws: Array<{ dw: number; dh: number }> = [];
  readonly clears: Array<{ w: number; h: number }> = [];

  drawImage(_source: never, _dx: number, _dy: number, dw: number, dh: number): void {
    this.draws.push({ dw, dh });
  }

  clearRect(_x: number, _y: number, w: number, h: number): void {
    this.clears.push({ w, h });
  }
}

export interface FakeCanvasOptions {
  /** Simulate a browser refusing to hand back a 2D context. */
  noContext?: boolean;
  /** Simulate an encoder failure. */
  nullBlob?: boolean;
  blobSize?: number;
}

export class FakeCanvas implements CanvasLike {
  width = 0;
  height = 0;
  readonly context = new FakeContext();
  lastType: string | undefined;
  lastQuality: number | undefined;
  /** Sizes the canvas was resized to, in order. */
  readonly sizes: Array<{ width: number; height: number }> = [];

  constructor(private readonly options: FakeCanvasOptions = {}) {}

  getContext(_contextId: '2d'): Canvas2dLike | null {
    this.sizes.push({ width: this.width, height: this.height });
    return this.options.noContext ? null : this.context;
  }

  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void {
    this.lastType = type;
    this.lastQuality = quality;
    if (this.options.nullBlob) {
      callback(null);
      return;
    }
    const size = this.options.blobSize ?? 8;
    callback(new Blob([new Uint8Array(size).fill(7)], { type: type ?? 'image/png' }));
  }
}

/** Timers that fire immediately, so timeout paths resolve without waiting. */
export const instantTimers: TimerLike = {
  setTimeout: (handler: () => void) => {
    const handle = setTimeout(handler, 0);
    return handle;
  },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Timers that never fire, so a wait can only end via its event. */
export const inertTimers: TimerLike = {
  setTimeout: () => 0,
  clearTimeout: () => {},
};

/** Let queued macrotasks run. */
export const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
