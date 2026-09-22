/**
 * Duplicate-grab detection.
 *
 * A grab is identified by the video it came from plus the position on that
 * video's timeline — never by comparing pixels, which would cost a full decode
 * per candidate on a phone.
 *
 * The timeline position is matched within a fixed tolerance rather than by
 * exact float equality, because the scrubber writes arbitrary millisecond
 * values into `currentTime` (`step="0.001"` in index.html) and a round trip
 * through the transport controls need not land on the same float. The tolerance
 * is deliberately *not* derived from the fps setting: that value is typed by the
 * user, not read from the file, and a window of `1/fps` would be wider than a
 * real frame on any clip whose true rate is higher — merging two genuinely
 * different frames into one "duplicate". One millisecond is below the 4.17ms
 * duration of a frame at MAX_FPS (240), so no two distinct frames the app can
 * address ever fall inside one window.
 */

import { qualityFor, formatById } from './format.js';
import type { Settings } from './settings.js';
import { isUsableTime } from './time.js';

/** Timeline distance within which two grabs are the same frame. Seconds. */
export const DUPLICATE_TOLERANCE_SECONDS = 0.001;

/** The `File` fields used to tell one loaded video from another. */
export interface VideoSource {
  readonly name?: unknown;
  readonly size?: unknown;
  readonly lastModified?: unknown;
}

/**
 * Stable identifier for a loaded video.
 *
 * Size and modification time lead so that a name containing the separator can't
 * be read as another field. Re-loading the same file later in the session
 * reproduces the key, which is what lets the check survive a change of video
 * and back again.
 */
export function videoKeyFor(source: VideoSource | null | undefined): string {
  if (!source) return '';
  const name = typeof source.name === 'string' ? source.name : '';
  const size = typeof source.size === 'number' && Number.isFinite(source.size) ? Math.floor(source.size) : -1;
  const modified =
    typeof source.lastModified === 'number' && Number.isFinite(source.lastModified)
      ? Math.floor(source.lastModified)
      : -1;
  return `${size}:${modified}:${name}`;
}

/**
 * Everything about the current settings that changes the bytes a capture
 * produces. Two grabs of one moment with different signatures are different
 * images, and the UI says so rather than calling them identical.
 */
export function outputSignature(settings: Settings): string {
  const format = formatById(settings.formatId);
  const quality = qualityFor(format, settings.quality);
  const crop = settings.crop
    ? `${settings.crop.x},${settings.crop.y},${settings.crop.width},${settings.crop.height}`
    : 'none';
  return `${format.id}:${quality === undefined ? '-' : quality.toFixed(2)}:${Math.max(
    0,
    Math.floor(settings.maxEdge),
  )}:${crop}`;
}

/** The parts of a capture that decide whether it duplicates another. */
export interface GrabIdentity {
  readonly videoKey: string;
  readonly time: number;
  readonly signature: string;
}

/** `exact` means byte-for-byte the same capture; `settings` means same moment, different output. */
export type DuplicateKind = 'exact' | 'settings';

export interface DuplicateMatch<T> {
  readonly frame: T;
  readonly kind: DuplicateKind;
}

/** True when two grabs address the same moment of the same video. */
export function isSameMoment(
  a: GrabIdentity,
  b: GrabIdentity,
  tolerance: number = DUPLICATE_TOLERANCE_SECONDS,
): boolean {
  // An empty key means the video couldn't be identified. Two unidentified
  // grabs are not evidence of a duplicate, and warning on one would be worse
  // than missing it.
  if (a.videoKey === '' || a.videoKey !== b.videoKey) return false;
  if (!isUsableTime(a.time) || !isUsableTime(b.time)) return false;
  return Math.abs(a.time - b.time) <= tolerance;
}

/** True when two grabs would produce the same file: same moment, same output settings. */
export function isSameGrab(
  a: GrabIdentity,
  b: GrabIdentity,
  tolerance: number = DUPLICATE_TOLERANCE_SECONDS,
): boolean {
  return a.signature === b.signature && isSameMoment(a, b, tolerance);
}

/**
 * Find an already-captured frame that `candidate` duplicates.
 *
 * An `exact` match wins over a `settings` one wherever both exist, so the
 * message names the stronger case. Among equals the nearest in time is picked,
 * which is the frame the user most likely means.
 */
export function findDuplicate<T extends GrabIdentity>(
  frames: readonly T[],
  candidate: GrabIdentity,
  tolerance: number = DUPLICATE_TOLERANCE_SECONDS,
): DuplicateMatch<T> | null {
  let best: DuplicateMatch<T> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const frame of frames) {
    if (!isSameMoment(frame, candidate, tolerance)) continue;
    const kind: DuplicateKind = frame.signature === candidate.signature ? 'exact' : 'settings';
    const delta = Math.abs(frame.time - candidate.time);
    const better = best === null || (kind === 'exact' && best.kind === 'settings') || (kind === best.kind && delta < bestDelta);
    if (better) {
      best = { frame, kind };
      bestDelta = delta;
    }
  }

  return best;
}
