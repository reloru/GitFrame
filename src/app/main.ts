/** Browser entry point. Wires the real browser APIs into the controller. */

import { createApp, type AppHandle, type ShareCandidate, type ShareOutcome } from './ui.js';

/**
 * Save a blob to the device.
 *
 * The object URL is released on a timer rather than immediately — Safari
 * cancels the download if the URL dies before the save sheet appears.
 */
export function downloadBlob(doc: Document, blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Offer frames to the OS share sheet via the Web Share API (Level 2, files).
 * This is what gets a phone user to "Save Image" / "Save N Images" straight
 * into their photo library instead of the browser's Files download.
 *
 * Feature-detected rather than UA-sniffed: iOS Safari, Android Chrome, and a
 * few desktop browsers support it; Firefox and most of desktop do not, and
 * `canShare` is the only reliable way to know before trying — it's also what
 * catches a batch that's too large or too numerous for the platform's limits.
 */
export async function shareFiles(files: readonly ShareCandidate[]): Promise<ShareOutcome> {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return 'unsupported';
  }

  let shareable: File[];
  try {
    shareable = files.map(
      (file) => new File([file.blob], file.filename, { type: file.blob.type || 'application/octet-stream' }),
    );
    if (!navigator.canShare({ files: shareable })) return 'unsupported';
  } catch {
    return 'unsupported';
  }

  try {
    await navigator.share({ files: shareable });
    return 'shared';
  } catch (error) {
    // The user backing out of the share sheet is not a failure to fall back
    // from — falling back would silently start a download right after they
    // said no.
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}

export function bootstrap(doc: Document): AppHandle {
  return createApp({
    document: doc,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    triggerDownload: (blob, filename) => downloadBlob(doc, blob, filename),
    shareFiles,
  });
}

/* c8 ignore start -- browser-only bootstrap, exercised by hand not by tests */
if (typeof document !== 'undefined' && document.getElementById('empty-state')) {
  bootstrap(document);
}
/* c8 ignore stop */
