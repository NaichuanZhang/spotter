/**
 * The double-fire guard.
 *
 * Every real route to the end of a set ALSO produces `set_ended` a moment later
 * (reaching the target stops the engine; the coach's log_set stops the engine), so the
 * latch is the only thing standing between one ending and two or three. The identity
 * contract is the load-bearing part: App decides "did this call win?" by comparing
 * references, so a latch that returned a fresh equal object would let every route in.
 */
import { describe, expect, it } from 'vitest'
import { FINISH_LABEL, isLatched, latchFinish, OPEN_LATCH } from '../finishGate'
import type { FinishReason } from '../finishGate'

const REASONS: readonly FinishReason[] = ['target_reached', 'coach_logged_set', 'set_ended']

describe('finishGate', () => {
  it('starts open', () => {
    expect(OPEN_LATCH.reason).toBeNull()
    expect(isLatched(OPEN_LATCH)).toBe(false)
  })

  it('closes on the first reason and reports it', () => {
    const closed = latchFinish(OPEN_LATCH, 'target_reached')
    expect(closed).not.toBe(OPEN_LATCH)
    expect(closed.reason).toBe('target_reached')
    expect(isLatched(closed)).toBe(true)
  })

  it('returns the IDENTICAL object on a second call, which is how a double fire is detected', () => {
    const first = latchFinish(OPEN_LATCH, 'target_reached')
    const second = latchFinish(first, 'set_ended')
    expect(second).toBe(first)
    expect(second.reason).toBe('target_reached')
  })

  it('never lets a later route overwrite the winning reason', () => {
    for (const winner of REASONS) {
      let latch = latchFinish(OPEN_LATCH, winner)
      for (const loser of REASONS) latch = latchFinish(latch, loser)
      expect(latch.reason).toBe(winner)
    }
  })

  it('does not mutate the latch it is handed', () => {
    const before = latchFinish(OPEN_LATCH, 'coach_logged_set')
    latchFinish(before, 'target_reached')
    expect(before.reason).toBe('coach_logged_set')
    expect(OPEN_LATCH.reason).toBeNull()
  })

  it('has a screen label for every reason', () => {
    for (const reason of REASONS) {
      expect(FINISH_LABEL[reason]).toMatch(/^[A-Z ]+$/)
    }
    expect(Object.keys(FINISH_LABEL)).toHaveLength(REASONS.length)
  })
})
