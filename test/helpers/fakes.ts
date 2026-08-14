/** Test doubles for the browser APIs the app depends on. */

import type { Canvas2dLike, CanvasLike, TimerLike, VideoLike } from '../../src/app/extractor.js';
import type { RGBAImage } from '../../src/lib/detect.js';

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

export type DrawCall =
  | { readonly dw: number; readonly dh: number }
  | { readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number; readonly dw: number; readonly dh: number };

/** Default getImageData(): a uniform frame, i.e. one a real detector would flag as blankImage. */
function grayImage(width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 128;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

export class FakeContext implements Canvas2dLike {
  imageSmoothingEnabled = false;
  readonly draws: DrawCall[] = [];
  readonly clears: Array<{ w: number; h: number }> = [];
  /** Override to control what getImageData() returns for detection tests. */
  imageData?: (sx: number, sy: number, sw: number, sh: number) => RGBAImage;

  drawImage(source: never, dx: number, dy: number, dw: number, dh: number): void;
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
  drawImage(_source: never, ...rest: number[]): void {
    if (rest.length === 4) {
      const [, , dw, dh] = rest as [number, number, number, number];
      this.draws.push({ dw, dh });
    } else {
      const [sx, sy, sw, sh, , , dw, dh] = rest as [number, number, number, number, number, number, number, number];
      this.draws.push({ sx, sy, sw, sh, dw, dh });
    }
  }

  clearRect(_x: number, _y: number, w: number, h: number): void {
    this.clears.push({ w, h });
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): RGBAImage {
    return this.imageData?.(sx, sy, sw, sh) ?? grayImage(sw, sh);
  }
}

export interface FakeCanvasOptions {
  /** Simulate a browser refusing to hand back a 2D context. */
  noContext?: boolean;
  /** Simulate an encoder failure. */
  nullBlob?: boolean;
  blobSize?: number;
  /** What getImageData() returns; defaults to a uniform frame. */
  imageData?: (sx: number, sy: number, sw: number, sh: number) => RGBAImage;
}

export class FakeCanvas implements CanvasLike {
  width = 0;
  height = 0;
  readonly context = new FakeContext();
  lastType: string | undefined;
  lastQuality: number | undefined;
  /** Sizes the canvas was resized to, in order. */
  readonly sizes: Array<{ width: number; height: number }> = [];

  constructor(private readonly options: FakeCanvasOptions = {}) {
    if (options.imageData) this.context.imageData = options.imageData;
  }

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
