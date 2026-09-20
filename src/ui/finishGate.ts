/**
 * The double-fire guard for the end of a set.
 *
 * There are THREE ways a set can end and they are not mutually exclusive — which is
 * the whole reason this module exists rather than a bare boolean at the call site:
 *
 *   target_reached    — the twentieth rep landed. Detected from `rep_completed`,
 *                       because the pose engine does NOT emit `set_ended` at the
 *                       target; `set_ended` comes only from `stop()`.
 *   coach_logged_set  — the user said they were done and the coach called log_set.
 *   set_ended         — the engine stopped and emitted its own wrap-up event.
 *
 * Reaching the target makes us stop the engine, and stopping the engine emits
 * `set_ended` SYNCHRONOUSLY, so route 1 always produces route 3 a few microseconds
 * later. Route 2 does the same. Without a latch the ending screen would be entered
 * two or three times per set, each entry re-reading the stats and re-firing the
 * spoken closing line.
 *
 * `latchFinish` RETURNS THE SAME OBJECT when it is already latched, on purpose: the
 * caller's test for "did this call win?" is a reference comparison, which cannot
 * drift out of step with the reason the way a separate boolean can.
 */

export type FinishReason = 'target_reached' | 'coach_logged_set' | 'set_ended'

export interface FinishLatch {
  /** Null while the set is still running. The winning route once it is over. */
  readonly reason: FinishReason | null
}

export const OPEN_LATCH: FinishLatch = Object.freeze({ reason: null })

/** First caller wins. Later callers get the identical object back, never a new one. */
export function latchFinish(latch: FinishLatch, reason: FinishReason): FinishLatch {
  if (latch.reason !== null) return latch
  return Object.freeze({ reason })
}

export function isLatched(latch: FinishLatch): boolean {
  return latch.reason !== null
}

/** The eyebrow above the verdict. Names the route, because the routes feel different. */
export const FINISH_LABEL: Readonly<Record<FinishReason, string>> = Object.freeze({
  target_reached: 'TARGET REACHED',
  coach_logged_set: 'SET LOGGED',
  set_ended: 'SET ENDED',
})
