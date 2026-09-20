/**
 * The ledger, turned into the numbers the ending screen shows and the one line the
 * live coach is told.
 *
 * THIS MODULE OWNS THE HONESTY. Everything the ending screen claims about the user's
 * form is decided here, once, so the screen copy and the spoken line cannot disagree
 * — and so both can be tested without a browser.
 *
 * The rule, from the amendment log in src/types/events.ts: `clean` means NO FAULT WAS
 * DETECTED. When the hip or the ankle was off camera, `hipDeviationDeg` is null and
 * the body line was never judged at all, so "18 of 20 clean" over such a set reads as
 * verified good form and is a lie by omission. `coverage` is the flag that stops it:
 *
 *   'seen'    — every rep's body line was measurable. The screen may say so.
 *   'partial' — some were. The screen says how many, and does not extrapolate.
 *   'unseen'  — none were (or no rep landed). The screen says the back was never
 *               judged, in words, right next to the clean count.
 *
 * `verdictRequestFrom` (verdictClient.ts) then sends `bodyLineSeen` only for 'seen',
 * which is deliberately the conservative reading — a set where one rep's feet drifted
 * out of shot buys the coach no licence to praise the line.
 */
import { EVENT_LINE } from '../types/events'
import type { FaultType } from '../types/events'
import type { FinishReason } from './finishGate'
import { ledgerElapsedSec } from './setLedger'
import type { SetLedger } from './setLedger'

/**
 * Mirrors `VERDICT_LIMITS` in server/verdictText.mjs, which answers 400 outside these
 * bounds. Clamping here keeps a demo-floor absurdity (a leaned-on F key) from turning
 * the avatar verdict into an error — and if the two ever drift, the failure is a 400
 * that the ending screen already survives with its words intact.
 */
export const SUMMARY_LIMITS = {
  maxReps: 300,
  maxElapsedSec: 7200,
} as const

/**
 * Faults that are a claim ABOUT THE BACK, and therefore unsayable when the body line
 * was never measured. Mirrors `BACK_FAULTS` in server/verdictText.mjs by hand;
 * `scripts/verdict-cli.mjs check-sources` does NOT check this file, so a new
 * hip-derived FaultType has to be added in both places.
 */
export const HIP_CLAIM_FAULTS: readonly FaultType[] = Object.freeze(['sagging_hips', 'piked_hips'])

export type BodyLineCoverage = 'unseen' | 'partial' | 'seen'

export interface SetSummary {
  readonly reason: FinishReason
  readonly target: number
  readonly reps: number
  /** Reps with no fault DETECTED. Read it together with `coverage`, never alone. */
  readonly cleanReps: number
  readonly partialReps: number
  readonly elapsedSec: number
  readonly bestDepthPct: number
  readonly faults: readonly FaultType[]
  readonly coverage: BodyLineCoverage
  readonly measuredReps: number
  readonly worstHipDeviationDeg: number | null
}

export interface SummariseInput {
  readonly ledger: SetLedger
  readonly target: number
  readonly reason: FinishReason
  /** Same monotonic clock the events carry. Only used if the set never ended. */
  readonly now: number
}

export function coverageOf(ledger: SetLedger): BodyLineCoverage {
  if (ledger.reps <= 0 || ledger.measuredReps <= 0) return 'unseen'
  return ledger.measuredReps >= ledger.reps ? 'seen' : 'partial'
}

function clampInt(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.round(value), max)
}

export function summariseSet(input: SummariseInput): SetSummary {
  const { ledger } = input
  const reps = clampInt(ledger.reps, SUMMARY_LIMITS.maxReps)
  return {
    reason: input.reason,
    target: clampInt(input.target, SUMMARY_LIMITS.maxReps),
    reps,
    cleanReps: Math.min(clampInt(ledger.cleanReps, SUMMARY_LIMITS.maxReps), reps),
    partialReps: Math.min(clampInt(ledger.partialReps, SUMMARY_LIMITS.maxReps), reps),
    elapsedSec: Math.min(
      Math.max(0, Number.isFinite(ledger.startedAt ?? 0) ? ledgerElapsedSec(ledger, input.now) : 0),
      SUMMARY_LIMITS.maxElapsedSec,
    ),
    bestDepthPct: Math.min(clampInt(ledger.bestDepthPct, 100), 100),
    faults: ledger.faults,
    coverage: coverageOf(ledger),
    measuredReps: Math.min(clampInt(ledger.measuredReps, SUMMARY_LIMITS.maxReps), reps),
    worstHipDeviationDeg: ledger.worstHipDeviationDeg,
  }
}

/** m:ss. Matches the HUD's clock so the two screens agree on a duration. */
export function formatClock(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.round(totalSeconds) : 0
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export interface BodyLineNote {
  readonly coverage: BodyLineCoverage
  /** Short caps label for the note's own line. */
  readonly label: string
  readonly detail: string
}

/**
 * The sentence that keeps the clean count honest. Never omitted, never softened: it
 * is the difference between a report and a claim.
 */
export function bodyLineNote(summary: SetSummary): BodyLineNote {
  if (summary.reps === 0) {
    return {
      coverage: 'unseen',
      label: 'NOTHING MEASURED',
      detail: 'No rep completed, so there is nothing here to judge.',
    }
  }
  if (summary.coverage === 'unseen') {
    return {
      coverage: 'unseen',
      label: 'NO FORM CLAIM',
      detail:
        `Your hips and feet were never both in shot, so your body line was never judged. ` +
        `${summary.cleanReps} clean means nothing was detected — not that your back was straight.`,
    }
  }
  if (summary.coverage === 'partial') {
    return {
      coverage: 'partial',
      label: 'PART-MEASURED',
      detail:
        `Your body line was only measurable on ${summary.measuredReps} of ${summary.reps} reps. ` +
        `The other ${summary.reps - summary.measuredReps} are unjudged, not approved.`,
    }
  }
  return {
    coverage: 'seen',
    label: 'LINE MEASURED',
    detail: `Your body line was measurable on all ${summary.reps} reps${describeDeviation(summary)}.`,
  }
}

/** Only ever called with a measured deviation in hand. */
function describeDeviation(summary: SetSummary): string {
  const worst = summary.worstHipDeviationDeg
  if (worst === null) return ''
  const magnitude = Math.round(Math.abs(worst))
  if (magnitude < EVENT_LINE.hipClaimMinDeg) return ', and it held inside measurement noise'
  return `, worst ${worst > 0 ? 'sag' : 'pike'} ${magnitude} degrees`
}

/**
 * Faults the coach may speak about. A hip fault cannot be stated over an unseen body
 * line — the engine cannot produce that pair, but filtering costs nothing and means a
 * future source of faults cannot smuggle a claim about a back nobody saw.
 */
export function speakableFaults(summary: SetSummary): readonly FaultType[] {
  if (summary.coverage !== 'unseen') return summary.faults
  return summary.faults.filter((fault) => !HIP_CLAIM_FAULTS.includes(fault))
}

/**
 * STAGE 1, the instant spoken line — the whole set as one `[EVENT]` reading.
 *
 * `[EVENT]`-prefixed because that is the contract CORE teaches in coach/personas.ts:
 * machine measurement, never read aloud, never quoted as wording. It carries a
 * closing DIRECTIVE for the same reason `form_unobservable` carries one ("tell the
 * user to back up") — without it the model answers a whole-set reading with a
 * mid-set bark.
 *
 * NO TTS TAG EVER. This goes out on the Realtime wire, where `<|style:...|>` does
 * nothing on a good day and gets read aloud on a bad one.
 */
export function closingLine(summary: SetSummary): string {
  const bits = [
    `set complete — ${summary.reason.replace(/_/g, ' ')}`,
    `${summary.reps} of ${summary.target} reps`,
    `${summary.cleanReps} clean (no fault detected)`,
  ]
  if (summary.partialReps > 0) bits.push(`${summary.partialReps} partial`)
  bits.push(`${Math.round(summary.elapsedSec)}s total`)
  if (summary.reps > 0) bits.push(`best depth ${summary.bestDepthPct}%`)
  const faults = speakableFaults(summary)
  bits.push(faults.length > 0 ? `faults seen: ${faults.join(', ')}` : 'no faults')
  bits.push(bodyLineClause(summary))
  return `[EVENT] ${bits.join(' | ')} — the set is over; say one closing line about the whole set`
}

/** The frozen contract's own words for the unseen case, so the wire stays single-sourced. */
function bodyLineClause(summary: SetSummary): string {
  if (summary.coverage === 'unseen') return EVENT_LINE.bodyLineUnseen
  if (summary.coverage === 'partial') {
    return (
      `body line measurable on only ${summary.measuredReps} of ${summary.reps} reps — ` +
      'no hip judgement on the rest'
    )
  }
  const worst = summary.worstHipDeviationDeg
  if (worst !== null && Math.abs(worst) >= EVENT_LINE.hipClaimMinDeg) {
    return `worst ${worst > 0 ? 'hip_sag' : 'hip_pike'} ${Math.round(Math.abs(worst))}deg`
  }
  return 'body line held straight on every rep'
}
