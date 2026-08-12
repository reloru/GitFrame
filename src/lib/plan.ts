/** Works out which timestamps a batch extraction should capture. */

import { clamp, frameDuration, isUsableTime, normalizeFps } from './time.js';

export type PlanMode = 'interval' | 'count' | 'every-frame';

/** Hard ceiling on a single run, so a long clip can't exhaust phone memory. */
export const MAX_PLAN_FRAMES = 300;

export interface PlanInput {
  readonly mode: PlanMode;
  readonly duration: number;
  /** Optional in/out points; defaults to the whole clip. */
  readonly start?: number;
  readonly end?: number;
  /** Seconds between captures, for `interval` mode. */
  readonly intervalSeconds?: number;
  /** Total captures spread evenly, for `count` mode. */
  readonly count?: number;
  readonly fps?: number;
  readonly maxFrames?: number;
}

export interface Plan {
  readonly times: readonly number[];
  /** True when the plan was cut short by `maxFrames`. */
  readonly truncated: boolean;
  /** How many captures the request would have produced uncapped. */
  readonly requested: number;
}

const EMPTY: Plan = { times: [], truncated: false, requested: 0 };

function resolveRange(input: PlanInput): { start: number; end: number } | null {
  if (!isUsableTime(input.duration) || input.duration <= 0) return null;
  const duration = input.duration;
  const start = clamp(isUsableTime(input.start) ? input.start : 0, 0, duration);
  const rawEnd = isUsableTime(input.end) && input.end > 0 ? input.end : duration;
  const end = clamp(rawEnd, 0, duration);
  if (end <= start) return null;
  return { start, end };
}

/**
 * Build the ordered list of capture timestamps.
 *
 * Every mode is capped at `maxFrames`; when the cap bites, the captures are
 * spread evenly across the whole range rather than stopping part-way through,
 * so the user still gets coverage of the entire clip.
 */
export function buildPlan(input: PlanInput): Plan {
  const range = resolveRange(input);
  if (!range) return EMPTY;

  const { start, end } = range;
  const span = end - start;
  const fps = normalizeFps(input.fps);
  const cap = Number.isFinite(input.maxFrames) && (input.maxFrames ?? 0) > 0
    ? Math.floor(input.maxFrames as number)
    : MAX_PLAN_FRAMES;

  let step: number;
  let requested: number;

  if (input.mode === 'count') {
    const count = Math.floor(input.count ?? 0);
    if (count <= 0) return EMPTY;
    requested = count;
    step = count === 1 ? span : span / count;
  } else if (input.mode === 'every-frame') {
    step = frameDuration(fps);
    requested = Math.max(1, Math.floor(span / step));
  } else {
    const interval = input.intervalSeconds ?? 0;
    if (!Number.isFinite(interval) || interval <= 0) return EMPTY;
    step = interval;
    requested = Math.max(1, Math.ceil(span / interval));
  }

  const total = Math.min(requested, cap);
  const effectiveStep = total < requested ? span / total : step;

  const times: number[] = [];
  for (let i = 0; i < total; i += 1) {
    // Offset by half a step so we land inside a frame rather than on the
    // boundary, where browsers disagree about which frame is current.
    const raw = start + i * effectiveStep + Math.min(effectiveStep, frameDuration(fps)) / 2;
    times.push(Number(clamp(raw, start, Math.max(start, end - 1e-4)).toFixed(4)));
  }

  return { times, truncated: total < requested, requested };
}

/** One-line summary of a plan for the confirmation sheet. */
export function describePlan(plan: Plan): string {
  if (plan.times.length === 0) return 'Nothing to extract';
  const noun = plan.times.length === 1 ? 'frame' : 'frames';
  if (plan.truncated) {
    return `${plan.times.length} ${noun} (capped from ${plan.requested}, spread evenly)`;
  }
  return `${plan.times.length} ${noun}`;
}
