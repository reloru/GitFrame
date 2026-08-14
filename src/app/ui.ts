/**
 * DOM controller.
 *
 * Every browser capability the controller needs is injected, so the whole thing
 * runs under jsdom against a fake video element. Nothing here touches the
 * network, and nothing is persisted — see `lib/settings.ts`.
 */

import { IMAGE_FORMATS, formatBytes, formatById } from '../lib/format.js';
import { frameFileName, sanitizeBaseName, uniqueName, zipFileName } from '../lib/naming.js';
import { MAX_PLAN_FRAMES, buildPlan, describePlan } from '../lib/plan.js';
import { SIZE_PRESETS, fitToMaxEdge } from '../lib/scale.js';
import {
  MAX_FRAME_COUNT,
  MAX_INTERVAL_SECONDS,
  MIN_FRAME_COUNT,
  MIN_INTERVAL_SECONDS,
  type Settings,
  createSettings,
} from '../lib/settings.js';
import { FrameStore, type Frame } from '../lib/store.js';
import {
  MAX_FPS,
  MIN_FPS,
  clamp,
  formatShortDuration,
  formatTimecode,
  normalizeFps,
  stepByFrames,
} from '../lib/time.js';
import { buildZip, type ZipEntry } from '../lib/zip.js';
import {
  type CanvasLike,
  type TimerLike,
  type VideoLike,
  createCanvasRenderer,
  extractFrames,
  seekTo,
} from './extractor.js';

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported';

export interface ShareCandidate {
  readonly blob: Blob;
  readonly filename: string;
}

export interface UiDeps {
  readonly document: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly triggerDownload: (blob: Blob, filename: string) => void;
  readonly createCanvas?: () => CanvasLike;
  readonly timers?: TimerLike;
  readonly yieldToUi?: () => Promise<void>;
  /**
   * Hand frames to the OS share sheet (Save to Photos on iOS, etc). Optional
   * because it has no jsdom equivalent; when omitted, or when it resolves
   * 'unsupported', export falls back to a direct/zip download.
   */
  readonly shareFiles?: (files: readonly ShareCandidate[]) => Promise<ShareOutcome>;
}

export interface AppHandle {
  readonly store: FrameStore;
  readonly settings: Settings;
  /** Resolves once any in-flight capture or export has finished. */
  whenIdle(): Promise<void>;
  destroy(): void;
}

/** Look up a required element, failing loudly if the markup drifts. */
function must<T extends Element>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as unknown as T;
}

export function createApp(deps: UiDeps): AppHandle {
  const doc = deps.document;
  const settings = createSettings();
  const store = new FrameStore({ revokeUrl: deps.revokeObjectURL });

  const el = {
    emptyState: must<HTMLElement>(doc, 'empty-state'),
    pickBtn: must<HTMLButtonElement>(doc, 'pick-btn'),
    fileInput: must<HTMLInputElement>(doc, 'file-input'),
    loadError: must<HTMLElement>(doc, 'load-error'),
    workspace: must<HTMLElement>(doc, 'workspace'),
    video: must<HTMLVideoElement>(doc, 'video'),
    videoMeta: must<HTMLElement>(doc, 'video-meta'),
    scrub: must<HTMLInputElement>(doc, 'scrub'),
    timeCurrent: must<HTMLElement>(doc, 'time-current'),
    timeTotal: must<HTMLElement>(doc, 'time-total'),
    backSecond: must<HTMLButtonElement>(doc, 'back-second'),
    backFrame: must<HTMLButtonElement>(doc, 'back-frame'),
    playToggle: must<HTMLButtonElement>(doc, 'play-toggle'),
    playIcon: must<HTMLElement>(doc, 'play-icon'),
    fwdFrame: must<HTMLButtonElement>(doc, 'fwd-frame'),
    fwdSecond: must<HTMLButtonElement>(doc, 'fwd-second'),
    grabBtn: must<HTMLButtonElement>(doc, 'grab-btn'),
    rangeStartBtn: must<HTMLButtonElement>(doc, 'range-start-btn'),
    rangeEndBtn: must<HTMLButtonElement>(doc, 'range-end-btn'),
    rangeStartTime: must<HTMLElement>(doc, 'range-start-time'),
    rangeEndTime: must<HTMLElement>(doc, 'range-end-time'),
    rangeReset: must<HTMLButtonElement>(doc, 'range-reset'),
    modeInterval: must<HTMLButtonElement>(doc, 'mode-interval'),
    modeCount: must<HTMLButtonElement>(doc, 'mode-count'),
    intervalField: must<HTMLElement>(doc, 'interval-field'),
    intervalInput: must<HTMLInputElement>(doc, 'interval-input'),
    intervalMinus: must<HTMLButtonElement>(doc, 'interval-minus'),
    intervalPlus: must<HTMLButtonElement>(doc, 'interval-plus'),
    countField: must<HTMLElement>(doc, 'count-field'),
    countInput: must<HTMLInputElement>(doc, 'count-input'),
    countMinus: must<HTMLButtonElement>(doc, 'count-minus'),
    countPlus: must<HTMLButtonElement>(doc, 'count-plus'),
    planSummary: must<HTMLElement>(doc, 'plan-summary'),
    autoBtn: must<HTMLButtonElement>(doc, 'auto-btn'),
    formatGroup: must<HTMLElement>(doc, 'format-group'),
    qualityField: must<HTMLElement>(doc, 'quality-field'),
    quality: must<HTMLInputElement>(doc, 'quality'),
    qualityValue: must<HTMLElement>(doc, 'quality-value'),
    sizeGroup: must<HTMLElement>(doc, 'size-group'),
    fpsInput: must<HTMLInputElement>(doc, 'fps-input'),
    fpsMinus: must<HTMLButtonElement>(doc, 'fps-minus'),
    fpsPlus: must<HTMLButtonElement>(doc, 'fps-plus'),
    changeVideo: must<HTMLButtonElement>(doc, 'change-video'),
    gallerySection: must<HTMLElement>(doc, 'gallery-section'),
    gallery: must<HTMLElement>(doc, 'gallery'),
    galleryCount: must<HTMLElement>(doc, 'gallery-count'),
    galleryHint: must<HTMLElement>(doc, 'gallery-hint'),
    selectAll: must<HTMLButtonElement>(doc, 'select-all'),
    deleteSelected: must<HTMLButtonElement>(doc, 'delete-selected'),
    clearAll: must<HTMLButtonElement>(doc, 'clear-all'),
    dock: must<HTMLElement>(doc, 'dock'),
    downloadZip: must<HTMLButtonElement>(doc, 'download-zip'),
    downloadLabel: must<HTMLElement>(doc, 'download-label'),
    overlay: must<HTMLElement>(doc, 'progress-overlay'),
    progressBar: must<HTMLElement>(doc, 'progress-bar'),
    progressLabel: must<HTMLElement>(doc, 'progress-label'),
    progressDetail: must<HTMLElement>(doc, 'progress-detail'),
    cancelBtn: must<HTMLButtonElement>(doc, 'cancel-btn'),
    toast: must<HTMLElement>(doc, 'toast'),
  };

  const video = el.video as unknown as VideoLike & HTMLVideoElement;
  const cleanups: Array<() => void> = [];
  let sourceUrl: string | null = null;
  let baseName = 'frame';
  let busy: Promise<void> = Promise.resolve();
  let abort: AbortController | null = null;
  let toastTimer: unknown;
  let scrubbing = false;

  const timers: TimerLike = deps.timers ?? {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  function on<K extends string>(
    target: EventTarget,
    type: K,
    handler: (event: Event) => void,
  ): void {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }

  /* ---------------------------------------------------------------- */
  /* Feedback                                                          */
  /* ---------------------------------------------------------------- */

  function toast(message: string): void {
    el.toast.textContent = message;
    el.toast.hidden = false;
    timers.clearTimeout(toastTimer);
    toastTimer = timers.setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function showError(message: string): void {
    el.loadError.textContent = message;
    el.loadError.hidden = false;
  }

  function clearError(): void {
    el.loadError.textContent = '';
    el.loadError.hidden = true;
  }

  /* ---------------------------------------------------------------- */
  /* Settings widgets                                                  */
  /* ---------------------------------------------------------------- */

  function buildSegmented(
    host: HTMLElement,
    options: ReadonlyArray<{ value: string; label: string }>,
    isActive: (value: string) => boolean,
    onPick: (value: string) => void,
  ): () => void {
    const buttons: HTMLButtonElement[] = [];
    host.replaceChildren();
    for (const option of options) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'segmented__btn';
      button.textContent = option.label;
      button.dataset.value = option.value;
      button.setAttribute('role', 'radio');
      on(button, 'click', () => {
        onPick(option.value);
      });
      host.appendChild(button);
      buttons.push(button);
    }
    return () => {
      for (const button of buttons) {
        const active = isActive(button.dataset.value ?? '');
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      }
    };
  }

  const syncFormatButtons = buildSegmented(
    el.formatGroup,
    IMAGE_FORMATS.map((format) => ({ value: format.id, label: format.label })),
    (value) => value === settings.formatId,
    (value) => {
      settings.formatId = value;
      renderSettings();
    },
  );

  const syncSizeButtons = buildSegmented(
    el.sizeGroup,
    SIZE_PRESETS.map((preset) => ({ value: String(preset.value), label: preset.label })),
    (value) => Number(value) === settings.maxEdge,
    (value) => {
      settings.maxEdge = Number(value);
      renderSettings();
    },
  );

  function renderSettings(): void {
    const format = formatById(settings.formatId);
    syncFormatButtons();
    syncSizeButtons();
    el.qualityField.hidden = !format.lossy;
    el.quality.value = String(Math.round(settings.quality * 100));
    el.qualityValue.textContent = `${Math.round(settings.quality * 100)}%`;
    el.fpsInput.value = String(settings.fps);
    el.intervalInput.value = String(settings.intervalSeconds);
    el.countInput.value = String(settings.frameCount);

    const isInterval = settings.mode === 'interval';
    el.intervalField.hidden = !isInterval;
    el.countField.hidden = isInterval;
    el.modeInterval.classList.toggle('is-active', isInterval);
    el.modeCount.classList.toggle('is-active', !isInterval);
    el.modeInterval.setAttribute('aria-checked', isInterval ? 'true' : 'false');
    el.modeCount.setAttribute('aria-checked', isInterval ? 'false' : 'true');

    renderRange();
    renderPlanSummary();
  }

  /** Whether the range fields describe a usable (non-empty, ordered) span. */
  function isRangeValid(): boolean {
    return settings.rangeEnd <= 0 || settings.rangeStart < settings.rangeEnd;
  }

  function renderRange(): void {
    el.rangeStartTime.textContent = formatTimecode(settings.rangeStart);
    const hasEnd = settings.rangeEnd > 0;
    el.rangeEndTime.textContent = hasEnd ? formatTimecode(settings.rangeEnd) : 'End of clip';
    el.rangeReset.hidden = settings.rangeStart === 0 && !hasEnd;
    el.rangeEndBtn.classList.toggle('is-invalid', !isRangeValid());
  }

  function currentPlan(): ReturnType<typeof buildPlan> {
    return buildPlan({
      mode: settings.mode,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      start: settings.rangeStart,
      end: settings.rangeEnd,
      intervalSeconds: settings.intervalSeconds,
      count: settings.frameCount,
      fps: settings.fps,
      maxFrames: Math.min(MAX_PLAN_FRAMES, Math.max(1, store.remainingCapacity)),
    });
  }

  function renderPlanSummary(): void {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      el.planSummary.textContent = 'Load a video first';
      el.autoBtn.disabled = true;
      return;
    }
    if (!isRangeValid()) {
      el.planSummary.textContent = 'Start must be before end';
      el.autoBtn.disabled = true;
      return;
    }
    const plan = currentPlan();
    if (plan.times.length === 0) {
      el.planSummary.textContent = 'Nothing to extract';
      el.autoBtn.disabled = true;
      return;
    }
    const size = fitToMaxEdge(
      { width: video.videoWidth, height: video.videoHeight },
      settings.maxEdge,
    );
    const dims = size.width > 0 ? ` · ${size.width}×${size.height}` : '';
    el.planSummary.textContent = `${describePlan(plan)}${dims}`;
    el.autoBtn.disabled = false;
  }

  /* ---------------------------------------------------------------- */
  /* Numeric steppers                                                  */
  /* ---------------------------------------------------------------- */

  function wireStepper(
    input: HTMLInputElement,
    minus: HTMLButtonElement,
    plus: HTMLButtonElement,
    read: () => number,
    write: (value: number) => void,
    step: (value: number, direction: number) => number,
  ): void {
    const commit = (value: number): void => {
      write(value);
      renderSettings();
    };
    on(minus, 'click', () => commit(step(read(), -1)));
    on(plus, 'click', () => commit(step(read(), 1)));
    on(input, 'change', () => commit(Number.parseFloat(input.value)));
    on(input, 'blur', () => renderSettings());
  }

  wireStepper(
    el.intervalInput,
    el.intervalMinus,
    el.intervalPlus,
    () => settings.intervalSeconds,
    (value) => {
      settings.intervalSeconds = Number.isFinite(value)
        ? clamp(value, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
        : settings.intervalSeconds;
    },
    (value, direction) => {
      // Sub-second intervals move in 0.1s; above that whole seconds.
      const delta = value < 1 || (direction < 0 && value <= 1) ? 0.1 : 1;
      return Math.round((value + delta * direction) * 100) / 100;
    },
  );

  wireStepper(
    el.countInput,
    el.countMinus,
    el.countPlus,
    () => settings.frameCount,
    (value) => {
      settings.frameCount = Number.isFinite(value)
        ? Math.round(clamp(value, MIN_FRAME_COUNT, MAX_FRAME_COUNT))
        : settings.frameCount;
    },
    (value, direction) => value + direction * (value >= 20 ? 10 : 1),
  );

  wireStepper(
    el.fpsInput,
    el.fpsMinus,
    el.fpsPlus,
    () => settings.fps,
    (value) => {
      settings.fps = normalizeFps(value, settings.fps);
    },
    (value, direction) => clamp(value + direction, MIN_FPS, MAX_FPS),
  );

  on(el.quality, 'input', () => {
    settings.quality = clamp(Number(el.quality.value) / 100, 0.3, 1);
    el.qualityValue.textContent = `${Math.round(settings.quality * 100)}%`;
  });

  on(el.modeInterval, 'click', () => {
    settings.mode = 'interval';
    renderSettings();
  });
  on(el.modeCount, 'click', () => {
    settings.mode = 'count';
    renderSettings();
  });

  /* ---------------------------------------------------------------- */
  /* Video loading                                                     */
  /* ---------------------------------------------------------------- */

  function releaseSource(): void {
    if (sourceUrl) {
      deps.revokeObjectURL(sourceUrl);
      sourceUrl = null;
    }
  }

  function loadFile(file: File): void {
    clearError();
    releaseSource();
    sourceUrl = deps.createObjectURL(file);
    baseName = sanitizeBaseName(file.name);
    // A trim range is a property of the clip it was set on, not a lasting
    // preference — carrying it into an unrelated video would silently clip
    // it in a way the user never asked for.
    settings.rangeStart = 0;
    settings.rangeEnd = 0;
    video.src = sourceUrl;
    try {
      video.load();
    } catch {
      // jsdom and some embedded webviews don't implement load(); setting src
      // is enough on every browser that can actually decode video.
    }
    el.emptyState.hidden = true;
    el.workspace.hidden = false;
  }

  on(el.pickBtn, 'click', () => {
    el.fileInput.click();
  });
  on(el.changeVideo, 'click', () => {
    el.fileInput.click();
  });

  on(el.fileInput, 'change', () => {
    const file = el.fileInput.files?.[0];
    if (file) loadFile(file);
  });

  on(video, 'loadedmetadata', () => {
    el.scrub.max = String(Math.max(0.001, video.duration || 0));
    el.timeTotal.textContent = formatShortDuration(video.duration || 0);
    el.videoMeta.textContent = `${video.videoWidth}×${video.videoHeight} · ${formatShortDuration(
      video.duration || 0,
    )}`;
    renderSettings();
  });

  on(video, 'error', () => {
    el.emptyState.hidden = false;
    el.workspace.hidden = true;
    showError("That file couldn't be decoded. Try a different video.");
  });

  on(video, 'timeupdate', () => {
    if (scrubbing) return;
    el.timeCurrent.textContent = formatTimecode(video.currentTime);
    el.scrub.value = String(video.currentTime);
  });

  on(video, 'play', () => {
    el.playIcon.textContent = '❚❚';
    el.playToggle.setAttribute('aria-label', 'Pause');
  });
  on(video, 'pause', () => {
    el.playIcon.textContent = '▶';
    el.playToggle.setAttribute('aria-label', 'Play');
  });

  /* ---------------------------------------------------------------- */
  /* Transport                                                         */
  /* ---------------------------------------------------------------- */

  function setTime(next: number): void {
    const max = Number.isFinite(video.duration) ? video.duration : 0;
    const value = clamp(next, 0, max);
    video.currentTime = value;
    el.timeCurrent.textContent = formatTimecode(value);
    el.scrub.value = String(value);
  }

  on(el.scrub, 'input', () => {
    scrubbing = true;
    setTime(Number(el.scrub.value));
  });
  on(el.scrub, 'change', () => {
    scrubbing = false;
    setTime(Number(el.scrub.value));
  });

  on(el.backSecond, 'click', () => setTime(video.currentTime - 1));
  on(el.fwdSecond, 'click', () => setTime(video.currentTime + 1));
  on(el.backFrame, 'click', () =>
    setTime(stepByFrames(video.currentTime, -1, settings.fps, video.duration)),
  );
  on(el.fwdFrame, 'click', () =>
    setTime(stepByFrames(video.currentTime, 1, settings.fps, video.duration)),
  );

  on(el.playToggle, 'click', () => {
    try {
      if (video.paused) {
        const result: unknown = video.play();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => toast('Playback blocked — scrub instead'));
        }
      } else {
        video.pause();
      }
    } catch {
      toast('Playback unavailable — use the scrubber');
    }
  });

  /* ---------------------------------------------------------------- */
  /* Progress overlay                                                  */
  /* ---------------------------------------------------------------- */

  function openOverlay(label: string): void {
    el.progressLabel.textContent = label;
    el.progressBar.style.width = '0%';
    el.progressDetail.textContent = '';
    el.overlay.hidden = false;
  }

  function setProgress(done: number, total: number, suffix = ''): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.progressBar.style.width = `${pct}%`;
    el.progressDetail.textContent = `${done} of ${total}${suffix}`;
  }

  function closeOverlay(): void {
    el.overlay.hidden = true;
  }

  on(el.cancelBtn, 'click', () => {
    abort?.abort();
    el.progressLabel.textContent = 'Stopping…';
  });

  /* ---------------------------------------------------------------- */
  /* Capture                                                           */
  /* ---------------------------------------------------------------- */

  function makeRenderer(maxEdge: number) {
    return createCanvasRenderer({
      format: formatById(settings.formatId),
      quality: settings.quality,
      maxEdge,
      ...(deps.createCanvas ? { createCanvas: deps.createCanvas } : {}),
    });
  }

  function toFrame(time: number, blob: Blob, width: number, height: number): Frame {
    return {
      id: store.nextId(),
      time,
      blob,
      url: deps.createObjectURL(blob),
      width,
      height,
      ext: formatById(settings.formatId).ext,
    };
  }

  /** Name a frame by its position in the set being exported. */
  function exportNameFor(frame: Frame, index: number, total: number): string {
    return frameFileName({
      base: baseName,
      index: index + 1,
      time: frame.time,
      ext: frame.ext,
      total,
    });
  }

  function track(work: () => Promise<void>): Promise<void> {
    busy = busy.then(work, work);
    return busy;
  }

  async function grabCurrentFrame(): Promise<void> {
    if (store.isFull) {
      toast(`Frame limit reached (${store.count}). Export or clear first.`);
      return;
    }
    el.grabBtn.disabled = true;
    try {
      const renderer = makeRenderer(settings.maxEdge);
      const { blob, size } = await renderer.render(video);
      const added = store.add(toFrame(video.currentTime, blob, size.width, size.height));
      toast(added ? `Grabbed ${formatTimecode(video.currentTime)}` : 'Frame limit reached');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not grab that frame');
    } finally {
      el.grabBtn.disabled = false;
    }
  }

  on(el.grabBtn, 'click', () => {
    void track(grabCurrentFrame);
  });

  on(el.rangeStartBtn, 'click', () => {
    settings.rangeStart = clamp(video.currentTime, 0, Number.isFinite(video.duration) ? video.duration : 0);
    renderSettings();
  });

  on(el.rangeEndBtn, 'click', () => {
    settings.rangeEnd = clamp(video.currentTime, 0, Number.isFinite(video.duration) ? video.duration : 0);
    renderSettings();
  });

  on(el.rangeReset, 'click', () => {
    settings.rangeStart = 0;
    settings.rangeEnd = 0;
    renderSettings();
  });

  async function runExtraction(): Promise<void> {
    const plan = currentPlan();
    if (plan.times.length === 0) {
      toast('Nothing to extract');
      return;
    }

    const resumeAt = video.currentTime;
    abort = new AbortController();
    openOverlay('Extracting frames…');
    setProgress(0, plan.times.length);
    el.autoBtn.disabled = true;

    try {
      const renderer = makeRenderer(settings.maxEdge);
      const pending: Frame[] = [];
      const result = await extractFrames({
        video,
        times: plan.times,
        renderer,
        signal: abort.signal,
        timers,
        ...(deps.yieldToUi ? { yieldToUi: deps.yieldToUi } : {}),
        onFrame: (captured) => {
          pending.push(
            toFrame(captured.time, captured.blob, captured.size.width, captured.size.height),
          );
        },
        onProgress: (progress) => {
          setProgress(
            progress.completed,
            progress.total,
            progress.failed > 0 ? ` · ${progress.failed} skipped` : '',
          );
        },
      });

      store.addMany(pending);

      if (result.cancelled) {
        toast(`Stopped — kept ${result.frames.length} frames`);
      } else if (result.failures.length > 0) {
        toast(`Got ${result.frames.length}, skipped ${result.failures.length}`);
      } else {
        toast(`Extracted ${result.frames.length} frames`);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Extraction failed');
    } finally {
      abort = null;
      closeOverlay();
      el.autoBtn.disabled = false;
      // Put the playhead back where the user left it.
      try {
        await seekTo(video, resumeAt, { timers, timeoutMs: 2000 });
      } catch {
        // Not worth surfacing — the frames are already captured.
      }
      renderSettings();
    }
  }

  on(el.autoBtn, 'click', () => {
    void track(runExtraction);
  });

  /* ---------------------------------------------------------------- */
  /* Gallery                                                           */
  /* ---------------------------------------------------------------- */

  function renderGallery(frames: readonly Frame[]): void {
    el.gallerySection.hidden = frames.length === 0;
    el.dock.hidden = frames.length === 0;
    el.galleryCount.textContent = String(frames.length);

    const selected = store.selectedCount;
    el.galleryHint.textContent =
      selected > 0
        ? `${selected} selected · ${formatBytes(store.totalBytes)} total`
        : `Tap a frame to select it · ${formatBytes(store.totalBytes)} total`;
    el.deleteSelected.disabled = selected === 0;
    el.downloadLabel.textContent =
      selected > 0
        ? `Download ${selected} selected`
        : `Download all ${frames.length}`;

    el.gallery.replaceChildren();
    for (const frame of frames) {
      const item = doc.createElement('li');
      const tile = doc.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.id = frame.id;
      const isSelected = store.isSelected(frame.id);
      tile.classList.toggle('is-selected', isSelected);
      tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      tile.setAttribute('aria-label', `Frame at ${formatTimecode(frame.time)}`);

      const img = doc.createElement('img');
      img.className = 'tile__img';
      img.src = frame.url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';

      const time = doc.createElement('span');
      time.className = 'tile__time';
      time.textContent = formatTimecode(frame.time);

      const check = doc.createElement('span');
      check.className = 'tile__check';
      check.textContent = isSelected ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');

      tile.append(img, time, check);
      item.appendChild(tile);
      el.gallery.appendChild(item);
    }
  }

  on(el.gallery, 'click', (event) => {
    const target = event.target as HTMLElement | null;
    const tile = target?.closest?.('.tile') as HTMLElement | null;
    const id = tile?.dataset?.id;
    if (id) store.toggleSelection(id);
  });

  on(el.selectAll, 'click', () => {
    if (store.selectedCount === store.count && store.count > 0) {
      store.clearSelection();
    } else {
      store.selectAll();
    }
  });

  on(el.deleteSelected, 'click', () => {
    const removed = store.removeSelected();
    if (removed > 0) toast(`Deleted ${removed}`);
  });

  on(el.clearAll, 'click', () => {
    store.clear();
    toast('Cleared');
  });

  cleanups.push(store.subscribe(renderGallery));

  /* ---------------------------------------------------------------- */
  /* Export                                                            */
  /* ---------------------------------------------------------------- */

  async function exportFrames(): Promise<void> {
    const frames = store.exportSet;
    if (frames.length === 0) {
      toast('No frames to download');
      return;
    }

    // Try the OS share sheet first — on iOS this is what puts a single image
    // one tap from Photos, and a whole batch behind "Save N Images" instead of
    // landing silently in Files. Zipping would only get in the way here: a
    // .zip isn't something iOS recognises as saveable to Photos.
    if (deps.shareFiles) {
      const outcome = await deps.shareFiles(
        frames.map((frame, index) => ({
          blob: frame.blob,
          filename: exportNameFor(frame, index, frames.length),
        })),
      );
      if (outcome === 'shared') {
        toast(frames.length === 1 ? 'Shared 1 frame' : `Shared ${frames.length} frames`);
        return;
      }
      if (outcome === 'cancelled') return;
      // 'unsupported' falls through to the download path below.
    }

    if (frames.length === 1) {
      const only = frames[0]!;
      deps.triggerDownload(only.blob, exportNameFor(only, 0, 1));
      toast('Saved 1 frame');
      return;
    }

    abort = new AbortController();
    openOverlay('Packaging…');
    setProgress(0, frames.length);
    el.downloadZip.disabled = true;

    try {
      const entries: ZipEntry[] = [];
      const taken = new Set<string>();
      const yieldToUi = deps.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

      for (let index = 0; index < frames.length; index += 1) {
        if (abort.signal.aborted) {
          toast('Download cancelled');
          return;
        }
        const frame = frames[index]!;
        const buffer = await frame.blob.arrayBuffer();
        const name = uniqueName(exportNameFor(frame, index, frames.length), taken);
        taken.add(name);
        entries.push({ name, data: new Uint8Array(buffer) });
        setProgress(index + 1, frames.length);
        // Reading a few hundred blobs back-to-back is what would otherwise
        // lock the screen; yielding keeps the cancel button alive.
        await yieldToUi();
      }

      const zip = buildZip(entries);
      const blob = new Blob([zip as unknown as BlobPart], { type: 'application/zip' });
      deps.triggerDownload(blob, zipFileName(baseName));
      toast(`Saved ${entries.length} frames · ${formatBytes(blob.size)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not build the download');
    } finally {
      abort = null;
      closeOverlay();
      el.downloadZip.disabled = false;
    }
  }

  on(el.downloadZip, 'click', () => {
    void track(exportFrames);
  });

  /* ---------------------------------------------------------------- */
  /* Init                                                              */
  /* ---------------------------------------------------------------- */

  renderSettings();
  renderGallery(store.all);

  return {
    store,
    settings,
    whenIdle: () => busy,
    destroy(): void {
      abort?.abort();
      releaseSource();
      store.clear();
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}
