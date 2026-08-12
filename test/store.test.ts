import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FrameStore, type Frame } from '../src/lib/store.js';

function makeFrame(store: FrameStore, time: number, size = 10): Frame {
  return {
    id: store.nextId(),
    time,
    blob: new Blob([new Uint8Array(size)]),
    url: `blob:${time}`,
    width: 100,
    height: 50,
    ext: 'jpg',
  };
}

describe('FrameStore', () => {
  let revoke: ReturnType<typeof vi.fn>;
  let store: FrameStore;

  beforeEach(() => {
    revoke = vi.fn();
    store = new FrameStore({ revokeUrl: revoke });
  });

  it('issues monotonic ids', () => {
    expect(store.nextId()).toBe('f1');
    expect(store.nextId()).toBe('f2');
  });

  it('keeps frames sorted by time regardless of capture order', () => {
    store.add(makeFrame(store, 5));
    store.add(makeFrame(store, 1));
    store.add(makeFrame(store, 3));
    expect(store.all.map((frame) => frame.time)).toEqual([1, 3, 5]);
  });

  it('notifies subscribers and can unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.add(makeFrame(store, 1));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.add(makeFrame(store, 2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports totals', () => {
    store.add(makeFrame(store, 1, 100));
    store.add(makeFrame(store, 2, 250));
    expect(store.count).toBe(2);
    expect(store.totalBytes).toBe(350);
  });

  it('refuses frames past capacity and releases their URLs', () => {
    const small = new FrameStore({ revokeUrl: revoke, maxFrames: 2 });
    expect(small.add(makeFrame(small, 1))).toBe(true);
    expect(small.add(makeFrame(small, 2))).toBe(true);
    expect(small.isFull).toBe(true);
    expect(small.remainingCapacity).toBe(0);

    const rejected = makeFrame(small, 3);
    expect(small.add(rejected)).toBe(false);
    expect(revoke).toHaveBeenCalledWith(rejected.url);
    expect(small.count).toBe(2);
  });

  it('adds many frames in one notification and stops at capacity', () => {
    const small = new FrameStore({ revokeUrl: revoke, maxFrames: 2 });
    const listener = vi.fn();
    small.subscribe(listener);

    const added = small.addMany([
      makeFrame(small, 3),
      makeFrame(small, 1),
      makeFrame(small, 2),
    ]);

    expect(added).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(small.all.map((f) => f.time)).toEqual([1, 3]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('does not notify when addMany adds nothing', () => {
    const full = new FrameStore({ revokeUrl: revoke, maxFrames: 0 });
    const listener = vi.fn();
    full.subscribe(listener);
    expect(full.addMany([makeFrame(full, 1)])).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('finds and removes frames, releasing their URLs', () => {
    const frame = makeFrame(store, 1);
    store.add(frame);
    expect(store.get(frame.id)).toBe(frame);
    expect(store.get('missing')).toBeUndefined();

    expect(store.remove(frame.id)).toBe(true);
    expect(revoke).toHaveBeenCalledWith(frame.url);
    expect(store.remove(frame.id)).toBe(false);
  });

  it('toggles selection and ignores unknown ids', () => {
    const frame = makeFrame(store, 1);
    store.add(frame);

    expect(store.toggleSelection(frame.id)).toBe(true);
    expect(store.isSelected(frame.id)).toBe(true);
    expect(store.selectedCount).toBe(1);

    expect(store.toggleSelection(frame.id)).toBe(true);
    expect(store.isSelected(frame.id)).toBe(false);

    expect(store.toggleSelection('nope')).toBe(false);
  });

  it('exports everything when nothing is selected, and the selection otherwise', () => {
    const a = makeFrame(store, 1);
    const b = makeFrame(store, 2);
    store.add(a);
    store.add(b);

    expect(store.exportSet).toHaveLength(2);
    store.toggleSelection(b.id);
    expect(store.exportSet).toEqual([b]);
  });

  it('selects and clears the whole set', () => {
    store.add(makeFrame(store, 1));
    store.add(makeFrame(store, 2));

    store.selectAll();
    expect(store.selectedCount).toBe(2);

    store.clearSelection();
    expect(store.selectedCount).toBe(0);
    // A no-op clear must not emit.
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearSelection();
    expect(listener).not.toHaveBeenCalled();
  });

  it('removes only the selected frames', () => {
    const a = makeFrame(store, 1);
    const b = makeFrame(store, 2);
    store.add(a);
    store.add(b);
    store.toggleSelection(a.id);

    expect(store.removeSelected()).toBe(1);
    expect(store.all).toEqual([b]);
    expect(revoke).toHaveBeenCalledWith(a.url);
    expect(store.removeSelected()).toBe(0);
  });

  it('clears everything and releases every URL', () => {
    store.add(makeFrame(store, 1));
    store.add(makeFrame(store, 2));
    store.clear();
    expect(store.count).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(2);

    // Clearing an empty store must not emit.
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it('works without a revoke hook', () => {
    const bare = new FrameStore();
    const frame = makeFrame(bare, 1);
    bare.add(frame);
    expect(() => bare.clear()).not.toThrow();
  });
});
