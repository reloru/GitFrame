/** File naming for exported frames. */

import { timecodeSlug } from './time.js';

const UNSAFE = /[^a-zA-Z0-9-_]+/g;
const MAX_BASE_LENGTH = 48;

/**
 * Turn an arbitrary video file name into a safe file-name stem.
 * Strips the extension, collapses unsafe runs to `-`, and truncates.
 */
export function sanitizeBaseName(input: string | null | undefined, fallback = 'frame'): string {
  if (typeof input !== 'string') return fallback;
  const withoutExt = input.replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExt.replace(UNSAFE, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return fallback;
  return cleaned.slice(0, MAX_BASE_LENGTH);
}

/** Zero-padded sequence number wide enough for `total` items (min 3 digits). */
export function sequenceWidth(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 3;
  return Math.max(3, String(Math.floor(total)).length);
}

export interface FrameNameParts {
  readonly base: string;
  readonly index: number;
  readonly time: number;
  readonly ext: string;
  readonly total?: number;
}

/** Build a frame file name like `clip_004_00h00m12s500.jpg`. */
export function frameFileName(parts: FrameNameParts): string {
  const width = sequenceWidth(parts.total ?? 0);
  const seq = String(Math.max(1, Math.floor(parts.index))).padStart(width, '0');
  return `${sanitizeBaseName(parts.base)}_${seq}_${timecodeSlug(parts.time)}.${parts.ext}`;
}

/** Name for the bundled download of a whole extraction run. */
export function zipFileName(base: string): string {
  return `${sanitizeBaseName(base)}_frames.zip`;
}

/** Make `name` unique against `taken` by appending `-2`, `-3`, ... */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem}-${counter}${ext}`;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  return candidate;
}
