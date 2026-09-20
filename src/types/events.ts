/**
 * THE CONTRACT between the pose engine and the coach.
 *
 * The pose engine is the initiator: it measures, decides what is wrong, and emits
 * CoachEvents. The model never sees pixels or landmarks — it receives one line of
 * text derived from these events (see toEventLine) and supplies the character.
 *
 * Everything in this file must stay dependency-free so both the browser and the
 * test/replay harness can import it.
 *
 * ── CONTRACT AMENDMENT LOG ──────────────────────────────────────────────────
 * This file is frozen: it was written before the implementation so four parallel
 * agents could not drift apart. It changes by deliberate amendment, recorded here.
 *
 * 1. `RepMetrics.hipDeviationDeg` became NULLABLE, and `RepMetrics.clean` was given a
 *    precise meaning (ankle-decoupling pass).
 *
 *    WHY. Judging the body line needs the hip AND the ankle; counting a rep needs only
 *    shoulder, elbow and wrist. A phone on the floor or a laptop close to the user crops
 *    the feet, and on the one piece of real footage in this repo
 *    (`public/clips/landmarks.json`, 578 frames, six real pushups) the ankle cleared the
 *    visibility gate on 45 frames out of 578 — median visibility 0.14, x reaching 1.27,
 *    i.e. placed outside the frame — while every joint needed to COUNT was visible
 *    throughout. Reps are now counted on that footage, so the contract has to be able to
 *    say "six reps, and I could not see your back", which it previously could not.
 *
 *    `hipDeviationDeg: number` left only 0 to stand for "not measured", and 0 already
 *    means something: a perfectly straight plank. Every rep of that footage would have
 *    been reported with flawless form. So null it is, and null means UNKNOWN.
 *
 *    `clean` STAYS A BOOLEAN and now means exactly "NO FAULT WAS DETECTED". It is not a
 *    certificate that the body line was straight — it cannot be, because the body line may
 *    never have been on camera. The pair to read is `clean` plus
 *    `hipDeviationDeg === null`, and `toEventLine` renders the second half in words so the
 *    coach cannot praise a back it never saw. The alternative (clean = false when
 *    unobservable) was rejected: it would report "0 of 6 clean" for a good set filmed with
 *    the feet out of shot, which is a different lie.
 *
 * 2. `form_unobservable` / `form_observable` ADDED to `CoachEvent` (same pass).
 *    `out_of_frame` could not carry this: it means "the user is gone, nothing is being
 *    measured", it sets `WorkoutState.inFrame` false and it suppresses fault evaluation.
 *    The new state is the opposite — reps ARE counting, only the body line is missing —
 *    and it is ACTIONABLE in a way nothing else here is, because backing up or tilting the
 *    phone fixes it. Debounced and rate-limited by the engine; see `OBSERVABILITY`.
 *
 *    No new `FaultType` was added, deliberately. `FaultType` is a closed set that
 *    `REFERENCE_CLIPS` in src/coach must cover exhaustively, and "I cannot see your hips"
 *    is a camera problem with no form-reference clip to show for it.
 *
 * 3. `EVENT_LINE.minReportedSec` ADDED (end-to-end verification pass). `form_unobservable` is
 *    debounced by FRAME COUNT, so its first mention always carried a sub-second `sinceMs` and
 *    the line rendered "cannot see ankle for 0s" — a self-contradicting sentence handed to a
 *    model that quotes these lines back. No event shape changed; only the rendering.
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
   *  positive = hips sagging below the line, negative = piking above it.
   *
   *  NULL when the body line was never measurable during the rep — the hip or the ankle
   *  was not on camera. Distinct from 0, which is a measurement meaning "straight".
   *  Never substitute one for the other: see the amendment log. */
  hipDeviationDeg: number | null
  descentMs: number
  ascentMs: number
  /** True when the rep never reached the depth threshold. Still counted. */
  partial: boolean
  /**
   * True when NO FAULT WAS DETECTED in this rep.
   *
   * Not a claim that the form was good — only that nothing measurable was wrong. A rep
   * with `hipDeviationDeg === null` can be clean while the back was never seen at all, so
   * a caller that wants "verified good form" must check `clean && hipDeviationDeg !== null`.
   * `toEventLine` states the unobserved case in words for exactly this reason.
   */
  clean: boolean
}

export type CoachEvent =
  | { kind: 'set_started'; at: number; target: number }
  | { kind: 'rep_completed'; at: number; rep: RepMetrics; totalReps: number; cleanReps: number }
  | { kind: 'form_fault'; at: number; fault: FaultType; severity: Severity; valueDeg?: number; heldFrames: number }
  | { kind: 'out_of_frame'; at: number; missing: string[] }
  | { kind: 'back_in_frame'; at: number }
  /**
   * Reps are countable but the body line is not measurable — typically the feet are
   * cropped out of shot. `missing` names the joints, `sinceMs` is how long it has been
   * true, so a repeat nag can read differently from the first mention.
   */
  | { kind: 'form_unobservable'; at: number; missing: string[]; sinceMs: number }
  | { kind: 'form_observable'; at: number }
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
  /**
   * Enough of the user is visible to COUNT reps (shoulder, elbow, wrist). It used to mean
   * the full set including the ankle, which reported "out of frame" at a user who was in
   * frame and being counted. Whether their FORM can be judged is the separate flag below.
   */
  inFrame: boolean
  /**
   * Whether the body line was measurable on the last processed frame — hip and ankle both
   * visible. False means reps are still counting but no sag or pike judgement is possible.
   *
   * OPTIONAL for backward compatibility: pre-existing `WorkoutState` literals (the initial
   * state in App.tsx) do not set it, and `undefined` must be read as "unknown", not as
   * false, or a UI would announce a camera problem before the first frame is processed.
   */
  bodyLineObservable?: boolean
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
 * Wording and thresholds for the rendered event lines. Named because these strings are
 * the entire AI-facing interface and the model quotes them back verbatim.
 */
export const EVENT_LINE = {
  /**
   * Minimum |hipDeviationDeg| before the line makes a sag/pike claim at all.
   *
   * MUST stay in step with `REP_THRESHOLDS.cleanHipDeviationDeg` by hand: this file is
   * deliberately dependency-free (src/pose imports it, not the other way round), so
   * nothing can check the relationship for you. Below it, the deviation is within
   * measurement noise and saying a number would invite the coach to nitpick it.
   */
  hipClaimMinDeg: 10,
  /**
   * Said instead of a hip number when the body line was never measured. It has to appear
   * on the line, not be silently omitted: without it "3 of 3 clean" reads as verified
   * good form, and the whole point is that the back was never on camera.
   */
  bodyLineUnseen: 'body line not visible — no hip judgement',
  /**
   * Floor on a duration rendered in whole seconds.
   *
   * `form_unobservable` is debounced by frame count, not by time: `OBSERVABILITY.lostFrames`
   * is 15, which at 30fps makes the FIRST mention's `sinceMs` about 467 — and
   * `Math.round(467 / 1000)` is 0, so the line read "cannot see ankle for 0s", a sentence that
   * contradicts itself (0 seconds of not seeing something is seeing it). Measured on all three
   * utterances of the real-footage replay and on the synthetic footless set: 466.6 / 466.6 /
   * 466.7 / 466.7 ms. The event only exists because the joint has been gone for a real
   * interval, so the smallest honest whole-second rendering is 1.
   */
  minReportedSec: 1,
} as const

/** Whole seconds, never rounded down to a self-contradicting zero. See `minReportedSec`. */
function reportedSec(ms: number): number {
  return Math.max(EVENT_LINE.minReportedSec, Math.round(ms / 1000))
}

/**
 * The entire vision -> AI interface. Renders a CoachEvent as the single text line
 * pushed to the model as a synthetic user turn.
 *
 * Deliberately compact and consistently shaped: the model quotes these numbers
 * back, so the format needs to read unambiguously. The [EVENT] prefix stops the
 * model mistaking telemetry for something the user said out loud.
 *
 * IT MAY ONLY STATE WHAT WAS MEASURED. A hip claim requires a non-null deviation; an
 * unmeasured body line is reported as unmeasured. The coach has no other source of truth,
 * so a number invented here is a number the coach will confidently say out loud.
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
      if (r.hipDeviationDeg === null) {
        bits.push(EVENT_LINE.bodyLineUnseen)
      } else if (!r.partial && Math.abs(r.hipDeviationDeg) >= EVENT_LINE.hipClaimMinDeg) {
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

    case 'form_unobservable':
      // Phrased as a camera instruction, not a fault: the user has done nothing wrong and
      // there is a concrete fix. `sinceMs` lets the model tell a first mention from a nag.
      return (
        `[EVENT] counting reps but cannot see ${e.missing.join(', ')} for ${reportedSec(e.sinceMs)}s ` +
        '— body line cannot be judged; tell the user to back up or tilt the camera down'
      )

    case 'form_observable':
      return `[EVENT] body line visible again — form can be judged`

    case 'idle':
      return `[EVENT] no movement for ${Math.round(e.sinceMs / 1000)}s`

    case 'set_ended': {
      const f = e.faults.length ? ` | faults seen: ${e.faults.join(', ')}` : ' | no faults'
      return `[EVENT] set ended | ${e.totalReps} reps | ${e.cleanReps} clean${f}`
    }
  }
}
