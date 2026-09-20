/**
 * The barge-in detector, driven buffer by buffer with no microphone in sight.
 *
 * WHAT THIS PROVES: the DECISION. Given a sequence of local RMS levels and who was
 * speaking when, does the coach get cut off — and, far more important, does it stay
 * uncut for a cough, a door, one burst of echo, or a room that is simply loud. Every
 * number the detector compares against is derived from the room rather than hardcoded,
 * so the tests assert the RELATIONSHIP (n times the tracked floor) and not a constant.
 *
 * WHAT IT CANNOT PROVE: that the level it is handed is the user and not the coach's own
 * voice leaking back through the speakers. That is the browser's echo canceller, it is
 * the load-bearing assumption of the whole feature, and it cannot be measured from a
 * shell — see bargeIn.ts's header and the guards tested at the bottom of this file,
 * which exist precisely because that assumption can fail.
 */
import { describe, expect, it } from 'vitest'
import {
  BARGE_IN_TUNING,
  gateHeldOpen,
  INITIAL_BARGE_IN,
  maxSampleGapMs,
  observeLevel,
  preRollBuffers,
  triggerLevel,
  validateBargeInTuning,
  withinEchoGuard,
} from '../bargeIn'
import type { BargeInState, BargeInTuning } from '../bargeIn'
import { AUDIO_IN_BUFFER_PERIOD_MS, AUDIO_IN_CONFIG } from '../audioIn'

const PERIOD = AUDIO_IN_BUFFER_PERIOD_MS

interface Run {
  readonly state: BargeInState
  /** Timestamps of every buffer that fired a barge-in. */
  readonly triggers: number[]
  readonly at: number
}

/** Feeds `count` buffers one period apart, exactly as audioIn delivers them. */
function feed(
  run: Run,
  count: number,
  level: number,
  coachSpeaking: boolean,
  tuning: BargeInTuning = BARGE_IN_TUNING,
): Run {
  let { state, at } = run
  const triggers = [...run.triggers]
  for (let i = 0; i < count; i += 1) {
    at += PERIOD
    const outcome = observeLevel(state, { level, coachSpeaking, at }, tuning)
    state = outcome.state
    if (outcome.trigger) triggers.push(at)
  }
  return { state, triggers, at }
}

const start = (): Run => ({ state: INITIAL_BARGE_IN, triggers: [], at: 1_000 })

/**
 * A settled quiet room: room tone at `level` while the coach says nothing, long enough
 * for the tracker to converge down off its deliberately-high starting estimate.
 */
function settled(level: number, tuning: BargeInTuning = BARGE_IN_TUNING): Run {
  return feed(start(), 40, level, false, tuning)
}

/** Buffers needed to satisfy the hold, given one period of credit per buffer. */
const holdBuffers = (tuning: BargeInTuning = BARGE_IN_TUNING): number =>
  Math.ceil(tuning.holdMs / PERIOD) + 1

describe('sustained speech cuts the coach off', () => {
  it('triggers once the level has held above the bar for holdMs', () => {
    const room = settled(0.01)
    // Past the echo guard first: the coach has been talking a while and the mic hears
    // only room tone, which is the normal state of a half-duplex utterance.
    const quiet = feed(room, 12, 0.01, true)
    expect(quiet.triggers).toEqual([])

    const loud = feed(quiet, holdBuffers(), 0.5, true)
    expect(loud.triggers).toHaveLength(1)
    expect(loud.state.triggers).toBe(1)
  })

  it('fires once and stops, because a stopped coach is nothing to barge into', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    // The realistic path: the trigger stops the coach, so the NEXT buffers see
    // coachSpeaking false even though the user carries on talking for three seconds.
    const fired = feed(quiet, holdBuffers(), 0.5, true)
    const rest = feed(fired, 36, 0.5, false)
    expect(rest.triggers).toHaveLength(1)
  })

  it('rate-limits rather than machine-guns when the coach will NOT stop', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    // Three seconds of speech with the coach still audible throughout — the hook did not
    // discard the rest of the response, or the server is still streaming it. Re-asserting
    // is deliberate (the alternative is the gate closing on the user mid-sentence), but it
    // must be bounded by refractoryMs and NOT fire once per 85 ms buffer.
    const talking = feed(quiet, 36, 0.5, true)
    expect(talking.triggers.length).toBeGreaterThan(1)
    expect(talking.triggers.length).toBeLessThanOrEqual(
      Math.ceil((36 * PERIOD) / BARGE_IN_TUNING.refractoryMs),
    )
    const gaps = talking.triggers.slice(1).map((at, i) => at - talking.triggers[i])
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(BARGE_IN_TUNING.refractoryMs)
  })

  it('holds the gate open for a bounded window after firing, then lets it shut again', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    const fired = feed(quiet, holdBuffers(), 0.5, true)
    const firedAt = fired.triggers[0]

    expect(gateHeldOpen(fired.state, firedAt + 1)).toBe(true)
    expect(gateHeldOpen(fired.state, firedAt + BARGE_IN_TUNING.holdGateOpenMs - 1)).toBe(true)
    // Bounded on purpose: if the interrupt hook is broken and the coach keeps talking, the
    // gate closes again rather than feeding the model its own voice for the rest of the set.
    expect(gateHeldOpen(fired.state, firedAt + BARGE_IN_TUNING.holdGateOpenMs)).toBe(false)
  })

  it('needs a fresh hold after the refractory period, and will not double-fire inside it', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    const first = feed(quiet, holdBuffers(), 0.5, true)
    expect(first.triggers).toHaveLength(1)

    // Straight back to loud: the hold is satisfiable again almost immediately, and only the
    // refractory period stops a second interrupt landing on top of the first.
    const withinRefractory = feed(first, holdBuffers(), 0.5, true)
    expect(withinRefractory.triggers).toHaveLength(1)

    const later = feed(
      { ...withinRefractory, at: withinRefractory.at + BARGE_IN_TUNING.refractoryMs },
      holdBuffers(),
      0.5,
      true,
    )
    expect(later.triggers).toHaveLength(2)
  })
})

describe('what must NOT cut the coach off', () => {
  it('ignores a single loud buffer — a cough, a door, a dropped dumbbell', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    let run = quiet
    // Twenty isolated transients. Each is loud enough to clear the bar; none lasts.
    for (let i = 0; i < 20; i += 1) {
      run = feed(run, 1, 0.8, true)
      run = feed(run, 2, 0.01, true)
    }
    expect(run.triggers).toEqual([])
  })

  it('ignores a level that only just clears the tracked noise floor', () => {
    // A 0.05 room: the tracker learns it rather than being told it.
    const room = settled(0.05)
    expect(room.state.noiseFloor).toBeCloseTo(0.05, 2)

    const quiet = feed(room, 12, 0.05, true)
    // 1.5x the floor. In a silent room this level would be shouting; here it is the room.
    const nudged = feed(quiet, 40, 0.075, true)
    expect(nudged.triggers).toEqual([])
    // ...and the bar it failed is derived from the room, not from a constant.
    expect(triggerLevel(nudged.state, nudged.at)).toBeCloseTo(0.05 * BARGE_IN_TUNING.triggerOverFloor, 3)
  })

  it('is harder to trigger in a loud room than in a quiet one, which is the whole point', () => {
    const loudRoom = feed(settled(0.05), 12, 0.05, true)
    const quietRoom = feed(settled(0.004), 12, 0.004, true)

    // The SAME voice level: enough in the quiet room, not enough in the loud one. A fixed
    // absolute threshold cannot express this, which is why there is not one.
    expect(feed(loudRoom, holdBuffers(), 0.06, true).triggers).toEqual([])
    expect(feed(quietRoom, holdBuffers(), 0.06, true).triggers).toHaveLength(1)
  })

  it('never lets one buffer satisfy the hold, however long the capture stalled', () => {
    const quiet = feed(settled(0.01), 12, 0.01, true)
    // A backgrounded tab, or a capture stuck behind MediaPipe: ten seconds since the last
    // buffer. Unclamped, this one loud buffer would be credited with 10s of "sustained".
    const stalled = observeLevel(quiet.state, { level: 0.9, coachSpeaking: true, at: quiet.at + 10_000 })
    expect(stalled.trigger).toBe(false)
    expect(stalled.state.aboveMs).toBeCloseTo(maxSampleGapMs(), 5)
    expect(maxSampleGapMs()).toBeLessThan(BARGE_IN_TUNING.holdMs)
  })

  it('does not trigger while the coach is silent, because there is nothing to interrupt', () => {
    // The gate is already open here; a trigger would only fire a pointless interrupt.
    const talking = feed(settled(0.01), 40, 0.6, false)
    expect(talking.triggers).toEqual([])
    expect(talking.state.aboveMs).toBe(0)
  })

  it('will not fire on the level of a buffer that audioIn would never transmit', () => {
    // minTrigger sits above the silence floor, so the quietest possible "speech" is still
    // loud enough to reach the wire. A floor of ~0 must not make a tick into a barge-in.
    expect(BARGE_IN_TUNING.minTrigger).toBeGreaterThan(AUDIO_IN_CONFIG.silenceFloor)
    const dead = settled(0)
    expect(dead.state.noiseFloor).toBeLessThan(0.001)
    expect(triggerLevel(dead.state, dead.at)).toBe(BARGE_IN_TUNING.minTrigger)
    const ticks = feed(feed(dead, 12, 0, true), 40, AUDIO_IN_CONFIG.silenceFloor, true)
    expect(ticks.triggers).toEqual([])
  })
})

describe('FAIL-SAFE: the echo guard', () => {
  it('suppresses a trigger immediately after the coach starts, and says so', () => {
    const room = settled(0.01)
    const bar = triggerLevel(room.state, room.at)
    // Above the ordinary bar, below the guarded one: exactly the level that an echo
    // canceller leaking on the first word of a line would produce.
    const leak = bar * 1.5
    expect(leak).toBeLessThan(bar * BARGE_IN_TUNING.echoGuardFactor)

    const early = feed(room, holdBuffers() + 2, leak, true)
    expect(early.triggers).toEqual([])
    // Counted, not silently dropped: a stream of these is how a human finds out the AEC
    // in this room is not holding and that the master switch is the right answer.
    expect(early.state.earlySuppressions).toBeGreaterThan(0)
    expect(withinEchoGuard(room.state, room.at + 1)).toBe(false) // guard starts with the speech
  })

  it('lets the same level through once the guard has expired', () => {
    const room = settled(0.01)
    const leak = triggerLevel(room.state, room.at) * 1.5
    // The coach has now been talking for longer than the guard, so a sustained level at
    // the ordinary bar is much more likely to be a person than an unconverged canceller.
    const past = feed(room, Math.ceil(BARGE_IN_TUNING.echoGuardMs / PERIOD) + 1, 0.001, true)
    expect(withinEchoGuard(past.state, past.at)).toBe(false)
    expect(feed(past, holdBuffers(), leak, true).triggers).toHaveLength(1)
  })

  it('still lets a clearly louder voice through inside the guard', () => {
    // The guard raises the bar; it does not close the door. A user who really does talk
    // over the coach's first word gets heard.
    const room = settled(0.01)
    const shout = triggerLevel(room.state, room.at) * BARGE_IN_TUNING.echoGuardFactor * 1.2
    expect(feed(room, holdBuffers(), shout, true).triggers).toHaveLength(1)
  })

  it('re-arms the guard for each new utterance', () => {
    const room = settled(0.01)
    const spoken = feed(room, 20, 0.001, true)
    expect(withinEchoGuard(spoken.state, spoken.at)).toBe(false)
    // Coach stops, then starts a new line: the guard applies again from the new start.
    const between = feed(spoken, 2, 0.001, false)
    const fresh = feed(between, 1, 0.001, true)
    expect(withinEchoGuard(fresh.state, fresh.at)).toBe(true)
  })
})

describe('FAIL-SAFE: the master switch', () => {
  const off: BargeInTuning = { ...BARGE_IN_TUNING, enabled: false }

  it('disables barge-in entirely, however loud and however long', () => {
    const room = settled(0.01, off)
    const shouted = feed(feed(room, 12, 0.01, true, off), 60, 1, true, off)
    expect(shouted.triggers).toEqual([])
    expect(shouted.state.triggers).toBe(0)
    expect(gateHeldOpen(shouted.state, shouted.at)).toBe(false)
  })

  it('reports why, so a switched-off detector is not mistaken for a broken one', () => {
    const outcome = observeLevel(INITIAL_BARGE_IN, { level: 1, coachSpeaking: true, at: 5 }, off)
    expect(outcome.reason).toBe('disabled')
  })
})

describe('the noise floor tracks the room, not the people in it', () => {
  it('converges downward from its deliberately-high starting estimate', () => {
    // Starting high means the first seconds of a session are the HARDEST to barge into,
    // which is the safe direction to be wrong in.
    expect(INITIAL_BARGE_IN.noiseFloor).toBe(BARGE_IN_TUNING.initialFloor)
    expect(settled(0.006).state.noiseFloor).toBeLessThan(0.01)
  })

  it('freezes while the coach speaks, so the coach can never define the room', () => {
    const room = settled(0.01)
    const during = feed(room, 30, 0.02, true)
    expect(during.state.noiseFloor).toBe(room.state.noiseFloor)
  })

  it('excludes the user\'s own speech, so talking cannot raise the bar on itself', () => {
    const room = settled(0.01)
    const talking = feed(room, 30, 0.4, false)
    expect(talking.state.noiseFloor).toBe(room.state.noiseFloor)
  })

  it('follows the room down fast and up slowly', () => {
    const quiet = settled(0.004)
    // A fan comes on. One second later the floor has only crept part of the way up —
    // otherwise a passing noise would instantly deafen the detector.
    const noisier = feed(quiet, Math.round(1000 / PERIOD), 0.009, false)
    expect(noisier.state.noiseFloor).toBeGreaterThan(quiet.state.noiseFloor)
    expect(noisier.state.noiseFloor).toBeLessThan(0.006)

    // The fan goes off. The floor comes back down much sooner.
    const backDown = feed(noisier, Math.round(1000 / PERIOD), 0.004, false)
    expect(backDown.state.noiseFloor).toBeCloseTo(0.004, 3)
  })
})

describe('shape and invariants', () => {
  it('never mutates the state it is given', () => {
    const before = { ...INITIAL_BARGE_IN }
    const outcome = observeLevel(INITIAL_BARGE_IN, { level: 0.9, coachSpeaking: true, at: 42 })
    expect(INITIAL_BARGE_IN).toEqual(before)
    expect(outcome.state).not.toBe(INITIAL_BARGE_IN)
    expect(Object.isFrozen(INITIAL_BARGE_IN)).toBe(true)
  })

  it('derives the pre-roll length from the buffer period instead of counting by hand', () => {
    expect(preRollBuffers()).toBe(Math.ceil(BARGE_IN_TUNING.preRollMs / PERIOD))
    expect(preRollBuffers({ ...BARGE_IN_TUNING, preRollMs: 0 })).toBe(0)
    // It must cover the hold, or barge-in loses exactly the words that proved it was needed.
    expect(BARGE_IN_TUNING.preRollMs).toBeGreaterThanOrEqual(BARGE_IN_TUNING.holdMs)
  })

  it('accepts the shipped tuning', () => {
    expect(() => validateBargeInTuning()).not.toThrow()
  })

  it('rejects a hold one buffer could satisfy', () => {
    expect(() => validateBargeInTuning({ ...BARGE_IN_TUNING, holdMs: PERIOD })).toThrow(
      /one buffer must never be able to cut the coach off/,
    )
  })

  it('rejects a trigger the floor tracker would absorb', () => {
    expect(() =>
      validateBargeInTuning({ ...BARGE_IN_TUNING, triggerOverFloor: 2, floorIgnoreFactor: 2.5 }),
    ).toThrow(/floor tracker absorbs the speech/)
  })

  it('rejects a trigger below the level audioIn would transmit', () => {
    expect(() =>
      validateBargeInTuning({ ...BARGE_IN_TUNING, minTrigger: AUDIO_IN_CONFIG.silenceFloor / 2 }),
    ).toThrow(/silenceFloor/)
  })

  it('rejects an echo guard that makes the start of a line easier to interrupt', () => {
    expect(() => validateBargeInTuning({ ...BARGE_IN_TUNING, echoGuardFactor: 0.5 })).toThrow(
      /which is backwards/,
    )
  })

  it('rejects a zero-length gate hold, which would re-close on the fade-out', () => {
    expect(() => validateBargeInTuning({ ...BARGE_IN_TUNING, holdGateOpenMs: 0 })).toThrow(
      /re-closes on the fade-out/,
    )
  })
})
