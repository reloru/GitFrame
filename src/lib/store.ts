/**
 * In-memory collection of captured frames.
 *
 * Object URLs are released the moment a frame leaves the store — on a phone,
 * leaking a few hundred full-resolution bitmaps is the difference between a
 * working app and a tab the OS kills.
 */

export interface Frame {
  readonly id: string;
  readonly time: number;
  readonly blob: Blob;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /**
   * File extension for this frame's encoding. Stored per frame because the
   * output format can be changed between captures. File *names* are assigned at
   * export time from each frame's position, so a batch run numbers 001..N in
   * time order rather than inheriting whatever the gallery count happened to be.
   */
  readonly ext: string;
}

export type StoreListener = (frames: readonly Frame[]) => void;

export interface FrameStoreOptions {
  /** Injected so tests (and non-DOM contexts) don't need `URL`. */
  readonly revokeUrl?: (url: string) => void;
  readonly maxFrames?: number;
}

export const DEFAULT_MAX_FRAMES = 500;

export class FrameStore {
  private frames: Frame[] = [];
  private selected = new Set<string>();
  private listeners = new Set<StoreListener>();
  private counter = 0;
  private readonly revokeUrl: (url: string) => void;
  private readonly maxFrames: number;

  constructor(options: FrameStoreOptions = {}) {
    this.revokeUrl = options.revokeUrl ?? (() => {});
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  }

  /** Unique id for the next frame. Monotonic, so sort order is stable. */
  nextId(): string {
    this.counter += 1;
    return `f${this.counter}`;
  }

  get all(): readonly Frame[] {
    return this.frames;
  }

  get count(): number {
    return this.frames.length;
  }

  get isFull(): boolean {
    return this.frames.length >= this.maxFrames;
  }

  get remainingCapacity(): number {
    return Math.max(0, this.maxFrames - this.frames.length);
  }

  get totalBytes(): number {
    return this.frames.reduce((sum, frame) => sum + frame.blob.size, 0);
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  /** Selected frames, or all of them when nothing is explicitly selected. */
  get exportSet(): readonly Frame[] {
    if (this.selected.size === 0) return this.frames;
    return this.frames.filter((frame) => this.selected.has(frame.id));
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.frames);
  }

  /** Add a frame. Returns false (and releases the URL) when at capacity. */
  add(frame: Frame): boolean {
    if (this.isFull) {
      this.revokeUrl(frame.url);
      return false;
    }
    this.frames.push(frame);
    this.frames.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    this.emit();
    return true;
  }

  /** Add several frames at once, emitting a single change. */
  addMany(frames: readonly Frame[]): number {
    let added = 0;
    for (const frame of frames) {
      if (this.isFull) {
        this.revokeUrl(frame.url);
        continue;
      }
      this.frames.push(frame);
      added += 1;
    }
    if (added > 0) {
      this.frames.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
      this.emit();
    }
    return added;
  }

  get(id: string): Frame | undefined {
    return this.frames.find((frame) => frame.id === id);
  }

  remove(id: string): boolean {
    const index = this.frames.findIndex((frame) => frame.id === id);
    if (index === -1) return false;
    const [frame] = this.frames.splice(index, 1);
    if (frame) this.revokeUrl(frame.url);
    this.selected.delete(id);
    this.emit();
    return true;
  }

  removeSelected(): number {
    if (this.selected.size === 0) return 0;
    const doomed = this.frames.filter((frame) => this.selected.has(frame.id));
    this.frames = this.frames.filter((frame) => !this.selected.has(frame.id));
    for (const frame of doomed) this.revokeUrl(frame.url);
    this.selected.clear();
    this.emit();
    return doomed.length;
  }

  clear(): void {
    if (this.frames.length === 0) return;
    for (const frame of this.frames) this.revokeUrl(frame.url);
    this.frames = [];
    this.selected.clear();
    this.emit();
  }

  toggleSelection(id: string): boolean {
    if (this.selected.has(id)) {
      this.selected.delete(id);
    } else if (this.frames.some((frame) => frame.id === id)) {
      this.selected.add(id);
    } else {
      return false;
    }
    this.emit();
    return true;
  }

  selectAll(): void {
    for (const frame of this.frames) this.selected.add(frame.id);
    this.emit();
  }

  clearSelection(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.emit();
  }
}
