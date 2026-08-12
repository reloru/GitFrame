/**
 * Session settings.
 *
 * Deliberately in-memory only. GitFrame does not use localStorage,
 * sessionStorage, IndexedDB, cookies, or a service worker cache — closing the
 * tab leaves nothing behind on the device. Settings live for the session and
 * then they're gone.
 */

import { DEFAULT_FORMAT_ID, DEFAULT_QUALITY, MAX_QUALITY, MIN_QUALITY } from './format.js';
import { DEFAULT_MAX_EDGE } from './scale.js';
import { DEFAULT_FPS, clamp, normalizeFps } from './time.js';

export type ExtractMode = 'interval' | 'count';

export interface Settings {
  formatId: string;
  quality: number;
  maxEdge: number;
  fps: number;
  mode: ExtractMode;
  intervalSeconds: number;
  frameCount: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  formatId: DEFAULT_FORMAT_ID,
  quality: DEFAULT_QUALITY,
  maxEdge: DEFAULT_MAX_EDGE,
  fps: DEFAULT_FPS,
  mode: 'interval' as ExtractMode,
  intervalSeconds: 1,
  frameCount: 24,
});

export const MIN_INTERVAL_SECONDS = 0.05;
export const MAX_INTERVAL_SECONDS = 600;
export const MIN_FRAME_COUNT = 1;
export const MAX_FRAME_COUNT = 300;

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Coerce arbitrary input into a valid Settings object. */
export function normalizeSettings(input: unknown): Settings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<
    Record<keyof Settings, unknown>
  >;

  return {
    formatId: typeof raw.formatId === 'string' ? raw.formatId : DEFAULT_SETTINGS.formatId,
    quality: clamp(toNumber(raw.quality, DEFAULT_QUALITY), MIN_QUALITY, MAX_QUALITY),
    maxEdge: Math.max(0, Math.floor(toNumber(raw.maxEdge, DEFAULT_MAX_EDGE))),
    fps: normalizeFps(toNumber(raw.fps, DEFAULT_FPS)),
    mode: raw.mode === 'count' ? 'count' : 'interval',
    intervalSeconds: clamp(
      toNumber(raw.intervalSeconds, DEFAULT_SETTINGS.intervalSeconds),
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS,
    ),
    frameCount: Math.round(
      clamp(toNumber(raw.frameCount, DEFAULT_SETTINGS.frameCount), MIN_FRAME_COUNT, MAX_FRAME_COUNT),
    ),
  };
}

/** A fresh settings object for a new session. */
export function createSettings(overrides: Partial<Settings> = {}): Settings {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...overrides });
}
