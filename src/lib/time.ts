/** Time and frame-rate helpers. Pure functions, no DOM. */

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** True when `value` is a real, finite, non-negative number. */
export function isUsableTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function pad(value: number, width: number): string {
  return Math.floor(value).toString().padStart(width, '0');
}

/**
 * Format seconds as `M:SS.mmm`, widening to `H:MM:SS.mmm` past an hour.
 * Used for the scrubber read-out, so it stays short on narrow screens.
 */
export function formatTimecode(seconds: number): string {
  const safe = isUsableTime(seconds) ? seconds : 0;
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  const tail = `${pad(s, 2)}.${pad(ms, 3)}`;
  return h > 0 ? `${h}:${pad(m, 2)}:${tail}` : `${m}:${tail}`;
}

/** Format seconds as a compact `M:SS` label for durations and chips. */
export function formatShortDuration(seconds: number): string {
  const safe = isUsableTime(seconds) ? seconds : 0;
  const totalSeconds = Math.round(safe);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}

/** A timecode with no separators, safe to drop into a file name. */
export function timecodeSlug(seconds: number): string {
  const safe = isUsableTime(seconds) ? seconds : 0;
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h, 2)}h${pad(m, 2)}m${pad(s, 2)}s${pad(ms, 3)}`;
}

export const MIN_FPS = 1;
export const MAX_FPS = 240;
export const DEFAULT_FPS = 30;

/** Coerce arbitrary user input into a sane frame rate. */
export function normalizeFps(value: unknown, fallback: number = DEFAULT_FPS): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return clamp(parsed, MIN_FPS, MAX_FPS);
}

/** Seconds occupied by a single frame at `fps`. */
export function frameDuration(fps: number): number {
  return 1 / normalizeFps(fps);
}

/** Zero-based frame index containing `time`. */
export function frameIndexAt(time: number, fps: number): number {
  if (!isUsableTime(time)) return 0;
  return Math.floor(time * normalizeFps(fps) + 1e-6);
}

/** Start time of frame `index`, nudged inside the frame to survive rounding. */
export function timeForFrame(index: number, fps: number): number {
  const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  const step = frameDuration(fps);
  return safeIndex * step + step / 2;
}

/**
 * Step `offset` whole frames from `time`, clamped to [0, duration].
 * Snapping to frame centres keeps repeated taps from drifting.
 */
export function stepByFrames(time: number, offset: number, fps: number, duration: number): number {
  const step = frameDuration(fps);
  const current = isUsableTime(time) ? time : 0;
  const index = Math.round(current / step);
  const next = (index + Math.trunc(offset)) * step;
  const max = isUsableTime(duration) && duration > 0 ? Math.max(0, duration - step / 2) : 0;
  return clamp(next, 0, max);
}
