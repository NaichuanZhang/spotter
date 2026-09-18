/**
 * The fault slab, plus the latch that keeps it readable.
 *
 * form_fault events arrive at pose framerate. Rendered raw, the chip would strobe
 * and the whole demo would read as broken no matter how good the coaching is. So
 * every transition goes through two pure functions — admitFault / expireFault —
 * that enforce: a minimum time on screen, a cooldown before the next chip, and
 * pre-emption only by a *more severe* fault.
 *
 * The chip is ALWAYS red. Persona hue never touches it: a fault is a fault, and
 * character does not get to recolour the truth.
 */
import { useEffect, useState } from 'react'
import type { FaultType, Severity } from '../types/events'
import { FAULT_LABEL } from '../types/events'

/** Latch timings. Recalibrate here, nowhere else. */
export const FAULT_LATCH = {
  /** Time a chip stays up once shown, even if the fault has cleared. */
  MIN_VISIBLE_MS: 2600,
  /** Dead time after a chip hides, so faults cannot machine-gun. */
  COOLDOWN_MS: 1200,
} as const

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { minor: 0, major: 1, severe: 2 }

export interface FaultCandidate {
  readonly fault: FaultType
  readonly severity: Severity
  /** Event timestamp. Also serves as the identity of this candidate. */
  readonly at: number
  readonly valueDeg?: number
}

export interface LatchState {
  readonly shown: FaultCandidate | null
  /** When `shown` went up. 0 when nothing is shown. */
  readonly shownAt: number
  /** No new chip before this timestamp. */
  readonly hiddenUntil: number
}

export const EMPTY_LATCH: LatchState = { shown: null, shownAt: 0, hiddenUntil: 0 }

/**
 * Fold a candidate into the latch. Returns the SAME object when the candidate is
 * rejected — callers rely on reference equality to avoid re-render loops.
 */
export function admitFault(state: LatchState, candidate: FaultCandidate, now: number): LatchState {
  const current = state.shown
  if (!current) {
    if (now < state.hiddenUntil) return state
    return { shown: candidate, shownAt: now, hiddenUntil: 0 }
  }

  // Same fault again: upgrade severity in place but never extend the clock, so
  // the chip always turns over instead of pinning forever.
  if (current.fault === candidate.fault) {
    if (SEVERITY_RANK[candidate.severity] <= SEVERITY_RANK[current.severity]) return state
    const upgraded: FaultCandidate = {
      ...current,
      severity: candidate.severity,
      valueDeg: candidate.valueDeg ?? current.valueDeg,
    }
    return { ...state, shown: upgraded }
  }

  const moreSevere = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[current.severity]
  const servedMinimum = now - state.shownAt >= FAULT_LATCH.MIN_VISIBLE_MS
  if (!moreSevere && !servedMinimum) return state
  return { shown: candidate, shownAt: now, hiddenUntil: 0 }
}

/** Retire the current chip once it has served its minimum, and open the cooldown. */
export function expireFault(state: LatchState, now: number): LatchState {
  if (!state.shown) return state
  if (now - state.shownAt < FAULT_LATCH.MIN_VISIBLE_MS) return state
  return { shown: null, shownAt: 0, hiddenUntil: now + FAULT_LATCH.COOLDOWN_MS }
}

/**
 * Turns a stream of raw fault candidates into at most one readable chip.
 * Pass a NEW object per event (App does); passing the same reference twice is
 * harmless because admitFault is idempotent for an unchanged fault.
 */
export function useFaultLatch(candidate: FaultCandidate | null): FaultCandidate | null {
  const [state, setState] = useState<LatchState>(EMPTY_LATCH)

  useEffect(() => {
    if (!candidate) return
    setState((previous) => admitFault(previous, candidate, Date.now()))
  }, [candidate])

  useEffect(() => {
    if (!state.shown) return undefined
    const delay = Math.max(0, state.shownAt + FAULT_LATCH.MIN_VISIBLE_MS - Date.now())
    const timer = window.setTimeout(() => {
      setState((previous) => expireFault(previous, Date.now()))
    }, delay)
    return () => window.clearTimeout(timer)
  }, [state])

  return state.shown
}

interface FaultChipProps {
  /** Already latched — this component is presentational on purpose. */
  readonly latched: FaultCandidate | null
}

export default function FaultChip({ latched }: FaultChipProps) {
  if (!latched) return null
  const degrees = latched.valueDeg === undefined ? null : `${Math.round(Math.abs(latched.valueDeg))}°`

  return (
    <div className="fault" role="alert" data-severity={latched.severity}>
      <span className="fault__label">{FAULT_LABEL[latched.fault]}</span>
      <span className="fault__meta">
        {degrees ? <span className="fault__value">{degrees}</span> : null}
        <span className="fault__severity">{latched.severity}</span>
      </span>
    </div>
  )
}
