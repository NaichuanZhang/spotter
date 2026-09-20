/**
 * MAY THE COACH SPEAK, RIGHT NOW, ABOUT THIS? A pure reducer over one shared bucket.
 *
 * This is the single choke point for everything the coach says out loud. It sits in front
 * of `conn.pushEvent`, which is the only path from a `CoachEvent` to a sentence, and it
 * answers two questions in order:
 *
 *   1. IS IT WORTH SAYING?  Rep callouts go through `selectRepCallout` (repCallout.ts).
 *      Everything else has already been selected by the gate that owns it — faults by
 *      `gate()`, the camera nag by `stepObservability()` — so it arrives pre-filtered.
 *   2. MAY ANYTHING BE SAID? `canSpeak` from src/pose/faults.ts, plus three narrowings:
 *      the listen window, the pre-emption floor, and the user's own turn.
 *
 * ONE BUCKET, NOT TWO. `canSpeak` / `noteUtterance` / `UTTERANCE_RANK` are imported from
 * the fault gate rather than reimplemented, and `canSpeak`'s own doc comment asks for
 * exactly this ("Exported so the coach layer can throttle its own non-fault chatter through
 * the same bucket rather than inventing a second, conflicting one"). Every utterance the
 * coach makes — fault, rep callout, camera nag, answer to the user — lands in the ONE
 * `GateState` held here, at a rank comparable with every other. That is what keeps the
 * property the ranks exist for: a severe fault pre-empts a routine rep callout, never the
 * reverse.
 *
 * THE THREE NARROWINGS, and the symptom each one is for:
 *
 *   LISTEN WINDOW — the coach was talking without stopping, and `micUplink`'s gate is
 *      `() => !audio.isSpeaking()`, so the user could not be heard at all. Measured from
 *      when the coach's audio has DRAINED, which is neither when the event was pushed nor
 *      when `response.done` arrived: at `response.done` there are still seconds of PCM
 *      scheduled in `audioOut` (measured 0.3-2.5s of queue). The drain time comes from
 *      `audioOut.queuedSec()`, read-only, via `observeSpeech`.
 *   PRE-EMPTION FLOOR — the coach interrupted itself. `canSpeak` lets ANY higher rank cut
 *      in inside `GATE_CONFIG.globalIntervalMs`, and a partial rep emits a rep callout AND
 *      a `partial_depth` fault from the same frame, so the fault barged in on a sentence
 *      that had just started to say the same thing again.
 *   USER TURN — the server's VAD tells us when the user started and stopped talking
 *      (`input_audio_buffer.speech_started` / `.speech_stopped`). A rep landing mid-sentence
 *      used to interrupt the person the coach is supposed to be listening to.
 *
 * WHAT THIS FILE MAY NOT DO: queue. A refused utterance is either retried by whoever owns
 * it (faults after their cooldown, the camera nag on the next frame, a rep callout on the
 * next rep) or collapsed into a tally (`noteSilentRep`). Nothing is stored to be said
 * later, because a backlog spoken late is the same bug with a delay on it.
 *
 * TUNABLES LIVE IN: `SPEECH_TUNING` (speechTuning.ts).
 */

import { toEventLine } from '../types/events'
import type { CoachEvent } from '../types/events'
import type { GateState } from '../pose/faults'
import { canSpeak, createGateState, GATE_CONFIG, noteUtterance, UTTERANCE_RANK } from '../pose/faults'
import { OBSERVABILITY } from '../pose/observability'
import { createRepCalloutState, noteSilentRep, noteSpokenRep, repCalloutLine, selectRepCallout } from './repCallout'
import type { RepCalloutState } from './repCallout'
import { SPEECH_TUNING } from './speechTuning'

/**
 * How an event is arbitrated.
 *
 *   mandatory — always spoken, and it still takes the bucket. Reserved for the events that
 *               CANNOT be retried: the set's own lifecycle, and the framing transitions
 *               (`out_of_frame` / `back_in_frame` fire once on a debounced edge, so a
 *               dropped one is never re-proposed and the coach would silently stop
 *               acknowledging that the user walked away).
 *   ranked    — subject to every brake, at the rank `rankFor` gives it.
 *   rep       — ranked, plus the milestone policy and the collapsing backlog.
 */
export type UtteranceClass = 'mandatory' | 'ranked' | 'rep'

export interface SpeechPolicyState {
  /** THE bucket. Same type, same functions, same rank scale as the fault gate. */
  readonly gate: GateState
  readonly reps: RepCalloutState
  /**
   * When the coach's currently-queued audio will have finished playing, or null before it
   * has ever spoken. NOT when the event was pushed and NOT `response.done`.
   */
  readonly speechEndsAt: number | null
  /** The server's VAD says the user is mid-utterance. */
  readonly userSpeaking: boolean
  /** Grace period after the user stopped, or null. */
  readonly userTurnUntil: number | null
  /** Rep target, learned from `set_started` or supplied per call. */
  readonly target: number | null
}

export interface SpeechInput {
  readonly event: CoachEvent
  /** Milliseconds on the same monotonic clock as `CoachEvent.at` (`performance.now()`). */
  readonly t: number
  /** `audioOut.queuedSec()` — coach audio scheduled but not yet heard. Read-only. */
  readonly queuedSec: number
  /** Authoritative target when the caller has one (`WorkoutState.target`). */
  readonly target?: number | null
}

export interface SpeechDecision {
  readonly state: SpeechPolicyState
  /** The exact line to push, or null to stay silent. */
  readonly line: string | null
  readonly rank: number
  /** Always populated, spoken or not, so a suppression is logged and never swallowed. */
  readonly reason: string
}

export function createSpeechPolicyState(): SpeechPolicyState {
  return {
    gate: createGateState(),
    reps: createRepCalloutState(),
    speechEndsAt: null,
    userSpeaking: false,
    userTurnUntil: null,
    target: null,
  }
}

// ------------------------------------------------------------------ classification

/**
 * The rank an event claims in the shared bucket.
 *
 * `form_unobservable` borrows `OBSERVABILITY.rank` rather than restating it: that value is
 * `minor` for a measured reason (at `routine` the nag was starved to zero utterances over a
 * whole footless set) and two copies of it would drift.
 */
export function rankFor(event: CoachEvent): number {
  switch (event.kind) {
    case 'form_fault':
      return UTTERANCE_RANK[event.severity]
    case 'out_of_frame':
      return UTTERANCE_RANK.major
    case 'form_unobservable':
    case 'form_observable':
      return OBSERVABILITY.rank
    case 'set_started':
    case 'set_ended':
      // Mandatory anyway; this is the rank they OCCUPY, so a minor fault cannot cut in on
      // the greeting or the wrap-up.
      return UTTERANCE_RANK.major
    case 'back_in_frame':
    case 'idle':
    case 'rep_completed':
      return UTTERANCE_RANK.routine
  }
}

export function classFor(event: CoachEvent): UtteranceClass {
  switch (event.kind) {
    case 'rep_completed':
      return 'rep'
    case 'set_started':
    case 'set_ended':
    case 'out_of_frame':
    case 'back_in_frame':
      return 'mandatory'
    default:
      return 'ranked'
  }
}

// -------------------------------------------------------------------- the brakes

/**
 * Folds in what `audioOut` currently knows about its own queue. Extends only: the latest
 * observation can push the drain time OUT, never pull it in, because a shorter queue just
 * means we are further through the same utterance.
 *
 * Called on every decision AND on the audio boundaries, so the estimate is exact at the one
 * moment that matters — `response.done` / `output_audio.done`, when the whole utterance is
 * queued and `queuedSec()` is precisely how much is left to hear.
 */
export function observeSpeech(state: SpeechPolicyState, t: number, queuedSec: number): SpeechPolicyState {
  if (!Number.isFinite(t) || !Number.isFinite(queuedSec) || queuedSec <= 0) return state
  const endsAt = t + queuedSec * 1000
  if (state.speechEndsAt !== null && state.speechEndsAt >= endsAt) return state
  return { ...state, speechEndsAt: endsAt }
}

/**
 * The coach's audio is gone as of `t` — a barge-in dropped the queue, or the socket closed.
 * Starts the listen window HERE rather than leaving a stale drain time in the future, which
 * would gag the coach for the length of an utterance nobody heard.
 */
export function noteSilenceStart(state: SpeechPolicyState, t: number): SpeechPolicyState {
  if (!Number.isFinite(t)) return state
  return { ...state, speechEndsAt: t, userSpeaking: false, userTurnUntil: null }
}

/** Server VAD edges. `speaking: false` also hands the bucket to the coach's answer. */
export function noteUserSpeech(state: SpeechPolicyState, t: number, speaking: boolean): SpeechPolicyState {
  if (!Number.isFinite(t)) return state
  if (speaking) return { ...state, userSpeaking: true, userTurnUntil: null }
  return {
    ...state,
    userSpeaking: false,
    userTurnUntil: t + SPEECH_TUNING.userTurnGraceMs,
    gate: noteUtterance(state.gate, t, SPEECH_TUNING.userTurnRank),
  }
}

/** A typed user turn. Same accounting as a spoken one: the answer must not be trampled. */
export function noteUserTurn(state: SpeechPolicyState, t: number): SpeechPolicyState {
  if (!Number.isFinite(t)) return state
  return { ...state, gate: noteUtterance(state.gate, t, SPEECH_TUNING.userTurnRank) }
}

/** True while the coach's own audio is still playing, or inside the silence after it. */
export function inListenWindow(state: SpeechPolicyState, t: number): boolean {
  if (state.speechEndsAt === null) return false
  // Negative while audio is still queued, which is the same answer for a different reason.
  return t - state.speechEndsAt < SPEECH_TUNING.listenWindowMs
}

export function userBusy(state: SpeechPolicyState, t: number): boolean {
  if (state.userSpeaking) return true
  return state.userTurnUntil !== null && t < state.userTurnUntil
}

/**
 * `canSpeak`'s pre-emption branch, narrowed. `canSpeak` says an utterance may jump the
 * global interval whenever it outranks the last one; this adds the floor that stops the
 * coach cutting ITSELF off with a duplicate from the same frame.
 */
export function mayPreempt(gate: GateState, t: number, rank: number): boolean {
  const last = gate.lastUtteranceAt
  if (last === null || t - last >= GATE_CONFIG.globalIntervalMs) return true
  return rank >= SPEECH_TUNING.preemptMinRank
}

/** Why the coach must stay quiet, or null if it may speak. */
function holdReason(state: SpeechPolicyState, t: number, rank: number): string | null {
  const breaks = rank >= SPEECH_TUNING.windowBreakMinRank
  if (!breaks && userBusy(state, t)) return 'held: the user has the floor'
  if (!breaks && inListenWindow(state, t)) return 'held: listen window'
  if (!canSpeak(state.gate, t, rank)) return 'held: utterance bucket'
  if (!mayPreempt(state.gate, t, rank)) return 'held: would cut off the line in progress'
  return null
}

// ------------------------------------------------------------------ the decision

function withContext(state: SpeechPolicyState, input: SpeechInput): SpeechPolicyState {
  const { event } = input
  const declared = event.kind === 'set_started' ? event.target : null
  const target = input.target ?? declared ?? state.target
  const observed = observeSpeech(state, input.t, input.queuedSec)
  return observed.target === target ? observed : { ...observed, target }
}

function spoke(state: SpeechPolicyState, t: number, rank: number, line: string, reason: string): SpeechDecision {
  return { state: { ...state, gate: noteUtterance(state.gate, t, rank) }, line, rank, reason }
}

function decideRanked(state: SpeechPolicyState, input: SpeechInput, rank: number): SpeechDecision {
  const { event, t } = input
  if (classFor(event) !== 'mandatory') {
    const held = holdReason(state, t, rank)
    if (held !== null) return { state, line: null, rank, reason: `${held} (${event.kind})` }
  }
  return spoke(state, t, rank, toEventLine(event), `spoke: ${event.kind}`)
}

function decideRep(state: SpeechPolicyState, input: SpeechInput, rank: number): SpeechDecision {
  const { event, t } = input
  if (event.kind !== 'rep_completed') return decideRanked(state, input, rank)
  const milestone = selectRepCallout(state.reps, event.rep, event.totalReps, state.target)
  const silent = (reason: string): SpeechDecision => ({
    state: { ...state, reps: noteSilentRep(state.reps, event.rep) },
    line: null,
    rank,
    reason,
  })
  if (milestone === null) return silent('held: not a milestone (rep_completed)')
  // The one callout with no second chance: every other reason is re-proposed on the next
  // rep, "you hit the target" is true exactly once.
  const unstoppable = milestone === 'target_reached' && SPEECH_TUNING.callTargetReached
  const held = unstoppable ? null : holdReason(state, t, rank)
  if (held !== null) return silent(`${held} (rep ${milestone})`)
  // Read the digest BEFORE noteSpokenRep clears the tally it describes.
  const line = repCalloutLine(state.reps, event)
  const next = spoke(state, t, rank, line, `spoke: rep ${milestone}`)
  return { ...next, state: { ...next.state, reps: noteSpokenRep(state.reps, event.rep, event.totalReps) } }
}

/**
 * The whole policy in one call. Returns the line to push (or null) and the state to thread
 * forward — the caller MUST keep the returned state, or every event is judged from a blank
 * slate and the coach is exactly as eager as it was before.
 */
export function decideSpeech(state: SpeechPolicyState, input: SpeechInput): SpeechDecision {
  const base = withContext(state, input)
  const rank = rankFor(input.event)
  return classFor(input.event) === 'rep'
    ? decideRep(base, input, rank)
    : decideRanked(base, input, rank)
}
