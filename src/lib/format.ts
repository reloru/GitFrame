/** Output image formats offered by the extractor. */

export interface ImageFormat {
  readonly id: string;
  readonly label: string;
  readonly mime: string;
  readonly ext: string;
  /** Lossy formats accept a quality value; lossless ones ignore it. */
  readonly lossy: boolean;
}

export const IMAGE_FORMATS: readonly ImageFormat[] = [
  { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
  { id: 'jpeg', label: 'JPG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  { id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true },
];

export const DEFAULT_FORMAT_ID = 'jpeg';

/** Look up a format, falling back to the default for unknown ids. */
export function formatById(id: string | null | undefined): ImageFormat {
  const found = IMAGE_FORMATS.find((format) => format.id === id);
  if (found) return found;
  const fallback = IMAGE_FORMATS.find((format) => format.id === DEFAULT_FORMAT_ID);
  // The default id is always present in IMAGE_FORMATS; the `?? [0]` keeps
  // TypeScript happy without an assertion.
  return fallback ?? IMAGE_FORMATS[0]!;
}

export const MIN_QUALITY = 0.3;
export const MAX_QUALITY = 1;
export const DEFAULT_QUALITY = 0.92;

/** Clamp a quality value, or return undefined when the format ignores it. */
export function qualityFor(format: ImageFormat, quality: number): number | undefined {
  if (!format.lossy) return undefined;
  if (!Number.isFinite(quality)) return DEFAULT_QUALITY;
  return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, quality));
}

/** Human-readable byte size, e.g. `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
