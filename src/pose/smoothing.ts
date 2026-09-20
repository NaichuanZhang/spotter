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
 * Push one frame of angles. A nullable angle simply does not extend its window on a
 * frame where it was unmeasurable, so a briefly lost ear does not blank the neck
 * signal and a one-frame ankle dropout does not blank the body line.
 */
export function pushAngles(windows: AngleWindows, angles: PoseAngles): AngleWindows {
  return {
    elbow: pushSample(windows.elbow, angles.elbow),
    bodyLine: angles.bodyLine === null ? windows.bodyLine : pushSample(windows.bodyLine, angles.bodyLine),
    hipDeviation:
      angles.hipDeviation === null ? windows.hipDeviation : pushSample(windows.hipDeviation, angles.hipDeviation),
    neck: angles.neck === null ? windows.neck : pushSample(windows.neck, angles.neck),
    flare: angles.flare === null ? windows.flare : pushSample(windows.flare, angles.flare),
  }
}

/**
 * Median-filtered angles for the current window state. `side` is carried through
 * from the raw frame — it is a label, not a measurement, so it is not smoothed.
 *
 * Returns null only when the ELBOW has no samples, since that is the one angle without
 * which there is nothing to count.
 *
 * EVERY NULLABLE ANGLE IS GATED ON THE RAW FRAME, not on its window. A window that still
 * holds samples keeps returning a median forever, so reading the window alone would keep
 * publishing an angle for as long as the session lasts after the joint that produced it left
 * the shot — a stale number presented as a live measurement, which is the exact failure the
 * ankle-decoupling pass exists to remove. When the raw frame does not have the angle, neither
 * does the smoothed one.
 *
 * MEASURED, and the reason the gate is not body-line-specific: with this gate applied only to
 * `bodyLine`/`hipDeviation`, occluding the ear from frame 10 of a 70-frame sequence left
 * `smoothedAngles().neck` reporting 175.5 degrees on all 60 subsequent frames, and on a
 * craned-neck pose it produced a `craned_neck` candidate on 70 frames out of 70 AFTER the ear
 * was gone. The coach would have criticised a head position that was not on camera, for the
 * rest of the set, off one value measured seconds earlier. Same hazard as the fabricated hip
 * deviation, same answer: an honest null.
 *
 * The windows are NOT cleared. A flickering joint would then reset them every few frames and
 * the angle would arrive unfiltered; spanning a short gap with at most `windowSize - 1` older
 * real samples is the cheaper error, and three fresh samples are enough to put the median back
 * inside the fresh range (~66ms at 30fps).
 */
export function smoothedAngles(windows: AngleWindows, raw: PoseAngles): PoseAngles | null {
  const elbow = median(windows.elbow)
  if (elbow === null) return null

  return {
    side: raw.side,
    elbow,
    bodyLine: raw.bodyLine === null ? null : median(windows.bodyLine),
    hipDeviation: raw.hipDeviation === null ? null : median(windows.hipDeviation),
    neck: raw.neck === null ? null : median(windows.neck),
    flare: raw.flare === null ? null : median(windows.flare),
  }
}
