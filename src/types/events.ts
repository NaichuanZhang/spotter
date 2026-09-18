/**
 * THE CONTRACT between the pose engine and the coach.
 *
 * The pose engine is the initiator: it measures, decides what is wrong, and emits
 * CoachEvents. The model never sees pixels or landmarks — it receives one line of
 * text derived from these events (see toEventLine) and supplies the character.
 *
 * Everything in this file must stay dependency-free so both the browser and the
 * test/replay harness can import it.
 */

export type FaultType =
  | 'sagging_hips'
  | 'piked_hips'
  | 'partial_depth'
  | 'no_lockout'
  | 'craned_neck'
  | 'flared_elbows'
  | 'out_of_frame'

export type Severity = 'minor' | 'major' | 'severe'

/** Which way the user is facing the camera. Affects which faults are trustworthy. */
export type CameraView = 'side' | 'front'

export type RepPhase = 'top' | 'bottom'

/** Per-rep measurements captured during the bottom phase of the state machine. */
export interface RepMetrics {
  index: number
  /** Smallest elbow angle reached, degrees. Lower = deeper. */
  minElbowAngle: number
  /** Largest elbow angle at the top, degrees. Used for lockout. */
  maxElbowAngle: number
  /** 0..100, mapped from minElbowAngle. */
  depthPct: number
  /** Worst body-line deviation from straight during this rep, degrees. Signed:
   *  positive = hips sagging below the line, negative = piking above it. */
  hipDeviationDeg: number
  descentMs: number
  ascentMs: number
  /** True when the rep never reached the depth threshold. Still counted. */
  partial: boolean
  /** True when the rep had no disqualifying fault. */
  clean: boolean
}

export type CoachEvent =
  | { kind: 'set_started'; at: number; target: number }
  | { kind: 'rep_completed'; at: number; rep: RepMetrics; totalReps: number; cleanReps: number }
  | { kind: 'form_fault'; at: number; fault: FaultType; severity: Severity; valueDeg?: number; heldFrames: number }
  | { kind: 'out_of_frame'; at: number; missing: string[] }
  | { kind: 'back_in_frame'; at: number }
  | { kind: 'idle'; at: number; sinceMs: number }
  | { kind: 'set_ended'; at: number; totalReps: number; cleanReps: number; faults: FaultType[] }

export interface WorkoutState {
  target: number
  totalReps: number
  cleanReps: number
  phase: RepPhase
  lastRep?: RepMetrics
  activeFaults: FaultType[]
  setStartedAt?: number
  setElapsedSec: number
  inFrame: boolean
}

export const FAULT_LABEL: Record<FaultType, string> = {
  sagging_hips: 'HIPS SAGGING',
  piked_hips: 'HIPS TOO HIGH',
  partial_depth: 'GO DEEPER',
  no_lockout: 'LOCK IT OUT',
  craned_neck: 'NECK CRANED',
  flared_elbows: 'ELBOWS FLARED',
  out_of_frame: 'OUT OF FRAME',
}

/** Faults that are only trustworthy from a given view. */
export const FAULT_VIEW_RELIABILITY: Record<FaultType, CameraView[]> = {
  sagging_hips: ['side'],
  piked_hips: ['side'],
  partial_depth: ['side'],
  no_lockout: ['side'],
  craned_neck: ['side'],
  flared_elbows: ['front'],
  out_of_frame: ['side', 'front'],
}

/**
 * The entire vision -> AI interface. Renders a CoachEvent as the single text line
 * pushed to the model as a synthetic user turn.
 *
 * Deliberately compact and consistently shaped: the model quotes these numbers
 * back, so the format needs to read unambiguously. The [EVENT] prefix stops the
 * model mistaking telemetry for something the user said out loud.
 */
export function toEventLine(e: CoachEvent): string {
  switch (e.kind) {
    case 'set_started':
      return `[EVENT] set started | target ${e.target} reps`

    case 'rep_completed': {
      const r = e.rep
      const bits = [
        `rep ${e.totalReps} completed`,
        `depth ${Math.round(r.depthPct)}%`,
        `tempo ${(r.descentMs / 1000).toFixed(1)}s down / ${(r.ascentMs / 1000).toFixed(1)}s up`,
      ]
      if (r.partial) bits.push('PARTIAL — did not reach depth')
      if (!r.partial && Math.abs(r.hipDeviationDeg) >= 10) {
        bits.push(`${r.hipDeviationDeg > 0 ? 'hip_sag' : 'hip_pike'} ${Math.round(Math.abs(r.hipDeviationDeg))}deg`)
      }
      bits.push(`${e.cleanReps} of ${e.totalReps} clean`)
      return `[EVENT] ${bits.join(' | ')}`
    }

    case 'form_fault': {
      const v = e.valueDeg !== undefined ? ` ${Math.round(e.valueDeg)}deg` : ''
      return `[EVENT] form fault: ${e.fault}${v} ${e.severity.toUpperCase()}`
    }

    case 'out_of_frame':
      return `[EVENT] user out of frame — cannot see ${e.missing.join(', ')}`

    case 'back_in_frame':
      return `[EVENT] user back in frame`

    case 'idle':
      return `[EVENT] no movement for ${Math.round(e.sinceMs / 1000)}s`

    case 'set_ended': {
      const f = e.faults.length ? ` | faults seen: ${e.faults.join(', ')}` : ' | no faults'
      return `[EVENT] set ended | ${e.totalReps} reps | ${e.cleanReps} clean${f}`
    }
  }
}
