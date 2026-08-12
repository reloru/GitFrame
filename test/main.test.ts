// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrap, downloadBlob } from '../src/app/main.js';
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
