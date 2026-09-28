/**
 * Frame timing read straight from an MP4 / QuickTime (.mov) file.
 *
 * Both formats are built from the same nested "boxes" (ISO/IEC 14496-12, the
 * ISO base media file format, which grew out of QuickTime). The path to the
 * timing is moov → trak → mdia, where `mdhd` gives the track's timescale
 * (ticks per second), `hdlr` says whether the track is video, and
 * minf → stbl → `stts` lists every frame's duration in those ticks. Dividing
 * the timescale by a frame's duration gives the frame rate exactly — no
 * playback, no guessing, and independent of the screen the app runs on.
 *
 * Only the `moov` box is read, never the video data, so a multi-gigabyte
 * file costs no more than a small one. Anything this can't read — another
 * container, a fragmented MP4 whose timing lives in `moof` boxes, a corrupt
 * file — yields `null`, and the caller keeps the frame rate it already had.
 */

/** The slice of `Blob` this module needs. */
export interface BlobLike {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface FrameTiming {
  /** Frames per second of the video track's dominant frame duration. */
  readonly fps: number;
  /** False when frame durations vary enough that one rate doesn't describe the clip. */
  readonly constant: boolean;
  /** Frames in the video track. */
  readonly frames: number;
}

/**
 * The biggest `moov` this will load. It holds a few bytes per frame, so even
 * an hour of 240 fps footage stays in the low tens of megabytes; beyond this
 * something is wrong with the file.
 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/**
 * Share of frames that must have the most common duration for the clip to
 * count as constant-rate. Phone recordings often stretch or shorten a single
 * frame here and there (and the last frame is frequently odd), which should
 * not make an otherwise steady 60 fps clip read as variable.
 */
const CONSTANT_SHARE = 0.9;

interface Box {
  readonly type: string;
  /** Offset of the box's payload within the view. */
  readonly start: number;
  readonly end: number;
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Header of the box at `offset`, or null if it doesn't fit inside `limit`. */
function readHeader(view: DataView, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = view.getUint32(offset);
  const type = fourcc(view, offset + 4);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = Number(view.getBigUint64(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { type, start: offset + header, end: offset + size };
}

function children(view: DataView, parent: Box): Box[] {
  const found: Box[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const box = readHeader(view, offset, parent.end);
    if (!box) break;
    found.push(box);
    offset = box.end;
  }
  return found;
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  return children(view, parent).find((box) => box.type === type);
}

/** Ticks per second, from `mdhd` (versions 0 and 1 differ only in field widths). */
function readTimescale(view: DataView, mdhd: Box): number | null {
  const version = view.getUint8(mdhd.start);
  const at = mdhd.start + (version === 1 ? 20 : 12);
  if (at + 4 > mdhd.end) return null;
  return view.getUint32(at);
}

/** The handler type: 'vide' for video in both MP4 and QuickTime. */
function readHandler(view: DataView, hdlr: Box): string | null {
  // version+flags (4), then pre_defined (MP4) / component type (QuickTime) (4).
  const at = hdlr.start + 8;
  return at + 4 <= hdlr.end ? fourcc(view, at) : null;
}

/** `stts` as [frame count, duration in ticks] runs. */
function readStts(view: DataView, stts: Box): Array<[number, number]> {
  const entries = view.getUint32(stts.start + 4);
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < entries; i += 1) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) break;
    runs.push([view.getUint32(at), view.getUint32(at + 4)]);
  }
  return runs;
}

/** Frame timing of the first video track in a parsed `moov`, or null. */
function timingFromMoov(view: DataView, moov: Box): FrameTiming | null {
  for (const trak of children(view, moov)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(view, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(view, mdia, 'hdlr');
    if (!hdlr || readHandler(view, hdlr) !== 'vide') continue;
    const mdhd = child(view, mdia, 'mdhd');
    const minf = child(view, mdia, 'minf');
    const stbl = minf && child(view, minf, 'stbl');
    const stts = stbl && child(view, stbl, 'stts');
    if (!mdhd || !stts) continue;

    const timescale = readTimescale(view, mdhd);
    const runs = readStts(view, stts).filter(([count, delta]) => count > 0 && delta > 0);
    if (!timescale || runs.length === 0) continue;

    const byDelta = new Map<number, number>();
    let frames = 0;
    for (const [count, delta] of runs) {
      byDelta.set(delta, (byDelta.get(delta) ?? 0) + count);
      frames += count;
    }
    let dominant = 0;
    let dominantCount = 0;
    for (const [delta, count] of byDelta) {
      if (count > dominantCount) {
        dominant = delta;
        dominantCount = count;
      }
    }
    return {
      fps: timescale / dominant,
      constant: dominantCount / frames >= CONSTANT_SHARE,
      frames,
    };
  }
  return null;
}

async function readRange(file: BlobLike, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/**
 * Find the top-level `moov` box by hopping from header to header. `mdat`,
 * which holds the video itself, is skipped over without being read, whether
 * `moov` comes before it or after it.
 */
export async function readFrameTiming(file: BlobLike): Promise<FrameTiming | null> {
  try {
    let offset = 0;
    while (offset + 8 <= file.size) {
      const head = await readRange(file, offset, Math.min(file.size, offset + 16));
      let size = head.getUint32(0);
      const type = fourcc(head, 4);
      let header = 8;
      if (size === 1) {
        if (head.byteLength < 16) return null;
        size = Number(head.getBigUint64(8));
        header = 16;
      } else if (size === 0) {
        size = file.size - offset;
      }
      if (size < header || offset + size > file.size) return null;
      if (type === 'moov') return await parseMoov(file, offset + header, offset + size);
      offset += size;
    }
    return null;
  } catch {
    return null;
  }
}

async function parseMoov(file: BlobLike, start: number, end: number): Promise<FrameTiming | null> {
  if (end - start > MAX_MOOV_BYTES) return null;
  const view = await readRange(file, start, end);
  return timingFromMoov(view, { type: 'moov', start: 0, end: view.byteLength });
}

