// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrap, downloadBlob, shareFiles } from '../src/app/main.js';
import { mountMarkup, patchVideo } from './helpers/dom.js';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

/**
 * Following a download anchor makes jsdom log an unimplemented-navigation
 * error. The click itself is what we're testing, so swallow the default action.
 */
const swallowNavigation = (event: Event): void => {
  if ((event.target as HTMLElement).tagName === 'A') event.preventDefault();
};

beforeEach(() => {
  document.addEventListener('click', swallowNavigation, true);
});

afterEach(() => {
  document.removeEventListener('click', swallowNavigation, true);
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.useRealTimers();
  // jsdom has no Web Share API of its own; strip whatever a test attached to
  // the shared navigator so it doesn't leak into the next one.
  delete (navigator as unknown as Record<string, unknown>).share;
  delete (navigator as unknown as Record<string, unknown>).canShare;
});

describe('downloadBlob', () => {
  it('clicks a temporary anchor and cleans it up', () => {
    URL.createObjectURL = vi.fn(() => 'blob:download');
    URL.revokeObjectURL = vi.fn();

    const clicks: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = realCreate(tag) as HTMLElement;
      if (tag === 'a') {
        node.addEventListener('click', () => clicks.push(node as HTMLAnchorElement));
      }
      return node;
    });

    downloadBlob(document, new Blob(['x']), 'frame_001.jpg');

    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe('frame_001.jpg');
    expect(clicks[0]!.getAttribute('href')).toBe('blob:download');
    expect(clicks[0]!.rel).toBe('noopener');
    // The anchor must not be left behind in the document.
    expect(document.querySelector('a[download]')).toBeNull();

    vi.restoreAllMocks();
  });

  it('holds the object URL open long enough for the save sheet', () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => 'blob:download');
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;

    downloadBlob(document, new Blob(['x']), 'a.jpg');

    // Still alive immediately after the click — Safari cancels otherwise.
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revoke).toHaveBeenCalledWith('blob:download');
  });
});

describe('shareFiles', () => {
  const candidate = { blob: new Blob(['x'], { type: 'image/jpeg' }), filename: 'a.jpg' };

  it('is unsupported when the browser has no Web Share API at all', async () => {
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
  });

  it('is unsupported when share exists but canShare does not', async () => {
    (navigator as unknown as { share: unknown }).share = vi.fn();
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
  });

  it('is unsupported when canShare declines the payload', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn(() => false);
    (navigator as unknown as { share: unknown }).share = vi.fn();
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
    expect(navigator.share).not.toHaveBeenCalled();
  });

  it('is unsupported when canShare itself throws', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn(() => {
      throw new Error('nope');
    });
    (navigator as unknown as { share: unknown }).share = vi.fn();
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
  });

  it('shares real File objects built from each blob', async () => {
    const canShare = vi.fn((_data?: ShareData) => true);
    const share = vi.fn((_data?: ShareData) => Promise.resolve());
    (navigator as unknown as { canShare: unknown }).canShare = canShare;
    (navigator as unknown as { share: unknown }).share = share;

    await expect(
      shareFiles([
        candidate,
        { blob: new Blob(['y'], { type: 'image/png' }), filename: 'b.png' },
      ]),
    ).resolves.toBe('shared');

    const files = canShare.mock.calls[0]![0]!.files!;
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe('a.jpg');
    expect(files[0]!.type).toBe('image/jpeg');
    expect(files[1]!.name).toBe('b.png');
    // canShare and share must be asked about the exact same File objects.
    expect(share.mock.calls[0]![0]!.files).toBe(files);
  });

  it('falls back to the octet-stream type when a blob has none', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn((_data?: ShareData) => true);
    const share = vi.fn((_data?: ShareData) => Promise.resolve());
    (navigator as unknown as { share: unknown }).share = share;

    await shareFiles([{ blob: new Blob(['x']), filename: 'blob.bin' }]);

    const files = share.mock.calls[0]![0]!.files!;
    expect(files[0]!.type).toBe('application/octet-stream');
  });

  it('reports a user-cancelled share sheet without falling back', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn(() => true);
    (navigator as unknown as { share: unknown }).share = vi.fn(() =>
      Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
    );
    await expect(shareFiles([candidate])).resolves.toBe('cancelled');
  });

  it('treats any other share failure as unsupported so the caller can fall back', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn(() => true);
    (navigator as unknown as { share: unknown }).share = vi.fn(() =>
      Promise.reject(new DOMException('Not allowed.', 'NotAllowedError')),
    );
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
  });

  it('treats a non-DOMException share rejection as unsupported', async () => {
    (navigator as unknown as { canShare: unknown }).canShare = vi.fn(() => true);
    (navigator as unknown as { share: unknown }).share = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(shareFiles([candidate])).resolves.toBe('unsupported');
  });
});

describe('bootstrap', () => {
  it('wires the real browser APIs into a working app', async () => {
    mountMarkup(document);
    patchVideo(document.getElementById('video') as HTMLVideoElement, { duration: 5 });

    URL.createObjectURL = vi.fn(() => 'blob:source');
    URL.revokeObjectURL = vi.fn();

    const app = bootstrap(document);

    expect(app.store.count).toBe(0);
    expect(app.settings.formatId).toBe('jpeg');
    expect(document.getElementById('workspace')!.hidden).toBe(true);

    app.destroy();
  });
});
