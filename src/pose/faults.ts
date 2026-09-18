/**
 * Form-fault detection and THE GATE.
 *
 * Detection is the easy half. The gate is what makes the coach bearable: raw
 * per-frame evaluation finds a sagging hip 30 times a second, and a coach that
 * narrated all of them would be unusable and would also never stop talking long
 * enough to hear the user. Three independent brakes:
 *
 *   1. PERSISTENCE  — a fault must hold N of the last M frames. Kills single-frame
 *                     landmark glitches, which are the most common false positive.
 *   2. PER-TYPE COOLDOWN — the same fault cannot be mentioned again for ~4s. Stops
 *                     "your hips are sagging" on loop while the user fixes it.
 *   3. GLOBAL BUCKET — roughly one utterance per 3s across ALL faults, with strict
 *                     severity pre-emption: a severe fault may interrupt a routine
 *                     rep callout or a minor fault, never the reverse. Without the
 *                     pre-emption rule the bucket would let a trivial fault block
 *                     the one thing actually worth saying.
 *
 * Everything here is pure and time is always an argument. No Date.now().
 *
 * TUNABLES LIVE IN: `FAULT_THRESHOLDS` and `GATE_CONFIG` (this file).
 */

import type { CameraView, CoachEvent, FaultType, RepMetrics, RepPhase, Severity } from '../types/events'
import { FAULT_VIEW_RELIABILITY } from '../types/events'
import type { PoseAngles } from './angles'
import { REP_THRESHOLDS } from './repMachine'

export interface SeverityBands {
  /** Degrees past threshold at which `minor` becomes `major`. */
  majorAtDeg: number
  /** ...and `major` becomes `severe`. */
  severeAtDeg: number
}

export const FAULT_THRESHOLDS = {
  /** hipDeviationDeg at or above this (positive = below the line) is a sag. */
  sagDeg: 12,
  /** |hipDeviationDeg| at or above this, negative, is a pike. */
  pikeDeg: 12,
  /** Neck angle at or below this is craned. Lower is worse. */
  neckMinDeg: 150,
  /** Elbow abduction at or above this is flared. Front view only. */
  flareDeg: 65,
  /** At the top of a rep, an elbow at or below this is not locked out. */
  lockoutDeg: 150,
  /** Default bands, in degrees past the fault's own threshold. */
  severityBands: { majorAtDeg: 6, severeAtDeg: 14 } satisfies SeverityBands,
  /**
   * `partial_depth` is scored against how far short of FULL depth the rep stopped,
   * not against the partial flag's own threshold — the gap between
   * `partialAboveDeg` and `downEnterDeg` is only a few degrees wide, so measuring
   * excess from there would rate every partial rep identically.
   */
  partialDepth: {
    fullDepthDeg: REP_THRESHOLDS.depthFullDeg,
    bands: { majorAtDeg: 10, severeAtDeg: 22 } satisfies SeverityBands,
  },
} as const

/**
 * Faults evaluated once per frame, and therefore subject to persistence tracking.
 * `partial_depth` is per-rep, and `out_of_frame` has its own event kind and is owned
 * by the engine — neither belongs here.
 */
export const FRAME_FAULTS: readonly FaultType[] = [
  'sagging_hips',
  'piked_hips',
  'craned_neck',
  'flared_elbows',
  'no_lockout',
]

export interface Persistence {
  /** How many recent frames to remember. */
  window: number
  /** How many of them must show the fault before it counts. */
  required: number
}

/**
 * Severity ranks for the global bucket. Rep callouts are `routine` (0), so any real
 * fault outranks "nice rep" — which is the behaviour that makes the coach feel like
 * it is paying attention rather than reading a script.
 */
export const UTTERANCE_RANK = { routine: 0, minor: 1, major: 2, severe: 3 } as const

export const GATE_CONFIG = {
  persistence: {
    default: { window: 6, required: 4 } satisfies Persistence,
    /**
     * `no_lockout` needs a much longer hold. Its per-frame condition ("at the top
     * with a bent elbow") is also true for every descent, which passes through the
     * band in ~300ms. 18 of 24 frames is ~600ms at 30fps — longer than any descent,
     * short enough to catch a genuine failure to straighten up.
     */
    byFault: { no_lockout: { window: 24, required: 18 } } as Partial<Record<FaultType, Persistence>>,
  },
  /** Same fault cannot re-fire inside this window. */
  perFaultCooldownMs: 4000,
  /** Minimum spacing between utterances of equal or lower rank. */
  globalIntervalMs: 3000,
} as const

// ------------------------------------------------------------------- candidates

export interface FaultCandidate {
  fault: FaultType
  severity: Severity
  /** Goes into the event's `valueDeg`. Always a magnitude, never negative. */
  valueDeg?: number
  /** Set by per-rep evaluation, which has no frame run to report. */
  heldFrames?: number
}

export interface FaultContext {
  angles: PoseAngles
  phase: RepPhase
  view: CameraView
  inFrame: boolean
}

/** Severity from how far past its threshold a measurement sits, in degrees. */
export function severityFor(
  excessDeg: number,
  bands: SeverityBands = FAULT_THRESHOLDS.severityBands,
): Severity {
  if (excessDeg >= bands.severeAtDeg) return 'severe'
  if (excessDeg >= bands.majorAtDeg) return 'major'
  return 'minor'
}

/** Drop faults this camera angle cannot measure honestly. */
function reliableIn(view: CameraView): (c: FaultCandidate) => boolean {
  return (c) => FAULT_VIEW_RELIABILITY[c.fault].includes(view)
}

function hipCandidates(deviation: number): FaultCandidate[] {
  // Sign convention comes from angles.hipDeviation: positive = sag, negative = pike.
  if (deviation >= FAULT_THRESHOLDS.sagDeg) {
    const excess = deviation - FAULT_THRESHOLDS.sagDeg
    return [{ fault: 'sagging_hips', severity: severityFor(excess), valueDeg: deviation }]
  }
  if (-deviation >= FAULT_THRESHOLDS.pikeDeg) {
    const magnitude = -deviation
    const excess = magnitude - FAULT_THRESHOLDS.pikeDeg
    return [{ fault: 'piked_hips', severity: severityFor(excess), valueDeg: magnitude }]
  }
  return []
}

/**
 * Everything wrong with this single frame, before any gating. An unmeasurable or
 * out-of-frame body yields no candidates — silence beats a fault invented from
 * garbage geometry.
 */
export function evaluateFaults(ctx: FaultContext): FaultCandidate[] {
  if (!ctx.inFrame) return []
  const { angles, phase } = ctx
  const out: FaultCandidate[] = [...hipCandidates(angles.hipDeviation)]

  if (angles.neck !== null && angles.neck <= FAULT_THRESHOLDS.neckMinDeg) {
    const excess = FAULT_THRESHOLDS.neckMinDeg - angles.neck
    out.push({ fault: 'craned_neck', severity: severityFor(excess), valueDeg: angles.neck })
  }
  if (angles.flare !== null && angles.flare >= FAULT_THRESHOLDS.flareDeg) {
    const excess = angles.flare - FAULT_THRESHOLDS.flareDeg
    out.push({ fault: 'flared_elbows', severity: severityFor(excess), valueDeg: angles.flare })
  }
  if (phase === 'top' && angles.elbow <= FAULT_THRESHOLDS.lockoutDeg) {
    const excess = FAULT_THRESHOLDS.lockoutDeg - angles.elbow
    out.push({ fault: 'no_lockout', severity: severityFor(excess), valueDeg: angles.elbow })
  }
  return out.filter(reliableIn(ctx.view))
}

/**
 * Faults that are properties of a whole rep rather than a frame. These skip
 * persistence (the rep itself was the evidence) but still obey both cooldowns.
 */
export function evaluateRepFaults(rep: RepMetrics, view: CameraView): FaultCandidate[] {
  if (!rep.partial) return []
  const { fullDepthDeg, bands } = FAULT_THRESHOLDS.partialDepth
  const excess = rep.minElbowAngle - fullDepthDeg
  const candidates: FaultCandidate[] = [
    {
      fault: 'partial_depth',
      severity: severityFor(excess, bands),
      valueDeg: rep.minElbowAngle,
      // A per-rep fault has no frame run to report; the rep itself is the evidence.
      heldFrames: 1,
    },
  ]
  return candidates.filter(reliableIn(view))
}

// -------------------------------------------------------------------- the gate

export type GateMode = 'frame' | 'immediate'

export interface GateState {
  /** Per-fault presence history, newest last. Only `FRAME_FAULTS` appear. */
  readonly history: Readonly<Partial<Record<FaultType, readonly boolean[]>>>
  readonly lastFiredAt: Readonly<Partial<Record<FaultType, number>>>
  readonly lastUtteranceAt: number | null
  readonly lastUtteranceRank: number
}

export interface GateInput {
  candidates: readonly FaultCandidate[]
  t: number
  /** 'frame' tracks persistence; 'immediate' is for already-proven per-rep faults. */
  mode?: GateMode
}

export interface GateResult {
  state: GateState
  /** At most one `form_fault` per call — the gate never says two things at once. */
  events: CoachEvent[]
  /**
   * Faults currently considered real (persistent), regardless of whether the coach
   * was allowed to mention them. This is what `WorkoutState.activeFaults` shows, so
   * the on-screen badge stays lit while a cooldown keeps the coach quiet.
   */
  active: FaultType[]
}

export function createGateState(): GateState {
  return { history: {}, lastFiredAt: {}, lastUtteranceAt: null, lastUtteranceRank: 0 }
}

export function persistenceFor(fault: FaultType): Persistence {
  return GATE_CONFIG.persistence.byFault[fault] ?? GATE_CONFIG.persistence.default
}

function trackHistory(
  history: GateState['history'],
  candidates: readonly FaultCandidate[],
): GateState['history'] {
  const next: Partial<Record<FaultType, readonly boolean[]>> = { ...history }
  for (const fault of FRAME_FAULTS) {
    const present = candidates.some((c) => c.fault === fault)
    const appended = [...(history[fault] ?? []), present]
    const { window } = persistenceFor(fault)
    next[fault] = appended.length > window ? appended.slice(appended.length - window) : appended
  }
  return next
}

function heldFrames(history: GateState['history'], fault: FaultType): number {
  return (history[fault] ?? []).filter(Boolean).length
}

/** Highest severity wins; ties keep evaluation order, which is deterministic. */
function mostSevere(candidates: readonly FaultCandidate[]): FaultCandidate | null {
  return candidates.reduce<FaultCandidate | null>((best, c) => {
    if (!best) return c
    return UTTERANCE_RANK[c.severity] > UTTERANCE_RANK[best.severity] ? c : best
  }, null)
}

/**
 * Whether an utterance of the given rank may be spoken now. Exported so the coach
 * layer can throttle its own non-fault chatter through the same bucket rather than
 * inventing a second, conflicting one.
 */
export function canSpeak(state: GateState, t: number, rank: number): boolean {
  if (state.lastUtteranceAt === null) return true
  if (t - state.lastUtteranceAt >= GATE_CONFIG.globalIntervalMs) return true
  return rank > state.lastUtteranceRank
}

/** Record that something was said, so faults and rep callouts share one bucket. */
export function noteUtterance(
  state: GateState,
  t: number,
  rank: number = UTTERANCE_RANK.routine,
): GateState {
  return { ...state, lastUtteranceAt: t, lastUtteranceRank: rank }
}

function offCooldown(state: GateState, t: number): (c: FaultCandidate) => boolean {
  return (c) => {
    const last = state.lastFiredAt[c.fault]
    return last === undefined || t - last >= GATE_CONFIG.perFaultCooldownMs
  }
}

/**
 * Run candidates through all three brakes. Returns a new state — the caller must
 * thread it forward, or every frame re-fires from a blank slate.
 */
export function gate(state: GateState, input: GateInput): GateResult {
  const mode: GateMode = input.mode ?? 'frame'
  const history = mode === 'frame' ? trackHistory(state.history, input.candidates) : state.history

  const persistent =
    mode === 'frame'
      ? input.candidates.filter((c) => heldFrames(history, c.fault) >= persistenceFor(c.fault).required)
      : [...input.candidates]

  const active = persistent.map((c) => c.fault)
  const chosen = mostSevere(persistent.filter(offCooldown(state, input.t)))

  if (!chosen || !canSpeak(state, input.t, UTTERANCE_RANK[chosen.severity])) {
    return { state: { ...state, history }, events: [], active }
  }

  const held = chosen.heldFrames ?? heldFrames(history, chosen.fault)
  const event: CoachEvent = {
    kind: 'form_fault',
    at: input.t,
    fault: chosen.fault,
    severity: chosen.severity,
    ...(chosen.valueDeg === undefined ? {} : { valueDeg: chosen.valueDeg }),
    heldFrames: held,
  }
  return {
    state: {
      history,
      lastFiredAt: { ...state.lastFiredAt, [chosen.fault]: input.t },
      lastUtteranceAt: input.t,
      lastUtteranceRank: UTTERANCE_RANK[chosen.severity],
    },
    events: [event],
    active,
  }
}
