/** Browser entry point. Wires the real browser APIs into the controller. */

import { createApp, type AppHandle } from './ui.js';

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

export function bootstrap(doc: Document): AppHandle {
  return createApp({
    document: doc,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    triggerDownload: (blob, filename) => downloadBlob(doc, blob, filename),
  });
}

/* c8 ignore start -- browser-only bootstrap, exercised by hand not by tests */
if (typeof document !== 'undefined' && document.getElementById('empty-state')) {
  bootstrap(document);
}
/* c8 ignore stop */
