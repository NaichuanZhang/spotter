/**
 * The set ledger — the only record of what happened across a whole set.
 *
 * The case these tests exist for is the honesty pair: `cleanReps` and `measuredReps`
 * must move INDEPENDENTLY, because `clean` means "no fault detected" and a rep whose
 * feet were out of shot is clean-but-unjudged. A ledger that conflated them would make
 * "18 of 20 clean" unfalsifiable, which is the exact failure the amendment log in
 * src/types/events.ts was written about.
 */
import { describe, expect, it } from 'vitest'
import type { CoachEvent, FaultType, RepMetrics } from '../../types/events'
import { EMPTY_LEDGER, foldSetEvent, ledgerElapsedSec } from '../setLedger'
import type { SetLedger } from '../setLedger'

function rep(overrides: Partial<RepMetrics> = {}): RepMetrics {
  return {
    index: 1,
    minElbowAngle: 84,
    maxElbowAngle: 176,
    depthPct: 70,
    hipDeviationDeg: 4,
    descentMs: 800,
    ascentMs: 650,
    partial: false,
    clean: true,
    ...overrides,
  }
}

function repEvent(
  totalReps: number,
  cleanReps: number,
  metrics: Partial<RepMetrics> = {},
  at = 1000 * totalReps,
): CoachEvent {
  return { kind: 'rep_completed', at, rep: rep({ index: totalReps, ...metrics }), totalReps, cleanReps }
}

function fold(events: readonly CoachEvent[], from: SetLedger = EMPTY_LEDGER): SetLedger {
  return events.reduce(foldSetEvent, from)
}

describe('setLedger', () => {
  it('is empty before anything happens', () => {
    expect(EMPTY_LEDGER.reps).toBe(0)
    expect(EMPTY_LEDGER.measuredReps).toBe(0)
    expect(EMPTY_LEDGER.worstHipDeviationDeg).toBeNull()
    expect(EMPTY_LEDGER.faults).toEqual([])
  })

  it('takes the rep totals from the event rather than counting them itself', () => {
    const ledger = fold([{ kind: 'set_started', at: 0, target: 20 }, repEvent(1, 1), repEvent(2, 1)])
    expect(ledger.reps).toBe(2)
    expect(ledger.cleanReps).toBe(1)
  })

  it('counts partials and keeps the deepest rep of the set', () => {
    const ledger = fold([
      repEvent(1, 1, { depthPct: 62 }),
      repEvent(2, 1, { depthPct: 91 }),
      repEvent(3, 1, { depthPct: 40, partial: true }),
    ])
    expect(ledger.partialReps).toBe(1)
    expect(ledger.bestDepthPct).toBe(91)
  })

  it('counts measured reps separately from clean reps — the honesty pair', () => {
    const ledger = fold([
      repEvent(1, 1, { hipDeviationDeg: null }),
      repEvent(2, 2, { hipDeviationDeg: null }),
      repEvent(3, 3, { hipDeviationDeg: 6 }),
    ])
    expect(ledger.cleanReps).toBe(3)
    expect(ledger.measuredReps).toBe(1)
  })

  it('never lets an unmeasured rep collapse the worst deviation to zero', () => {
    const ledger = fold([repEvent(1, 1, { hipDeviationDeg: 14 }), repEvent(2, 2, { hipDeviationDeg: null })])
    expect(ledger.worstHipDeviationDeg).toBe(14)
  })

  it('keeps the SIGN of the largest-magnitude deviation, so a pike stays a pike', () => {
    const piked = fold([repEvent(1, 1, { hipDeviationDeg: 8 }), repEvent(2, 2, { hipDeviationDeg: -19 })])
    expect(piked.worstHipDeviationDeg).toBe(-19)
    const sagged = fold([repEvent(1, 1, { hipDeviationDeg: -9 }), repEvent(2, 2, { hipDeviationDeg: 21 })])
    expect(sagged.worstHipDeviationDeg).toBe(21)
  })

  it('records faults once, in the order they first fired', () => {
    const ledger = fold([
      { kind: 'form_fault', at: 10, fault: 'no_lockout', severity: 'major', heldFrames: 4 },
      { kind: 'form_fault', at: 20, fault: 'sagging_hips', severity: 'severe', heldFrames: 6 },
      { kind: 'form_fault', at: 30, fault: 'no_lockout', severity: 'minor', heldFrames: 3 },
    ])
    expect(ledger.faults).toEqual<FaultType[]>(['no_lockout', 'sagging_hips'])
  })

  it('records leaving the shot as a fault of its own', () => {
    const ledger = fold([{ kind: 'out_of_frame', at: 40, missing: ['left_ankle'] }])
    expect(ledger.faults).toEqual<FaultType[]>(['out_of_frame'])
  })

  it('merges the engine wrap-up: its totals win and its fault list is unioned in', () => {
    const ledger = fold([
      repEvent(1, 1),
      { kind: 'form_fault', at: 15, fault: 'craned_neck', severity: 'minor', heldFrames: 3 },
      { kind: 'set_ended', at: 5000, totalReps: 6, cleanReps: 4, faults: ['craned_neck', 'piked_hips'] },
    ])
    expect(ledger.reps).toBe(6)
    expect(ledger.cleanReps).toBe(4)
    expect(ledger.faults).toEqual<FaultType[]>(['craned_neck', 'piked_hips'])
    expect(ledger.endedAt).toBe(5000)
  })

  it('starts a NEW set from zero — the go-again case', () => {
    const dirty = fold([
      repEvent(1, 1, { partial: true }),
      { kind: 'out_of_frame', at: 40, missing: ['left_ankle'] },
      { kind: 'set_ended', at: 900, totalReps: 1, cleanReps: 1, faults: ['no_lockout'] },
    ])
    const second = foldSetEvent(dirty, { kind: 'set_started', at: 9000, target: 20 })
    expect(second).toMatchObject({ reps: 0, cleanReps: 0, partialReps: 0, bestDepthPct: 0, faults: [], endedAt: null })
    expect(second.startedAt).toBe(9000)
  })

  it('ignores the camera-only events', () => {
    const before = fold([repEvent(1, 1)])
    const after = fold(
      [
        { kind: 'form_unobservable', at: 50, missing: ['left_ankle'], sinceMs: 470 },
        { kind: 'form_observable', at: 90 },
        { kind: 'back_in_frame', at: 95 },
        { kind: 'idle', at: 99, sinceMs: 4000 },
      ],
      before,
    )
    expect(after).toBe(before)
  })

  it('never mutates the ledger it is handed', () => {
    const before = fold([repEvent(1, 1)])
    const snapshot = JSON.stringify(before)
    foldSetEvent(before, repEvent(2, 2, { partial: true, hipDeviationDeg: null }))
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  describe('ledgerElapsedSec', () => {
    it('is zero before a set starts', () => {
      expect(ledgerElapsedSec(EMPTY_LEDGER, 5000)).toBe(0)
    })

    it('prefers the engine wrap-up stamp', () => {
      const ledger = fold([
        { kind: 'set_started', at: 1000, target: 20 },
        repEvent(1, 1, {}, 3000),
        { kind: 'set_ended', at: 89_000, totalReps: 1, cleanReps: 1, faults: [] },
      ])
      expect(ledgerElapsedSec(ledger, 999_999)).toBe(88)
    })

    it('falls back to the last rep, not to the caller clock — talking is not working', () => {
      const ledger = fold([{ kind: 'set_started', at: 1000, target: 20 }, repEvent(1, 1, {}, 45_000)])
      expect(ledgerElapsedSec(ledger, 600_000)).toBe(44)
    })

    it('uses the caller clock only when no rep ever landed', () => {
      const ledger = fold([{ kind: 'set_started', at: 1000, target: 20 }])
      expect(ledgerElapsedSec(ledger, 11_000)).toBe(10)
    })
  })
})
