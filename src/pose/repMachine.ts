/**
 * Two-state hysteresis rep counter. A pure reducer: no timers, no DOM, no Date.now.
 * Time arrives as `t` on each frame so the whole thing replays deterministically.
 *
 * WHY HYSTERESIS. A single threshold ("elbow below 120 = a rep") plus ordinary
 * landmark noise produces phantom reps: the signal dithers across the line and each
 * crossing counts. Two thresholds with a wide gap fix it — you must get all the way
 * down past DOWN_ENTER and all the way back up past UP_ENTER to score. The 55-degree
 * gap between 100 and 155 is larger than any noise the median filter lets through,
 * so the machine cannot oscillate. The gap IS the algorithm.
 *
 * TUNABLES LIVE IN: `REP_THRESHOLDS` (this file).
 */

import type { CoachEvent, RepMetrics, RepPhase } from '../types/events'
import type { PoseAngles } from './angles'

export const REP_THRESHOLDS = {
  /** TOP -> BOTTOM when the smoothed elbow angle falls below this. */
  downEnterDeg: 100,
  /** BOTTOM -> TOP (and rep scored) when it rises above this. */
  upEnterDeg: 155,
  /**
   * While at the top, the elbow must be under this AND falling for the descent clock
   * to start. Used only for tempo reporting, never for counting.
   */
  descentStartDeg: 165,
  /** Frame-to-frame drop that counts as "actually descending" rather than jitter. */
  descentNoiseDeg: 1,
  /**
   * A rep whose deepest smoothed elbow angle stayed ABOVE this is reported
   * `partial: true` — counted, but flagged as short.
   *
   * MUST be below `downEnterDeg`, or `partial` is unreachable: the machine only ever
   * enters BOTTOM after crossing `downEnterDeg`, so the deepest angle of any scored
   * rep is already below it. (The brief spec said 110 here, which is above
   * downEnterDeg=100 and therefore dead code; `validateRepThresholds` enforces the
   * relationship so a future recalibration cannot silently kill the flag.)
   */
  partialAboveDeg: 95,
  /** depthPct anchors: this angle maps to 0%. */
  depthZeroDeg: 160,
  /** ...and this one to 100%. */
  depthFullDeg: 80,
  /** |hipDeviationDeg| at or above this disqualifies a rep from `clean`. */
  cleanHipDeviationDeg: 10,
} as const

/** Same shape as `REP_THRESHOLDS` but widened to `number`, so candidates can be checked. */
export type RepThresholds = { readonly [K in keyof typeof REP_THRESHOLDS]: number }

/**
 * Fails fast on a mis-tuned threshold set. Called at module load: these are frozen
 * constants, so it can only fire after someone recalibrates, which is exactly when
 * a loud failure beats a counter that quietly stops flagging partial reps.
 */
export function validateRepThresholds(t: RepThresholds = REP_THRESHOLDS): void {
  const problems: string[] = []
  if (t.downEnterDeg >= t.upEnterDeg) {
    problems.push(`downEnterDeg (${t.downEnterDeg}) must be below upEnterDeg (${t.upEnterDeg})`)
  }
  if (t.partialAboveDeg >= t.downEnterDeg) {
    problems.push(
      `partialAboveDeg (${t.partialAboveDeg}) must be below downEnterDeg (${t.downEnterDeg}), ` +
        'otherwise no scored rep can ever be marked partial',
    )
  }
  if (t.depthFullDeg >= t.depthZeroDeg) {
    problems.push(`depthFullDeg (${t.depthFullDeg}) must be below depthZeroDeg (${t.depthZeroDeg})`)
  }
  if (t.descentStartDeg <= t.upEnterDeg) {
    problems.push(`descentStartDeg (${t.descentStartDeg}) must be above upEnterDeg (${t.upEnterDeg})`)
  }
  if (problems.length > 0) {
    throw new Error(`REP_THRESHOLDS is inconsistent:\n - ${problems.join('\n - ')}`)
  }
}

validateRepThresholds()

// --------------------------------------------------------------------- state type

/** Measurements gathered across one in-progress rep. Replaced, never mutated. */
export interface RepAccumulator {
  /** Start of the descent if we saw it, else the TOP->BOTTOM transition time. */
  readonly startedAt: number
  readonly minElbow: number
  readonly minElbowAt: number
  readonly maxElbow: number
  /** Largest positive (sagging) deviation seen. >= 0. */
  readonly worstSag: number
  /** Largest negative (piking) deviation seen. <= 0. */
  readonly worstPike: number
  readonly frames: number
}

export interface RepMachineState {
  readonly phase: RepPhase
  readonly totalReps: number
  readonly cleanReps: number
  readonly lastRep?: RepMetrics
  /** In-progress rep, or null while at the top. */
  readonly current: RepAccumulator | null
  /**
   * False until one frame has been seen at full lockout. Stops a freebie rep when
   * the engine starts up with the user already in the bottom position.
   */
  readonly armed: boolean
  /** Timestamp the descent was first detected, or null while holding at the top. */
  readonly descentStartedAt: number | null
  /** Best lockout angle seen during the current top phase. Becomes maxElbowAngle. */
  readonly topMaxElbow: number | null
  readonly lastElbow: number | null
  readonly lastFrameAt: number | null
}

export interface RepFrame {
  angles: PoseAngles
  /** Milliseconds, monotonic. Same clock for every frame in a session. */
  t: number
}

export interface RepStepResult {
  state: RepMachineState
  /** `rep_completed` only. Set lifecycle events belong to the engine. */
  events: CoachEvent[]
}

export function createRepMachineState(): RepMachineState {
  return {
    phase: 'top',
    totalReps: 0,
    cleanReps: 0,
    current: null,
    armed: false,
    descentStartedAt: null,
    topMaxElbow: null,
    lastElbow: null,
    lastFrameAt: null,
  }
}

/** Fresh counters for a new set. Alias kept explicit so call sites read clearly. */
export function resetRepMachine(): RepMachineState {
  return createRepMachineState()
}

// ------------------------------------------------------------------- pure helpers

/** 0..100 from the deepest elbow angle, clamped at both ends. */
export function depthPct(minElbowAngle: number): number {
  const { depthZeroDeg, depthFullDeg } = REP_THRESHOLDS
  const pct = ((depthZeroDeg - minElbowAngle) / (depthZeroDeg - depthFullDeg)) * 100
  return pct < 0 ? 0 : pct > 100 ? 100 : pct
}

/** Worst deviation keeping its sign: whichever of sag/pike had the larger magnitude. */
export function worstDeviation(worstSag: number, worstPike: number): number {
  return Math.abs(worstSag) >= Math.abs(worstPike) ? worstSag : worstPike
}

function accumulate(acc: RepAccumulator, angles: PoseAngles, t: number): RepAccumulator {
  const deeper = angles.elbow < acc.minElbow
  return {
    ...acc,
    minElbow: deeper ? angles.elbow : acc.minElbow,
    minElbowAt: deeper ? t : acc.minElbowAt,
    maxElbow: Math.max(acc.maxElbow, angles.elbow),
    worstSag: Math.max(acc.worstSag, angles.hipDeviation),
    worstPike: Math.min(acc.worstPike, angles.hipDeviation),
    frames: acc.frames + 1,
  }
}

function openAccumulator(state: RepMachineState, angles: PoseAngles, t: number): RepAccumulator {
  return {
    startedAt: state.descentStartedAt ?? state.lastFrameAt ?? t,
    minElbow: angles.elbow,
    minElbowAt: t,
    maxElbow: Math.max(state.topMaxElbow ?? angles.elbow, angles.elbow),
    worstSag: Math.max(0, angles.hipDeviation),
    worstPike: Math.min(0, angles.hipDeviation),
    frames: 1,
  }
}

function toMetrics(acc: RepAccumulator, index: number, endedAt: number): RepMetrics {
  const deviation = worstDeviation(acc.worstSag, acc.worstPike)
  const partial = acc.minElbow > REP_THRESHOLDS.partialAboveDeg
  return {
    index,
    minElbowAngle: acc.minElbow,
    maxElbowAngle: acc.maxElbow,
    depthPct: depthPct(acc.minElbow),
    hipDeviationDeg: deviation,
    descentMs: Math.max(0, acc.minElbowAt - acc.startedAt),
    ascentMs: Math.max(0, endedAt - acc.minElbowAt),
    partial,
    // Neck and flare are coached but not disqualifying: they do not change whether
    // the movement was a pushup. Depth and a straight body line do.
    clean: !partial && Math.abs(deviation) < REP_THRESHOLDS.cleanHipDeviationDeg,
  }
}

/**
 * Descent-clock tracking for the top phase. Threshold alone is not enough — a user
 * holding a plank at 160 degrees sits below `descentStartDeg` indefinitely, and the
 * clock would start minutes before the rep. So the elbow must be below the threshold
 * AND measurably falling, and any non-falling frame clears it again.
 */
function trackDescent(state: RepMachineState, elbow: number, t: number): number | null {
  const prev = state.lastElbow
  if (prev === null) return null
  const falling = elbow < prev - REP_THRESHOLDS.descentNoiseDeg
  if (falling && elbow < REP_THRESHOLDS.descentStartDeg) {
    return state.descentStartedAt ?? state.lastFrameAt ?? t
  }
  return falling ? state.descentStartedAt : null
}

// ------------------------------------------------------------------ the transition

function stepTop(state: RepMachineState, frame: RepFrame): RepStepResult {
  const { angles, t } = frame
  const armed = state.armed || angles.elbow >= REP_THRESHOLDS.upEnterDeg
  const topMaxElbow = Math.max(state.topMaxElbow ?? angles.elbow, angles.elbow)
  const descentStartedAt = trackDescent(state, angles.elbow, t)
  const tracked: RepMachineState = { ...state, armed, topMaxElbow, descentStartedAt }

  if (armed && angles.elbow < REP_THRESHOLDS.downEnterDeg) {
    return {
      state: {
        ...tracked,
        phase: 'bottom',
        current: openAccumulator(tracked, angles, t),
        descentStartedAt: null,
        lastElbow: angles.elbow,
        lastFrameAt: t,
      },
      events: [],
    }
  }
  return { state: { ...tracked, lastElbow: angles.elbow, lastFrameAt: t }, events: [] }
}

function stepBottom(state: RepMachineState, frame: RepFrame): RepStepResult {
  const { angles, t } = frame
  const acc = accumulate(state.current ?? openAccumulator(state, angles, t), angles, t)

  if (angles.elbow <= REP_THRESHOLDS.upEnterDeg) {
    return {
      state: { ...state, current: acc, lastElbow: angles.elbow, lastFrameAt: t },
      events: [],
    }
  }

  const totalReps = state.totalReps + 1
  const rep = toMetrics(acc, totalReps, t)
  const cleanReps = state.cleanReps + (rep.clean ? 1 : 0)
  return {
    state: {
      ...state,
      phase: 'top',
      totalReps,
      cleanReps,
      lastRep: rep,
      current: null,
      topMaxElbow: angles.elbow,
      descentStartedAt: null,
      lastElbow: angles.elbow,
      lastFrameAt: t,
    },
    events: [{ kind: 'rep_completed', at: t, rep, totalReps, cleanReps }],
  }
}

/**
 * Advance the machine by one measurable frame. Callers must skip frames where
 * `measureAngles` returned null — feeding a fabricated zero angle here would read as
 * a maximally deep rep.
 */
export function step(state: RepMachineState, frame: RepFrame): RepStepResult {
  if (!Number.isFinite(frame.angles.elbow) || !Number.isFinite(frame.t)) {
    return { state, events: [] }
  }
  return state.phase === 'top' ? stepTop(state, frame) : stepBottom(state, frame)
}

// ------------------------------------------------------------------- demo-day hook

/** A believable clean rep, for the demo hotkey. Tunable in one place like everything else. */
export const SYNTHETIC_REP = {
  minElbowAngle: 84,
  maxElbowAngle: 176,
  hipDeviationDeg: 3,
  descentMs: 780,
  ascentMs: 640,
} as const

/**
 * Score a rep that the camera did not see, for demo-day hotkeys. Routed through the
 * same counters and the same `rep_completed` shape as a real rep so nothing
 * downstream can tell the difference — and so the counts stay consistent.
 *
 * Does not touch `phase`: the user may be mid-rep when the key is pressed.
 */
export function syntheticRep(
  state: RepMachineState,
  t: number,
  overrides: Partial<RepMetrics> = {},
): RepStepResult {
  const totalReps = state.totalReps + 1
  const base: RepMetrics = {
    index: totalReps,
    minElbowAngle: SYNTHETIC_REP.minElbowAngle,
    maxElbowAngle: SYNTHETIC_REP.maxElbowAngle,
    depthPct: depthPct(SYNTHETIC_REP.minElbowAngle),
    hipDeviationDeg: SYNTHETIC_REP.hipDeviationDeg,
    descentMs: SYNTHETIC_REP.descentMs,
    ascentMs: SYNTHETIC_REP.ascentMs,
    partial: false,
    clean: true,
  }
  const rep: RepMetrics = { ...base, ...overrides, index: totalReps }
  const cleanReps = state.cleanReps + (rep.clean ? 1 : 0)
  return {
    state: { ...state, totalReps, cleanReps, lastRep: rep },
    events: [{ kind: 'rep_completed', at: t, rep, totalReps, cleanReps }],
  }
}
