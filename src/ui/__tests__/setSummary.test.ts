/**
 * The words, and the one line the live coach is told.
 *
 * THE POINT OF THIS FILE IS THE UNSEEN BODY LINE. A set filmed with the feet out of
 * shot produces clean reps that were never judged, and both the screen copy and the
 * spoken line have to say so — in words, next to the count, never by omission. Every
 * coverage case is asserted, including the one that is easy to get wrong: zero reps,
 * where there is nothing to judge at all.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_LINE } from '../../types/events'
import type { FaultType } from '../../types/events'
import { EMPTY_LEDGER } from '../setLedger'
import type { SetLedger } from '../setLedger'
import {
  bodyLineNote,
  closingLine,
  coverageOf,
  formatClock,
  speakableFaults,
  summariseSet,
  SUMMARY_LIMITS,
} from '../setSummary'
import type { SetSummary } from '../setSummary'

function ledger(overrides: Partial<SetLedger> = {}): SetLedger {
  return {
    ...EMPTY_LEDGER,
    reps: 20,
    cleanReps: 18,
    partialReps: 2,
    bestDepthPct: 96,
    measuredReps: 20,
    worstHipDeviationDeg: 6,
    faults: ['no_lockout'],
    startedAt: 1000,
    lastRepAt: 89_000,
    endedAt: 89_000,
    ...overrides,
  }
}

function summarise(overrides: Partial<SetLedger> = {}, peakBpm = 148): SetSummary {
  return summariseSet({ ledger: ledger(overrides), target: 20, peakBpm, reason: 'target_reached', now: 90_000 })
}

describe('coverageOf', () => {
  it('is seen only when every rep was measurable', () => {
    expect(coverageOf(ledger({ reps: 20, measuredReps: 20 }))).toBe('seen')
  })

  it('is partial when some reps were measurable', () => {
    expect(coverageOf(ledger({ reps: 20, measuredReps: 6 }))).toBe('partial')
  })

  it('is unseen when none were', () => {
    expect(coverageOf(ledger({ reps: 20, measuredReps: 0 }))).toBe('unseen')
  })

  it('is unseen when no rep landed — nothing was measured, so nothing is claimed', () => {
    expect(coverageOf(ledger({ reps: 0, cleanReps: 0, measuredReps: 0 }))).toBe('unseen')
  })
})

describe('summariseSet', () => {
  it('carries the measured numbers through', () => {
    const summary = summarise()
    expect(summary).toMatchObject({
      reps: 20,
      cleanReps: 18,
      partialReps: 2,
      bestDepthPct: 96,
      peakBpm: 148,
      coverage: 'seen',
      reason: 'target_reached',
    })
    expect(summary.elapsedSec).toBe(88)
  })

  it('never reports more clean or partial reps than reps — the route rejects that', () => {
    const summary = summarise({ reps: 3, cleanReps: 9, partialReps: 7 })
    expect(summary.cleanReps).toBe(3)
    expect(summary.partialReps).toBe(3)
  })

  it('clamps an absurd set to the limits the verdict route accepts', () => {
    const summary = summarise({ reps: 5000, cleanReps: 5000, bestDepthPct: 460, startedAt: 0, endedAt: 99_000_000 })
    expect(summary.reps).toBe(SUMMARY_LIMITS.maxReps)
    expect(summary.bestDepthPct).toBe(100)
    expect(summary.elapsedSec).toBe(SUMMARY_LIMITS.maxElapsedSec)
  })

  it('survives a set that never started', () => {
    const summary = summariseSet({ ledger: EMPTY_LEDGER, target: 20, peakBpm: 0, reason: 'set_ended', now: 5000 })
    expect(summary).toMatchObject({ reps: 0, elapsedSec: 0, peakBpm: 0, coverage: 'unseen' })
  })
})

describe('bodyLineNote', () => {
  it('says the clean count is NOT a verdict on the back when the line was never seen', () => {
    const note = bodyLineNote(summarise({ measuredReps: 0 }))
    expect(note.coverage).toBe('unseen')
    expect(note.label).toBe('NO FORM CLAIM')
    expect(note.detail).toContain('never')
    expect(note.detail).toContain('18 clean means nothing was detected')
    expect(note.detail).toContain('not that your back was straight')
  })

  it('states how many reps were measurable when only some were, and does not extrapolate', () => {
    const note = bodyLineNote(summarise({ measuredReps: 6 }))
    expect(note.coverage).toBe('partial')
    expect(note.detail).toContain('6 of 20 reps')
    expect(note.detail).toContain('14 are unjudged, not approved')
  })

  it('may say the line was measured when every rep was, and quotes the worst deviation', () => {
    const note = bodyLineNote(summarise({ worstHipDeviationDeg: 17 }))
    expect(note.coverage).toBe('seen')
    expect(note.detail).toContain('all 20 reps')
    expect(note.detail).toContain('worst sag 17 degrees')
  })

  it('calls a pike a pike', () => {
    expect(bodyLineNote(summarise({ worstHipDeviationDeg: -22 })).detail).toContain('worst pike 22 degrees')
  })

  it('does not quote a deviation inside measurement noise', () => {
    const note = bodyLineNote(summarise({ worstHipDeviationDeg: EVENT_LINE.hipClaimMinDeg - 1 }))
    expect(note.detail).toContain('measurement noise')
    expect(note.detail).not.toMatch(/\d+ degrees/)
  })

  it('claims nothing at all when no rep landed', () => {
    const note = bodyLineNote(summarise({ reps: 0, cleanReps: 0, partialReps: 0, measuredReps: 0 }))
    expect(note.label).toBe('NOTHING MEASURED')
    expect(note.detail).toContain('nothing here to judge')
  })
})

describe('speakableFaults', () => {
  it('drops a hip claim when the body line was never measured', () => {
    const faults: FaultType[] = ['sagging_hips', 'no_lockout', 'piked_hips']
    expect(speakableFaults(summarise({ faults, measuredReps: 0 }))).toEqual(['no_lockout'])
  })

  it('keeps every fault once the line was measured', () => {
    const faults: FaultType[] = ['sagging_hips', 'no_lockout']
    expect(speakableFaults(summarise({ faults }))).toEqual(faults)
  })
})

describe('closingLine', () => {
  it('is an [EVENT] reading carrying the real numbers and a closing directive', () => {
    const line = closingLine(summarise())
    expect(line.startsWith('[EVENT] ')).toBe(true)
    expect(line).toContain('20 of 20 reps')
    expect(line).toContain('18 clean (no fault detected)')
    expect(line).toContain('2 partial')
    expect(line).toContain('88s total')
    expect(line).toContain('best depth 96%')
    expect(line).toContain('the set is over; say one closing line about the whole set')
  })

  it('never carries a TTS tag — this goes out on the Realtime wire', () => {
    for (const measuredReps of [0, 6, 20]) {
      expect(closingLine(summarise({ measuredReps }))).not.toContain('<|')
    }
  })

  it('labels the simulated heart rate estimated, and omits it when there is no reading', () => {
    expect(closingLine(summarise({}, 148))).toContain('peak heart rate 148 bpm estimated')
    expect(closingLine(summarise({}, 0))).not.toContain('heart rate')
  })

  it('uses the frozen contract wording for an unseen body line', () => {
    const line = closingLine(summarise({ measuredReps: 0 }))
    expect(line).toContain(EVENT_LINE.bodyLineUnseen)
  })

  it('states the partial coverage rather than rounding it up to a judgement', () => {
    expect(closingLine(summarise({ measuredReps: 6 }))).toContain(
      'body line measurable on only 6 of 20 reps — no hip judgement on the rest',
    )
  })

  it('cannot state a hip fault over a body line that was never seen', () => {
    const line = closingLine(summarise({ faults: ['sagging_hips', 'craned_neck'], measuredReps: 0 }))
    expect(line).toContain('faults seen: craned_neck')
    expect(line).not.toContain('sagging_hips')
  })

  it('quotes the worst deviation only when it was measured and big enough to claim', () => {
    expect(closingLine(summarise({ worstHipDeviationDeg: 21 }))).toContain('worst hip_sag 21deg')
    expect(closingLine(summarise({ worstHipDeviationDeg: -18 }))).toContain('worst hip_pike 18deg')
    expect(closingLine(summarise({ worstHipDeviationDeg: 2 }))).toContain('body line held straight on every rep')
  })

  it('says "no faults" rather than leaving the clause out', () => {
    expect(closingLine(summarise({ faults: [] }))).toContain('no faults')
  })

  it('names the route that ended the set', () => {
    const logged = summariseSet({ ledger: ledger(), target: 20, peakBpm: 0, reason: 'coach_logged_set', now: 0 })
    expect(closingLine(logged)).toContain('set complete — coach logged set')
  })
})

describe('formatClock', () => {
  it('matches the HUD clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9)).toBe('0:09')
    expect(formatClock(88)).toBe('1:28')
    expect(formatClock(600)).toBe('10:00')
  })

  it('refuses to render a nonsense duration', () => {
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(-5)).toBe('0:00')
  })
})
