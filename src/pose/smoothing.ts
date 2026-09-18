/**
 * Rolling MEDIAN filter over landmark-derived angles. Immutable: every push returns
 * a new window, nothing is written in place.
 *
 * Median, not mean, and this is load-bearing. MediaPipe occasionally emits one
 * badly wrong frame — a wrist snapped to the far arm, an elbow flipped through the
 * torso — producing an angle 60 degrees off. A mean over 5 frames moves 12 degrees
 * on that single sample, which is enough to cross a rep threshold and invent a rep.
 * A median over 5 ignores it entirely as long as it is a minority. The cost is a
 * ~2-frame lag (~66ms at 30fps), which is invisible next to a 600ms voice round trip.
 *
 * TUNABLES LIVE IN: `SMOOTHING` (this file).
 */

import type { PoseAngles } from './angles'

export const SMOOTHING = {
  /**
   * Frames per window. MUST stay ODD — an even window has no single middle sample,
   * and see `median` for why that is worse than it sounds. 5 at 30fps = 166ms.
   */
  windowSize: 5,
} as const

export interface MedianWindow {
  /** Newest last. Never mutated. */
  readonly values: readonly number[]
  readonly size: number
}

export function createWindow(size: number = SMOOTHING.windowSize): MedianWindow {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`smoothing: window size must be a positive integer, got ${size}`)
  }
  return { values: [], size }
}

/**
 * Append a sample, dropping the oldest once full. Returns a NEW window.
 *
 * Non-finite samples are rejected rather than stored — a NaN inside the window would
 * corrupt the sort order and therefore every future median, not just this frame.
 */
export function pushSample(window: MedianWindow, value: number): MedianWindow {
  if (!Number.isFinite(value)) return window
  const next = [...window.values, value]
  return {
    ...window,
    values: next.length > window.size ? next.slice(next.length - window.size) : next,
  }
}

/**
 * Middle sample of the window, or null when empty. Callers must handle null; there
 * is no safe numeric stand-in for "no data".
 *
 * For an even count this returns the LOWER middle rather than averaging the two
 * middles. Averaging would invent a value that was never observed and would behave
 * like a 2-sample mean during warmup — exactly the outlier sensitivity this filter
 * exists to avoid. With an odd `windowSize` this only ever applies mid-warmup.
 */
export function median(window: MedianWindow): number | null {
  const n = window.values.length
  if (n === 0) return null
  const sorted = [...window.values].sort((a, b) => a - b)
  return sorted[n % 2 === 1 ? (n - 1) / 2 : n / 2 - 1] ?? null
}

/** True once the window holds a full set of samples, so the median is fully robust. */
export function isWarm(window: MedianWindow): boolean {
  return window.values.length >= window.size
}

export function clearWindow(window: MedianWindow): MedianWindow {
  return { ...window, values: [] }
}

// ----------------------------------------------------- PoseAngles convenience set

/**
 * One median window per measured angle. Kept here rather than in the engine so the
 * whole smoothing stage stays pure and testable.
 */
export interface AngleWindows {
  readonly elbow: MedianWindow
  readonly bodyLine: MedianWindow
  readonly hipDeviation: MedianWindow
  readonly neck: MedianWindow
  readonly flare: MedianWindow
}

export function createAngleWindows(size: number = SMOOTHING.windowSize): AngleWindows {
  return {
    elbow: createWindow(size),
    bodyLine: createWindow(size),
    hipDeviation: createWindow(size),
    neck: createWindow(size),
    flare: createWindow(size),
  }
}

/**
 * Push one frame of angles. Nullable angles (`neck`, `flare`) simply do not extend
 * their window on frames where they were unmeasurable, so a briefly lost ear does
 * not blank the neck signal.
 */
export function pushAngles(windows: AngleWindows, angles: PoseAngles): AngleWindows {
  return {
    elbow: pushSample(windows.elbow, angles.elbow),
    bodyLine: pushSample(windows.bodyLine, angles.bodyLine),
    hipDeviation: pushSample(windows.hipDeviation, angles.hipDeviation),
    neck: angles.neck === null ? windows.neck : pushSample(windows.neck, angles.neck),
    flare: angles.flare === null ? windows.flare : pushSample(windows.flare, angles.flare),
  }
}

/**
 * Median-filtered angles for the current window state. `side` is carried through
 * from the raw frame — it is a label, not a measurement, so it is not smoothed.
 *
 * Returns null when the essential angles have no samples at all.
 */
export function smoothedAngles(windows: AngleWindows, raw: PoseAngles): PoseAngles | null {
  const elbow = median(windows.elbow)
  const bodyLine = median(windows.bodyLine)
  const hipDeviation = median(windows.hipDeviation)
  if (elbow === null || bodyLine === null || hipDeviation === null) return null

  return {
    side: raw.side,
    elbow,
    bodyLine,
    hipDeviation,
    neck: median(windows.neck),
    flare: median(windows.flare),
  }
}
