/**
 * What the user actually did, folded out of the CoachEvent stream.
 *
 * WHY THIS EXISTS AT ALL. `WorkoutState` carries the live counters but not the
 * history: there is no partial-rep count, no best depth, no list of the faults that
 * fired, and no record of whether the body line was ever measurable. `set_ended`
 * carries the fault list, but the engine only emits it from `stop()` — reaching the
 * target emits nothing — so the ending screen cannot wait for it. Everything here is
 * accumulated as the events arrive instead.
 *
 * THE HONESTY RULE, from the amendment log in src/types/events.ts. `RepMetrics.clean`
 * means "no fault was DETECTED", not "the back was straight", because
 * `hipDeviationDeg` is NULL whenever the hip or the ankle was off camera. So this
 * ledger counts `measuredReps` separately from `cleanReps`: the pair is what lets the
 * screen say "18 of 20 clean" only when it is allowed to, and say why when it is not.
 * A ledger that tracked `cleanReps` alone would make "18 of 20 clean" unfalsifiable.
 *
 * Pure and immutable: every fold returns a new ledger, so the whole module is
 * testable without a camera, a socket or a DOM.
 */
import type { CoachEvent, FaultType } from '../types/events'

export interface SetLedger {
  /** Authoritative rep count, taken from the event rather than incremented here. */
  readonly reps: number
  /** Reps in which NO FAULT WAS DETECTED. Not a claim about form. See the header. */
  readonly cleanReps: number
  readonly partialReps: number
  /** Deepest rep of the set, 0..100. 0 when no rep completed. */
  readonly bestDepthPct: number
  /** Reps whose body line was measurable at all (hip AND ankle on camera). */
  readonly measuredReps: number
  /**
   * The signed body-line deviation of largest magnitude across the measured reps,
   * degrees. Positive = sag, negative = pike, matching the frozen contract. NULL when
   * no rep was ever measurable — never 0, which already means "straight".
   */
  readonly worstHipDeviationDeg: number | null
  /** Distinct faults, in the order they first fired. */
  readonly faults: readonly FaultType[]
  /** performance.now() stamps, the same clock every CoachEvent.at uses. */
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly lastRepAt: number | null
}

export const EMPTY_LEDGER: SetLedger = Object.freeze({
  reps: 0,
  cleanReps: 0,
  partialReps: 0,
  bestDepthPct: 0,
  measuredReps: 0,
  worstHipDeviationDeg: null,
  faults: Object.freeze([]),
  startedAt: null,
  endedAt: null,
  lastRepAt: null,
})

/** Keeps first-seen order and never duplicates. Returns the SAME array if unchanged. */
function withFault(faults: readonly FaultType[], fault: FaultType): readonly FaultType[] {
  return faults.includes(fault) ? faults : [...faults, fault]
}

function withFaults(faults: readonly FaultType[], incoming: readonly FaultType[]): readonly FaultType[] {
  return incoming.reduce<readonly FaultType[]>(withFault, faults)
}

/** Largest magnitude wins, and the SIGN of that extreme is kept. */
function worseDeviation(previous: number | null, next: number | null): number | null {
  if (next === null) return previous
  if (previous === null) return next
  return Math.abs(next) > Math.abs(previous) ? next : previous
}

export function foldSetEvent(ledger: SetLedger, event: CoachEvent): SetLedger {
  switch (event.kind) {
    case 'set_started':
      // A new set is a new ledger. Anything carried over would be last set's work.
      return { ...EMPTY_LEDGER, startedAt: event.at }

    case 'rep_completed':
      return {
        ...ledger,
        reps: event.totalReps,
        cleanReps: event.cleanReps,
        partialReps: ledger.partialReps + (event.rep.partial ? 1 : 0),
        bestDepthPct: Math.max(ledger.bestDepthPct, event.rep.depthPct),
        measuredReps: ledger.measuredReps + (event.rep.hipDeviationDeg === null ? 0 : 1),
        worstHipDeviationDeg: worseDeviation(ledger.worstHipDeviationDeg, event.rep.hipDeviationDeg),
        lastRepAt: event.at,
        startedAt: ledger.startedAt ?? event.at,
      }

    case 'form_fault':
      return { ...ledger, faults: withFault(ledger.faults, event.fault) }

    case 'out_of_frame':
      // Its own event kind, but it IS a FaultType and the verdict route accepts it:
      // "you left the shot" is a true and useful thing for the coach to close on.
      return { ...ledger, faults: withFault(ledger.faults, 'out_of_frame') }

    case 'set_ended':
      return {
        ...ledger,
        // The engine's own totals win over ours: it counted them.
        reps: event.totalReps,
        cleanReps: event.cleanReps,
        faults: withFaults(ledger.faults, event.faults),
        endedAt: event.at,
      }

    // Nothing to record: these say something about the CAMERA, not about the set, and
    // `measuredReps` already carries their consequence rep by rep.
    case 'back_in_frame':
    case 'form_unobservable':
    case 'form_observable':
    case 'idle':
      return ledger
  }
}

/**
 * Seconds of set, measured on the event clock so it cannot disagree with the HUD.
 *
 * Prefers the engine's own `set_ended` stamp, falls back to the last rep, and only
 * then to the caller's clock — a set that ended when the coach called log_set has no
 * `endedAt` yet, and pinning the duration to the last rep is more honest than
 * including however long the user then spent talking about it.
 */
export function ledgerElapsedSec(ledger: SetLedger, now: number): number {
  if (ledger.startedAt === null) return 0
  const end = ledger.endedAt ?? ledger.lastRepAt ?? now
  const seconds = (end - ledger.startedAt) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}
