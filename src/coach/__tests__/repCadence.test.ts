/**
 * THE COMPLAINT, REPRODUCED AT THE SESSION LEVEL — is the policy's state actually THREADED?
 *
 * `speechPolicy.test.ts` pins the pure reducers. Every one of those cases can pass while
 * `session.ts` drops the state `decideSpeech` returns, and a policy whose state is dropped
 * between events is exactly as eager as no policy at all. That is the regression this file
 * exists for: delete `policy = decision.state` from `session.ts` and the reducer suite stays
 * green while every case below fails.
 *
 * The harness itself lives in `setReplay.ts`, shared with `speechBudget.test.ts` (which owns
 * the four-number measurement and the real-clip workload) and `speechInteractions.test.ts`
 * (which owns barge-in meeting the listen window). One harness, because the fake audio drain
 * is the load-bearing part of all three and two copies of it would drift.
 */
import { describe, expect, it } from 'vitest'
import {
  faultEvent,
  overrunMs,
  pctOpen,
  pctSpeaking,
  REP_INTERVAL_MS,
  replay,
  SET_REPS,
  simulatedSet,
  utterancesPerMin,
} from './setReplay'
import { SPEECH_TUNING } from '../speechTuning'

const endMs = SET_REPS * REP_INTERVAL_MS

describe('a 20-rep set at 2.5s per rep, through the real session', () => {
  it('BEFORE: pushing every rep makes the coach speak for essentially the whole set', async () => {
    const result = await replay({ events: simulatedSet(), endMs, throttled: false })
    expect(result.utterances).toBe(SET_REPS)
    // 20 utterances of 5.55s is 111s of audio demanded by a 50s set, so the queue can only
    // grow: `audioOut.isSpeaking()` never goes false and the mic gate —
    // `() => !audio.isSpeaking()` — is shut for the whole set and then some.
    expect(pctSpeaking(result)).toBeGreaterThan(95)
    // THE SHAPE OF THE BUG, and the part a rate alone hides: the coach is still working
    // through the backlog long after the user has stopped doing pushups.
    expect(overrunMs(result)).toBeGreaterThan(30_000)
  })

  it('AFTER: the policy speaks a handful of times and opens the mic gate for most of the set', async () => {
    const result = await replay({ events: simulatedSet(), endMs, throttled: true })
    expect(result.utterances).toBeLessThanOrEqual(6)
    expect(result.utterances).toBeGreaterThanOrEqual(2)
    // No overrun at all: the set ends when the reps end, so nothing is said late.
    expect(overrunMs(result)).toBe(0)
    // The number that answers the user's question. Measured 57.9% speaking at the shipped
    // tuning, i.e. 42% of the set is silence the half-duplex mic gate is open through, against
    // 0% before. Asserted as a loose ceiling because the exact value moves with SPEECH_TUNING
    // by design — see the sweep table in speechTuning.ts.
    expect(pctSpeaking(result)).toBeLessThan(65)
  })

  it('threads the policy state — dropping it would push all 20 again', async () => {
    // The regression this file exists for. A `policy = decision.state` deleted from
    // session.ts leaves every reducer test passing and this one failing.
    const result = await replay({ events: simulatedSet(), endMs, throttled: true })
    expect(result.utterances).toBeLessThan(SET_REPS)
  })

  it('still lets a severe fault through mid-set, at the cost of one extra utterance', async () => {
    const quiet = await replay({ events: simulatedSet(), endMs, throttled: true })
    const withSevere = await replay({
      // Rep 7 is inside a cadence gap, so the rep itself is silent and the fault is the
      // only thing that can speak.
      events: simulatedSet(SET_REPS, (n, at) => (n === 7 ? faultEvent('severe', at) : null)),
      endMs,
      throttled: true,
    })
    expect(withSevere.utterances).toBeGreaterThan(quiet.utterances)
  })

  it('does NOT let a stream of minor faults undo the quiet', async () => {
    const result = await replay({
      events: simulatedSet(SET_REPS, (_n, at) => faultEvent('minor', at)),
      endMs,
      throttled: true,
    })
    // A minor fault on every single rep is the worst case for a policy that only throttles
    // reps. The shared bucket has to absorb it, because faults and reps go through ONE gate.
    expect(result.utterances).toBeLessThanOrEqual(SET_REPS / 2)
  })

  it('reports the measurement, so a tuning change by ear can be re-measured cheaply', async () => {
    const before = await replay({ events: simulatedSet(), endMs, throttled: false })
    const after = await replay({ events: simulatedSet(), endMs, throttled: true })
    /**
     * Normalised to the EXERCISING WINDOW, not to each arm's own wall clock. Dividing by the
     * latter silently flatters the before arm: its 20 utterances drain over 111s rather than
     * 47.5s, so the per-minute figure comes out far lower and the reduction looks like 1.8x
     * instead of 4x. The set is the same length in both arms; that is the honest denominator,
     * and `setReplay` uses it for every percentage.
     */
    // Pinned as a ratio rather than absolute numbers: the absolute values move with
    // SPEECH_TUNING (which is the point of a tuning surface), the ORDER OF MAGNITUDE of the
    // reduction is the claim. Measured 25.3/min before vs 6.3/min after.
    expect(utterancesPerMin(before) / utterancesPerMin(after)).toBeGreaterThan(3)
    // And the share of the set the mic gate is OPEN, which is what the user asked for.
    expect(pctOpen(before)).toBeLessThan(5)
    expect(pctOpen(after)).toBeGreaterThan(35)
    expect(SPEECH_TUNING.repCadence).toBeGreaterThan(1)
  })
})
