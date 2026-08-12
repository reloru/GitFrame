/** Output sizing maths. Keeping frames small is what stops phones running out of memory. */

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Longest-edge presets offered in the UI. `0` means "keep original size". */
export const SIZE_PRESETS = [
  { value: 0, label: 'Full' },
  { value: 1920, label: '1920' },
  { value: 1280, label: '1280' },
  { value: 720, label: '720' },
] as const;

export const DEFAULT_MAX_EDGE = 1920;

/**
 * Scale `source` down so its longest edge is at most `maxEdge`, preserving
 * aspect ratio. `maxEdge <= 0` disables scaling. Never upscales.
 */
export function fitToMaxEdge(source: Size, maxEdge: number): Size {
  const width = Math.floor(source.width);
  const height = Math.floor(source.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) {
    return { width, height };
  }

  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** Rough uncompressed byte cost of a frame, used for the memory warning. */
export function estimateFrameBytes(size: Size): number {
  if (size.width <= 0 || size.height <= 0) return 0;
  return size.width * size.height * 4;
}
