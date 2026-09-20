/**
 * "I CAN COUNT, BUT I CANNOT SEE YOUR HIPS." A pure reducer, no timers, no DOM.
 *
 * The state it owns is narrow and specific: reps are being counted, but the body line is
 * not measurable, so no sag or pike judgement is possible. That is worth SAYING, because
 * unlike a form fault it has a concrete fix the user can act on — back up, or tilt the
 * camera down — and because a coach that silently stops judging form while praising reps is
 * a coach that is quietly lying by omission.
 *
 * WHY IT IS NOT `out_of_frame`. That event means the user is gone and nothing is being
 * measured; it sets `WorkoutState.inFrame` false and suppresses fault evaluation. This is
 * the opposite situation and needs opposite handling, so it gets its own event kind. It is
 * also not a `FaultType`: the user has done nothing wrong, and `FaultType` is a closed set
 * that src/coach must cover with a reference clip each.
 *
 * WHY IT IS DEBOUNCED THREE WAYS. A per-frame signal at 30fps is 30 utterances a second.
 *   1. `lostFrames` / `regainedFrames` — a run of consecutive frames before either
 *      transition is announced, so an ankle flickering across the visibility gate says
 *      nothing at all.
 *   2. `repeatMs` — while it stays unobservable the nag repeats at most this often, because
 *      the user may not have heard the first one, and never more often.
 *   3. `canSpeak` — supplied by the CALLER from the fault gate's global bucket
 *      (`canSpeak(gateState, t, rank)`), so this shares one utterance budget with faults
 *      and rep callouts instead of inventing a second one. A refused announcement is
 *      retried on the next frame rather than dropped: the state only advances once
 *      something was actually said.
 *
 * TUNABLES LIVE IN: `OBSERVABILITY` (this file).
 */

import type { CoachEvent } from '../types/events'
import { UTTERANCE_RANK } from './faults'

export const OBSERVABILITY = {
  /**
   * Rank this signal claims in the gate's shared utterance bucket.
   *
   * MINOR, not routine, and that is not a value judgement — it is arithmetic. Rep callouts
   * sit at `routine` and fire roughly once a second during a set, and `canSpeak` only lets
   * an equal-rank utterance through after a 3-second silence. At `routine` this nag is
   * therefore starved for the whole set: replaying a footless 3-rep set through the pipeline
   * produced ZERO utterances. `minor` outranks the rep callouts it has to interrupt, and
   * still loses to any `major` or `severe` fault, which is the correct precedence — a real
   * fault the coach CAN see beats a complaint about the camera.
   */
  rank: UTTERANCE_RANK.minor,
  /**
   * Consecutive frames with no measurable body line before the coach mentions it. 15 is
   * ~500ms at 30fps — long enough that a leg crossing the visibility gate mid-rep is not
   * worth a sentence, short enough that the user hears it while still in position.
   */
  lostFrames: 15,
  /**
   * Consecutive frames WITH a body line before announcing it is back. Deliberately lower:
   * the good news is cheap and its worst case is arriving a few frames early.
   */
  regainedFrames: 10,
  /**
   * Minimum spacing between repeats of the same "cannot see you" nag. 20s: a set lasts
   * ~60s, so a user who ignores the first mention hears it about twice more, not thirty
   * times a second.
   */
  repeatMs: 20_000,
} as const

export interface ObservabilityState {
  /** What the user has been TOLD, not what this frame shows. */
  readonly announced: boolean
  /** Consecutive frames with no body line. */
  readonly badFrames: number
  /** Consecutive frames with one. */
  readonly goodFrames: number
  /** When the current run of unmeasurable frames began, or null. */
  readonly lostAt: number | null
  /** When the nag was last actually spoken, or null. */
  readonly spokenAt: number | null
}

export interface ObservabilityInput {
  /** Whether THIS frame produced a body line (`angles.hipDeviation !== null`). */
  measurable: boolean
  /** Joint names to blame, for the event's `missing`. Ignored while measurable. */
  missing: readonly string[]
  t: number
  /** The gate's verdict on whether anything may be said right now. */
  canSpeak: boolean
}

export interface ObservabilityResult {
  state: ObservabilityState
  /** At most one event per frame. */
  events: CoachEvent[]
}

export function createObservabilityState(): ObservabilityState {
  return { announced: false, badFrames: 0, goodFrames: 0, lostAt: null, spokenAt: null }
}

/** True when the run of unmeasurable frames is long enough to be worth a sentence. */
function lostLongEnough(badFrames: number): boolean {
  return badFrames >= OBSERVABILITY.lostFrames
}

function dueForRepeat(state: ObservabilityState, t: number): boolean {
  return state.spokenAt === null || t - state.spokenAt >= OBSERVABILITY.repeatMs
}

function whileUnmeasurable(
  state: ObservabilityState,
  input: ObservabilityInput,
): ObservabilityResult {
  const badFrames = state.badFrames + 1
  const lostAt = state.lostAt ?? input.t
  const tracked: ObservabilityState = { ...state, badFrames, goodFrames: 0, lostAt }

  const wanted = lostLongEnough(badFrames) && dueForRepeat(state, input.t)
  if (!wanted || !input.canSpeak) {
    // Not yet, or not allowed. `announced` is untouched, so a refusal is retried next frame
    // rather than silently swallowed.
    return { state: tracked, events: [] }
  }
  return {
    state: { ...tracked, announced: true, spokenAt: input.t },
    events: [
      {
        kind: 'form_unobservable',
        at: input.t,
        missing: [...input.missing],
        sinceMs: Math.max(0, input.t - lostAt),
      },
    ],
  }
}

function whileMeasurable(state: ObservabilityState, input: ObservabilityInput): ObservabilityResult {
  const goodFrames = state.goodFrames + 1
  const tracked: ObservabilityState = { ...state, goodFrames, badFrames: 0, lostAt: null }

  if (!state.announced || goodFrames < OBSERVABILITY.regainedFrames) {
    return { state: tracked, events: [] }
  }
  if (!input.canSpeak) return { state: tracked, events: [] }
  // `spokenAt` is cleared, not set: the next loss is a fresh first mention, not a repeat.
  return {
    state: { ...tracked, announced: false, spokenAt: null },
    events: [{ kind: 'form_observable', at: input.t }],
  }
}

/**
 * Advance by one COUNTABLE frame. Callers must not feed frames where the user is absent
 * entirely — that is `out_of_frame`'s job, and reporting "I cannot see your hips" to an
 * empty room would be both useless and confusing.
 */
export function stepObservability(
  state: ObservabilityState,
  input: ObservabilityInput,
): ObservabilityResult {
  if (!Number.isFinite(input.t)) return { state, events: [] }
  return input.measurable ? whileMeasurable(state, input) : whileUnmeasurable(state, input)
}
