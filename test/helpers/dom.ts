/** Mounts the real index.html into jsdom and makes the <video> element drivable. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Inject the shipped markup, so these tests fail if the HTML and the
 * controller's element ids ever drift apart.
 */
export function mountMarkup(doc: Document): void {
  const html = readFileSync(resolve(here, '../../src/index.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1];
  if (!body) throw new Error('Could not find <body> in src/index.html');
  // innerHTML never executes <script>, so the real entry point stays inert.
  doc.body.innerHTML = body;
}

export interface FakeMedia {
  setDuration(value: number): void;
  setSize(width: number, height: number): void;
  emitMetadata(): void;
  emitError(): void;
  readonly seeks: number[];
  readonly playing: () => boolean;
}

export interface PatchOptions {
  duration?: number;
  width?: number;
  height?: number;
  /** Seeks never complete, to exercise timeout handling. */
  stall?: boolean;
}

/**
 * jsdom has no media stack, so stand one up on the real element.
 *
 * `duration` starts as NaN to match a real <video> before any file is loaded —
 * the app has to cope with that, so the harness must reproduce it.
 */
export function patchVideo(video: HTMLVideoElement, options: PatchOptions = {}): FakeMedia {
  let time = 0;
  let duration = options.duration ?? Number.NaN;
  let width = options.width ?? 1920;
  let height = options.height ?? 1080;
  let paused = true;
  const seeks: number[] = [];

  const define = (name: string, get: () => unknown): void => {
    Object.defineProperty(video, name, { configurable: true, get });
  };

  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      seeks.push(value);
      if (options.stall) return;
      setTimeout(() => video.dispatchEvent(new Event('seeked')), 0);
      video.dispatchEvent(new Event('timeupdate'));
    },
  });

  define('duration', () => duration);
  define('videoWidth', () => width);
  define('videoHeight', () => height);
  define('readyState', () => 4);
  define('paused', () => paused);

  video.play = (): Promise<void> => {
    paused = false;
    video.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  video.pause = (): void => {
    paused = true;
    video.dispatchEvent(new Event('pause'));
  };
  video.load = (): void => {};

  return {
    setDuration: (value) => {
      duration = value;
    },
    setSize: (w, h) => {
      width = w;
      height = h;
    },
    emitMetadata: () => video.dispatchEvent(new Event('loadedmetadata')),
    emitError: () => video.dispatchEvent(new Event('error')),
    seeks,
    playing: () => !paused,
  };
}

/** Attach a file list to a file input, which jsdom otherwise keeps read-only. */
export function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
}

export const tick = (): Promise<void> =>
  new Promise((resolve_) => {
    setTimeout(resolve_, 0);
  });
