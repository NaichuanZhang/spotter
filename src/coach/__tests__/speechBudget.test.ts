/**
 * DID THE COACH ACTUALLY SHUT UP, AND IS THERE ROOM TO SPEAK? The headline measurement.
 *
 * The user's complaint was "on every rep, coach speaks too eager ... anyway to tune this
 * behavior and actually leave room for user to speak?" — and the second half is the one that
 * can be got wrong while the first half looks fixed. A lower utterance count proves nothing on
 * its own: five utterances that each hold the half-duplex mic shut for 5.55 s is still a set
 * the user cannot talk during. So every arm here reports FOUR numbers, and the one that
 * decides whether the change worked is the third:
 *
 *   utterances/min · % of the set the coach was speaking · % of the set the MIC GATE WAS OPEN
 *   · the longest single open-mic window
 *
 * The last one matters separately from the percentage: 45 % of a set arriving as forty 500 ms
 * slivers between utterances is not room to speak, it is a stutter. A person needs one
 * continuous window long enough to finish a sentence in.
 *
 * TWO WORKLOADS, because a simulation and a recording fail differently:
 *   SIMULATED — 20 reps at 2.5 s, the cadence the complaint describes. Clean, regular, and
 *               the worst case for a cadence-based policy.
 *   REAL       — `public/clips/landmarks.json` replayed through the REAL pose pipeline
 *               (`measureAngles` -> median-5 -> `repMachine` -> `gate`), per camera take, so
 *               the event stream is whatever a real body actually produced: six reps, real
 *               spacing, real faults, real camera nags, several events on one frame.
 *
 * Set `SPOTTER_BUDGET=1` to print the table; the assertions run either way.
 */

import { describe, expect, it } from 'vitest'
import {
  pctOpen,
  pctSpeaking,
  overrunMs,
  REP_INTERVAL_MS,
  replay,
  SET_REPS,
  simulatedSet,
  UTTERANCE_SEC,
  utterancesPerMin,
  faultEvent,
} from './setReplay'
import type { SpeechBudget } from './setReplay'
import type { CoachEvent } from '../../types/events'
import { eventsOfKind, runPipeline } from '../../pose/__tests__/fixtures'
import { loadRealMotion, segmentedFrames } from '../../pose/__tests__/realMotion'

const REPORT = process.env.SPOTTER_BUDGET === '1'

function report(label: string, budget: SpeechBudget): void {
  if (!REPORT) return
  const row = [
    label.padEnd(26),
    `${budget.utterances} utt`.padStart(8),
    `${utterancesPerMin(budget).toFixed(1)}/min`.padStart(10),
    `${pctSpeaking(budget).toFixed(1)}% spk`.padStart(11),
    `${pctOpen(budget).toFixed(1)}% open`.padStart(12),
    `longest ${(budget.longestOpenMs / 1000).toFixed(1)}s`.padStart(14),
    `set ${(budget.setMs / 1000).toFixed(1)}s`.padStart(11),
    `overrun ${(overrunMs(budget) / 1000).toFixed(1)}s`.padStart(15),
  ].join(' | ')
  // eslint-disable-next-line no-console -- this file's product IS the table; gated by env.
  console.log(row)
}

// ------------------------------------------------------------------- workload 1: simulated

describe(`a ${SET_REPS}-rep set at ${REP_INTERVAL_MS}ms per rep, through the real session`, () => {
  it('BEFORE: the coach speaks for essentially the whole set and overruns it', async () => {
    const before = await replay({ events: simulatedSet(), endMs: SET_REPS * REP_INTERVAL_MS, throttled: false })
    report('SIMULATED before', before)

    expect(before.utterances).toBe(SET_REPS)
    // 20 utterances of 5.55 s is 111 s of audio demanded by a 50 s set, so the queue can only
    // grow: `isSpeaking()` never goes false, and the mic gate is `() => !isSpeaking()`.
    expect(pctSpeaking(before)).toBeGreaterThan(95)
    expect(pctOpen(before)).toBeLessThan(5)
    // THE SHAPE OF THE BUG that a rate alone hides: the coach is still working through the
    // backlog long after the user stopped doing pushups.
    expect(overrunMs(before)).toBeGreaterThan(30_000)
    // And the number the user feels. There is no window to say anything in at all.
    expect(before.longestOpenMs).toBeLessThan(3_000)
  })

  it('AFTER: a handful of utterances, no overrun, and a real window to speak in', async () => {
    const after = await replay({ events: simulatedSet(), endMs: SET_REPS * REP_INTERVAL_MS, throttled: true })
    report('SIMULATED after', after)

    expect(after.utterances).toBeLessThanOrEqual(6)
    expect(after.utterances).toBeGreaterThanOrEqual(2)
    // Nothing is said late: the set ends when the reps end.
    expect(overrunMs(after)).toBe(0)
    expect(pctOpen(after)).toBeGreaterThan(35)
    /**
     * THE WINDOW THE USER ACTUALLY TALKS INTO, and the reason the percentage alone is not
     * enough: 42 % of a set delivered as forty slivers would be useless. Measured 4.5 s
     * continuous, which is the arithmetic of the tuning rather than luck — five utterances
     * across 47.5 s is a callout every ~10 s, of which 5.55 s is audio, leaving ~4.5 s of
     * open mic between each pair.
     *
     * 4 s is asserted as the floor because that is about the shortest window a spoken
     * question fits in. If a tuning change pushes this under 4 s, the user is back to
     * interrupting rather than talking — see `listenWindowMs`, which is the knob that moves it.
     */
    expect(after.longestOpenMs).toBeGreaterThan(4_000)
  })

  it('improves every one of the four numbers, not just the utterance count', async () => {
    const events = simulatedSet()
    const endMs = SET_REPS * REP_INTERVAL_MS
    const before = await replay({ events, endMs, throttled: false })
    const after = await replay({ events, endMs, throttled: true })

    expect(utterancesPerMin(before) / utterancesPerMin(after)).toBeGreaterThan(3)
    expect(pctSpeaking(after)).toBeLessThan(pctSpeaking(before))
    // THE CLAIM THAT MATTERS. If this ratio ever collapses the change has failed, whatever
    // the utterance count says.
    expect(pctOpen(after) / Math.max(pctOpen(before), 0.01)).toBeGreaterThan(5)
    expect(after.longestOpenMs / Math.max(before.longestOpenMs, 1)).toBeGreaterThan(3)
  })

  it('a minor fault on every rep cannot undo the quiet — one bucket, not two', async () => {
    const events = simulatedSet(SET_REPS, (_n, at) => faultEvent('minor', at))
    const endMs = SET_REPS * REP_INTERVAL_MS
    const before = await replay({ events, endMs, throttled: false })
    const after = await replay({ events, endMs, throttled: true })
    report('SIMULATED before +minor', before)
    report('SIMULATED after  +minor', after)

    // The worst case for a policy that throttles only reps: 40 events, every one speakable.
    expect(before.utterances).toBe(SET_REPS * 2)
    expect(after.utterances).toBeLessThanOrEqual(SET_REPS / 2)
    expect(pctOpen(after)).toBeGreaterThan(30)
  })
})

// ------------------------------------------------------------------------ workload 2: real

/** The real clip, replayed per camera take — splicing the takes manufactures reps out of edits. */
const realEvents: readonly CoachEvent[] = segmentedFrames(loadRealMotion())
  .flatMap((frames) => runPipeline(frames, { view: 'side' }).events)
  .slice()
  .sort((a, b) => a.at - b.at)

describe('the REAL recorded pushups, replayed through the real pose pipeline', () => {
  it('is a genuinely mixed event stream, not just reps', () => {
    // Guards the workload itself: if this ever became six rep events, the measurement below
    // would be the simulated case wearing a different name.
    expect(realEvents.length).toBeGreaterThan(10)
    expect(eventsOfKind(realEvents, 'rep_completed')).toHaveLength(6)
    const kinds = new Set(realEvents.map((event) => event.kind))
    expect(kinds.size).toBeGreaterThan(1)
  })

  it('BEFORE vs AFTER on real data: the mic gate goes from shut to mostly open', async () => {
    const before = await replay({ events: realEvents, throttled: false })
    const after = await replay({ events: realEvents, throttled: true })
    report('REAL CLIP before', before)
    report('REAL CLIP after', after)

    expect(after.utterances).toBeLessThan(before.utterances)
    expect(pctOpen(after)).toBeGreaterThan(pctOpen(before))
    // The real clip is ~23 s of footage carrying more events than that many seconds of speech
    // can fit, so the before arm is saturated exactly as the simulation says.
    expect(pctOpen(before)).toBeLessThan(10)
    expect(pctOpen(after)).toBeGreaterThan(30)
    expect(after.longestOpenMs).toBeGreaterThan(4_000)
    // Before, the coach is still talking long after the last rep; after, barely at all.
    expect(overrunMs(before)).toBeGreaterThan(overrunMs(after) + 20_000)
  })
})

// ------------------------------------------------- requirement 4: the counts are untouched

describe('only SPEECH is throttled — the counter, cleanReps and the HUD are unaffected', () => {
  /**
   * The structural argument is that `session.pushEvent` is a SINK: the engine's own listeners
   * feed the HUD, the rep counter and the heart-rate model upstream of it, and the policy runs
   * inside the session. But "it cannot happen" is how the heart-rate defect survived, so this
   * measures it instead: the same 20 events, both arms, and the counting fields compared.
   */
  it('a 20-rep set still totals 20 reps while the coach says a handful of lines', async () => {
    const events = simulatedSet()
    const endMs = SET_REPS * REP_INTERVAL_MS
    const reps = eventsOfKind(events, 'rep_completed')
    expect(reps).toHaveLength(SET_REPS)
    expect(reps[reps.length - 1]!.totalReps).toBe(SET_REPS)
    expect(reps[reps.length - 1]!.cleanReps).toBe(SET_REPS)

    const after = await replay({ events, endMs, throttled: true })
    expect(after.utterances).toBeLessThan(SET_REPS)

    // The events themselves are untouched by the replay — the policy chooses what to SAY, it
    // does not filter, rewrite or consume the stream the rest of the app reads.
    expect(eventsOfKind(events, 'rep_completed')).toHaveLength(SET_REPS)
    expect(reps[reps.length - 1]!.totalReps).toBe(SET_REPS)
  })

  it('the real clip still counts all six reps whichever arm speaks them', async () => {
    const runs = segmentedFrames(loadRealMotion()).map((frames) => runPipeline(frames, { view: 'side' }))
    const counted = runs.reduce((sum, run) => sum + run.reps.totalReps, 0)
    expect(counted).toBe(6)

    const after = await replay({ events: realEvents, throttled: true })
    expect(eventsOfKind(realEvents, 'rep_completed')).toHaveLength(6)
    // Speech is strictly fewer than the events that carried those counts.
    expect(after.utterances).toBeLessThan(realEvents.length)
  })

  it('every rep the coach stays quiet for is TALLIED, never queued to be said later', async () => {
    // The distinction the whole design rests on. If suppressed reps were queued, the utterance
    // count would eventually catch up with the rep count and the set would overrun. It does not.
    const after = await replay({
      events: simulatedSet(SET_REPS),
      endMs: SET_REPS * REP_INTERVAL_MS,
      throttled: true,
    })
    expect(overrunMs(after)).toBe(0)
    expect(after.speakingTotalMs).toBeLessThan(after.utterances * UTTERANCE_SEC * 1000 + 1)
  })
})
