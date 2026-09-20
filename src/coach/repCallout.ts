/**
 * WHICH REPS ARE WORTH SAYING SOMETHING ABOUT. A pure reducer: no timers, no Date.now,
 * state threaded by the caller.
 *
 * Every rep still goes into the counter and the workout state — the pose engine emits
 * `rep_completed` for all of them, and both the HUD and `WorkoutState` keep seeing every
 * one. This file only decides which of them the coach OPENS ITS MOUTH for, which used to
 * be "all of them" and is the reason it felt like a machine reading a log file out loud.
 *
 * WHY MILESTONES AND NOT JUST A THROTTLE. "Every 4th rep" alone trades one broken-feeling
 * coach for another: a human spotter that spoke on reps 4, 8 and 12 and ignored the rep you
 * folded in half on is not quiet, it is not watching. So the selector has two halves:
 *
 *   RHYTHM   — the first rep, a cadence, the final stretch, the target. These make the set
 *              feel counted.
 *   NOTABLE  — a partial rep, a new best depth, a big tempo change. These make it feel
 *              watched, and they are the ones that cannot wait for the cadence.
 *
 * THE BACKLOG DECAYS, IT DOES NOT QUEUE. A rep the coach stayed quiet for is folded into
 * `silentReps` and then FORGOTTEN as an individual utterance. Three reps during a quiet
 * period can never become three sentences in a row; they become one clause on the next line
 * the coach was going to say anyway ("3 reps went by without comment"). That is the whole
 * difference between pacing a coach and delaying it.
 *
 * TUNABLES LIVE IN: `SPEECH_TUNING` (speechTuning.ts). AI-FACING WORDING: `REP_CALLOUT_LINE`
 * (this file), for the same reason `EVENT_LINE` lives beside `toEventLine` — the model
 * quotes these clauses back verbatim.
 */

import { toEventLine } from '../types/events'
import type { CoachEvent, RepMetrics } from '../types/events'
import { SPEECH_TUNING } from './speechTuning'

/** Why a rep earned a callout. Reported to the debug log, never spoken as a slug. */
export type RepCalloutReason =
  | 'first'
  | 'cadence'
  | 'final_stretch'
  | 'target_reached'
  | 'partial'
  | 'best_depth'
  | 'tempo_shift'

export interface RepCalloutState {
  /** Best depth of the set so far, or null before the first rep. */
  readonly bestDepthPct: number | null
  /** Index of the last rep the coach actually SPOKE about. 0 = none yet. */
  readonly lastSpokenRep: number
  /** Total duration of the previous rep, for the tempo comparison. */
  readonly lastTempoMs: number | null
  /** Reps counted but not spoken about since the last callout. The decaying backlog. */
  readonly silentReps: number
  /** How many of those had no fault detected — see `RepMetrics.clean`. */
  readonly silentCleanReps: number
}

/**
 * The clauses appended to a rep line, named because the model reads them out. Phrased as
 * an instruction, like `toEventLine`'s camera advice, because a bare count invites the
 * coach to enumerate the reps it just chose not to enumerate.
 *
 * "no faults detected" and NOT "all clean" on purpose: `RepMetrics.clean` means exactly
 * "nothing measurable was wrong", and on footage where the feet are cropped the body line
 * was never seen at all. "All clean" would be the same praise-what-you-cannot-see lie the
 * `bodyLineUnseen` clause exists to prevent.
 */
export const REP_CALLOUT_LINE = {
  oneRep: '1 rep went by without comment',
  manyReps: (n: number) => `${n} reps went by without comment`,
  noFaults: 'no faults detected in them',
  someFlagged: (n: number) => `${n} of them flagged`,
  instruction: 'cover them in one breath, do not list them',
} as const

export function createRepCalloutState(): RepCalloutState {
  return {
    bestDepthPct: null,
    lastSpokenRep: 0,
    lastTempoMs: null,
    silentReps: 0,
    silentCleanReps: 0,
  }
}

/** One rep's wall-clock cost. The tempo signal is the whole rep, not half of it. */
export function repTempoMs(rep: RepMetrics): number {
  return Math.max(0, rep.descentMs) + Math.max(0, rep.ascentMs)
}

function isNewBestDepth(state: RepCalloutState, rep: RepMetrics): boolean {
  if (state.bestDepthPct === null) return false
  return rep.depthPct >= state.bestDepthPct + SPEECH_TUNING.newBestDepthPct
}

function isTempoShift(state: RepCalloutState, rep: RepMetrics): boolean {
  const previous = state.lastTempoMs
  const current = repTempoMs(rep)
  if (previous === null) return false
  // Both ends must be real reps, not a frame-quantised blip: a 200ms "rep" would make
  // every comparison look like a 50% change.
  if (previous < SPEECH_TUNING.tempoFloorMs || current < SPEECH_TUNING.tempoFloorMs) return false
  return Math.abs(current - previous) >= previous * SPEECH_TUNING.tempoShiftRatio
}

/**
 * THE MILESTONE POLICY. Null means "count it, say nothing".
 *
 * Order is precedence, and it is deliberate: the end of the set outranks the start of it,
 * the rhythm outranks the anomalies (a partial rep on the target rep is still "you
 * finished"), and the cadence is last because it is the fallback that stops a clean set
 * going completely silent.
 *
 * `target` of 0 or less means "no target set", which disables both target-shaped reasons
 * rather than making every rep the final stretch.
 */
export function selectRepCallout(
  state: RepCalloutState,
  rep: RepMetrics,
  totalReps: number,
  target: number | null,
): RepCalloutReason | null {
  const hasTarget = target !== null && target > 0
  if (hasTarget && totalReps === target) return 'target_reached'
  if (totalReps <= 1) return 'first'
  if (hasTarget && totalReps < target && totalReps > target - SPEECH_TUNING.finalStretchReps) {
    return 'final_stretch'
  }
  if (rep.partial) return 'partial'
  if (isNewBestDepth(state, rep)) return 'best_depth'
  if (isTempoShift(state, rep)) return 'tempo_shift'
  if (totalReps - state.lastSpokenRep >= SPEECH_TUNING.repCadence) return 'cadence'
  return null
}

/** Set-wide measurements that advance whether or not the rep was spoken about. */
function trackRep(state: RepCalloutState, rep: RepMetrics): Pick<RepCalloutState, 'bestDepthPct' | 'lastTempoMs'> {
  return {
    bestDepthPct: Math.max(state.bestDepthPct ?? rep.depthPct, rep.depthPct),
    lastTempoMs: repTempoMs(rep),
  }
}

/** The coach spoke about this rep: the backlog is discharged, not carried forward. */
export function noteSpokenRep(state: RepCalloutState, rep: RepMetrics, totalReps: number): RepCalloutState {
  return {
    ...state,
    ...trackRep(state, rep),
    lastSpokenRep: totalReps,
    silentReps: 0,
    silentCleanReps: 0,
  }
}

/**
 * The coach stayed quiet for this rep. It joins a TALLY, not a queue — nothing here can
 * later become an utterance of its own, which is what stops three suppressed reps turning
 * into three sentences the moment the listen window closes.
 */
export function noteSilentRep(state: RepCalloutState, rep: RepMetrics): RepCalloutState {
  return {
    ...state,
    ...trackRep(state, rep),
    silentReps: state.silentReps + 1,
    silentCleanReps: state.silentCleanReps + (rep.clean ? 1 : 0),
  }
}

/** The collapsed clause, or null when there is nothing worth collapsing. */
export function silentRepDigest(state: RepCalloutState): string | null {
  const n = state.silentReps
  if (n < SPEECH_TUNING.mentionSilentRepsFrom || n < 1) return null
  const count = n === 1 ? REP_CALLOUT_LINE.oneRep : REP_CALLOUT_LINE.manyReps(n)
  const flagged = n - state.silentCleanReps
  const quality = flagged > 0 ? REP_CALLOUT_LINE.someFlagged(flagged) : REP_CALLOUT_LINE.noFaults
  return `${count}, ${quality} — ${REP_CALLOUT_LINE.instruction}`
}

/**
 * The line actually pushed for a spoken rep callout.
 *
 * `toEventLine` renders the rep itself — it is the frozen vision-to-AI interface and the
 * only thing allowed to phrase a measurement — and the digest is appended in the same
 * pipe-separated house style. Read `state` BEFORE `noteSpokenRep` clears it.
 */
export function repCalloutLine(state: RepCalloutState, event: CoachEvent): string {
  const base = toEventLine(event)
  const digest = silentRepDigest(state)
  return digest === null ? base : `${base} | ${digest}`
}
