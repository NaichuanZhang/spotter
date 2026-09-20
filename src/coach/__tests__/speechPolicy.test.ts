/**
 * THE COACH TALKING LESS, AND THE SILENCE THE USER SPEAKS INTO.
 *
 * The bug these tests pin, in the user's words: "on every rep, coach speaks too eager,
 * probably due to the data streaming in, anyway to tune this behavior and actually leave
 * room for user to speak?"
 *
 * That is ONE bug with two halves, and the tests are arranged to hold both:
 *
 *   - Every scored rep used to become a synthetic user turn plus a response.create. Reps
 *     land every 2-3 seconds, so the coach talked continuously.
 *   - `micUplink`'s gate is `() => !audio.isSpeaking()`, deliberately, because the mic
 *     hears the same speakers the coach plays through. A coach that never stops speaking
 *     therefore holds the mic gate shut forever, and the user CANNOT get a word in.
 *
 * So the interesting assertions are not "fewer utterances" but the two structural ones:
 * `severeBreaksTheWindow` (safety still wins) and `burstCollapses` (a backlog decays into
 * one line instead of queueing three). A throttle that merely DELAYED three reps would
 * pass a count-based test and still be the same bug.
 *
 * ONE BUCKET. Every assertion about ranking here runs against the real `GateState` /
 * `canSpeak` / `UTTERANCE_RANK` from src/pose/faults.ts, imported not reimplemented, so a
 * second conflicting throttle cannot be introduced without failing these.
 */
import { describe, expect, it } from 'vitest'
import type { CoachEvent, RepMetrics, Severity } from '../../types/events'
import { UTTERANCE_RANK } from '../../pose/faults'
import {
  createSpeechPolicyState,
  decideSpeech,
  inListenWindow,
  noteSilenceStart,
  noteUserSpeech,
  noteUserTurn,
  observeSpeech,
  rankFor,
} from '../speechPolicy'
import type { SpeechPolicyState } from '../speechPolicy'
import {
  createRepCalloutState,
  noteSilentRep,
  noteSpokenRep,
  repTempoMs,
  selectRepCallout,
  silentRepDigest,
} from '../repCallout'
import { SPEECH_TUNING, validateSpeechTuning } from '../speechTuning'

// --------------------------------------------------------------------------- fixtures

/** A depth-92%, fault-free rep. Overridden per test rather than rebuilt. */
function rep(over: Partial<RepMetrics> = {}): RepMetrics {
  return {
    index: 1,
    minElbowAngle: 72,
    maxElbowAngle: 168,
    depthPct: 92,
    hipDeviationDeg: 3,
    descentMs: 900,
    ascentMs: 700,
    partial: false,
    clean: true,
    ...over,
  }
}

function repEvent(totalReps: number, at: number, over: Partial<RepMetrics> = {}): CoachEvent {
  return {
    kind: 'rep_completed',
    at,
    rep: rep({ index: totalReps, ...over }),
    totalReps,
    cleanReps: totalReps,
  }
}

function faultEvent(severity: Severity, at: number): CoachEvent {
  return { kind: 'form_fault', at, fault: 'sagging_hips', severity, valueDeg: 26, heldFrames: 8 }
}

/** The real reps-every-2.5s stream the complaint is about. */
const REP_INTERVAL_MS = 2500

interface Spoken {
  readonly state: SpeechPolicyState
  readonly lines: string[]
  readonly reasons: string[]
}

/**
 * Drives the real `decideSpeech` over a rep stream, threading state exactly as
 * `session.ts` does. `queuedSec` is how the coach's own audio is modelled: audioOut is
 * asked per decision in production, so the fake has to be asked per decision too.
 */
function runReps(
  count: number,
  options: {
    target?: number | null
    queuedSecAt?: (totalReps: number, t: number) => number
    over?: (totalReps: number) => Partial<RepMetrics>
    /** Per-rep audio, drained through `observeSpeech` the way `onAudioDone` does. */
    utteranceSec?: number
    start?: SpeechPolicyState
  } = {},
): Spoken {
  let state = options.start ?? createSpeechPolicyState()
  const lines: string[] = []
  const reasons: string[] = []
  for (let n = 1; n <= count; n += 1) {
    const t = n * REP_INTERVAL_MS
    const decision = decideSpeech(state, {
      event: repEvent(n, t, options.over?.(n)),
      t,
      queuedSec: options.queuedSecAt?.(n, t) ?? 0,
      target: options.target ?? null,
    })
    state = decision.state
    reasons.push(decision.reason)
    if (decision.line !== null) {
      lines.push(decision.line)
      // What `session.ts` does on `output_audio.done`: the whole utterance is queued, so
      // queuedSec() is exactly how much is left to hear, and THAT anchors the window.
      if (options.utteranceSec !== undefined) state = observeSpeech(state, t, options.utteranceSec)
    }
  }
  return { state, lines, reasons }
}

// ------------------------------------------------------------------ the milestone policy

describe('the milestone policy is a pure function of the rep and the set', () => {
  it('speaks on the FIRST rep — the set has started for real', () => {
    expect(selectRepCallout(createRepCalloutState(), rep(), 1, null)).toBe('first')
  })

  it('stays silent through the cadence gap and speaks again on the Nth rep', () => {
    // The coach spoke about rep 1, so the gap is measured from there.
    const after = noteSpokenRep(createRepCalloutState(), rep(), 1)
    for (let n = 2; n < 1 + SPEECH_TUNING.repCadence; n += 1) {
      expect(selectRepCallout(after, rep(), n, null)).toBeNull()
    }
    expect(selectRepCallout(after, rep(), 1 + SPEECH_TUNING.repCadence, null)).toBe('cadence')
  })

  it('counts the cadence from the last rep SPOKEN, not the last rep performed', () => {
    // A callout the listen window swallowed must be retried on the next rep, not skipped
    // for another full cadence — otherwise a single held rep silences the next four.
    let state = createRepCalloutState()
    for (let n = 1; n <= 6; n += 1) state = noteSilentRep(state, rep())
    expect(state.lastSpokenRep).toBe(0)
    expect(selectRepCallout(state, rep(), 6, null)).toBe('cadence')
  })

  it('marks the final stretch and the target, which is what makes a set feel counted', () => {
    const state = noteSpokenRep(createRepCalloutState(), rep(), 1)
    const target = 10
    expect(selectRepCallout(state, rep(), target, target)).toBe('target_reached')
    expect(selectRepCallout(state, rep(), target - 1, target)).toBe('final_stretch')
    // ...and not for a rep still well short of it. Rep 4 is inside the cadence gap too
    // (spoken on 1, cadence is 4), so `null` here means neither reason fired.
    expect(selectRepCallout(state, rep(), 4, target)).toBeNull()
  })

  it('treats a target of 0 or null as "no target" rather than making every rep the finish', () => {
    const state = noteSpokenRep(createRepCalloutState(), rep(), 1)
    for (const target of [null, 0, -1]) {
      expect(selectRepCallout(state, rep(), 3, target)).toBeNull()
    }
  })

  it('speaks on a NOTABLE rep inside the cadence gap: partial, new best depth, tempo shift', () => {
    const base = noteSpokenRep(createRepCalloutState(), rep({ depthPct: 80 }), 1)
    // Rep 2 is inside the gap, so each of these is the ONLY reason it speaks.
    expect(selectRepCallout(base, rep({ partial: true }), 2, null)).toBe('partial')
    expect(
      selectRepCallout(base, rep({ depthPct: 80 + SPEECH_TUNING.newBestDepthPct }), 2, null),
    ).toBe('best_depth')
    // Depth pinned at the set's best, or `best_depth` outranks the tempo reason and this
    // would assert the wrong branch.
    const slower = rep({ depthPct: 80, descentMs: 900 * 2, ascentMs: 700 * 2 })
    expect(selectRepCallout(base, slower, 2, null)).toBe('tempo_shift')
  })

  it('does not call a tempo shift on a frame-quantised blip below the floor', () => {
    const tiny = rep({ descentMs: 100, ascentMs: 100 })
    const state = noteSpokenRep(createRepCalloutState(), tiny, 1)
    expect(repTempoMs(tiny)).toBeLessThan(SPEECH_TUNING.tempoFloorMs)
    // A 200ms "rep" makes every comparison look like a huge change; refuse to compare.
    expect(selectRepCallout(state, rep({ descentMs: 120, ascentMs: 120 }), 2, null)).toBeNull()
  })

  it('stays quiet on an ordinary rep — the default is SILENCE, not commentary', () => {
    const state = noteSpokenRep(createRepCalloutState(), rep(), 1)
    expect(selectRepCallout(state, rep(), 2, null)).toBeNull()
  })
})

// --------------------------------------------------------------- rep 1 and the cadence gap

describe('a 20-rep set, driven through the real decideSpeech', () => {
  it('speaks on rep 1', () => {
    const { lines, reasons } = runReps(1)
    expect(lines).toHaveLength(1)
    expect(reasons[0]).toBe('spoke: rep first')
  })

  it('says nothing on the reps inside the cadence gap', () => {
    // No coach audio at all (queuedSec 0), so ONLY the milestone policy can be
    // suppressing these — the listen window is not doing the work.
    const { reasons } = runReps(SPEECH_TUNING.repCadence)
    expect(reasons[0]).toBe('spoke: rep first')
    for (const reason of reasons.slice(1)) {
      expect(reason).toBe('held: not a milestone (rep_completed)')
    }
  })

  it('narrates a fraction of a clean 20-rep set instead of all of it', () => {
    const { lines } = runReps(20, { utteranceSec: 3 })
    // The old behaviour was 20 of 20. Asserted as a band, not an exact count: the point
    // is the order of magnitude, and pinning it exactly would make every tuning change
    // by ear a test failure, which is the opposite of a tuning surface.
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.length).toBeLessThanOrEqual(6)
  })

  it('still reaches the target callout on a set that has one', () => {
    const { reasons } = runReps(10, { target: 10, utteranceSec: 3 })
    expect(reasons.at(-1)).toBe('spoke: rep target_reached')
  })
})

// ------------------------------------------------------------------ severity pre-emption

describe('severity pre-emption survives, which is the whole reason the ranks exist', () => {
  it('ranks a rep callout at routine and a severe fault above it', () => {
    expect(rankFor(repEvent(1, 0))).toBe(UTTERANCE_RANK.routine)
    expect(rankFor(faultEvent('severe', 0))).toBe(UTTERANCE_RANK.severe)
    expect(rankFor(faultEvent('severe', 0))).toBeGreaterThan(rankFor(repEvent(1, 0)))
  })

  it('lets a SEVERE fault pre-empt a routine rep callout inside the global interval', () => {
    const first = decideSpeech(createSpeechPolicyState(), {
      event: repEvent(1, 1000),
      t: 1000,
      queuedSec: 0,
    })
    expect(first.line).not.toBeNull()
    // 200ms later — far inside GATE_CONFIG.globalIntervalMs, so only rank can get through.
    const severe = decideSpeech(first.state, {
      event: faultEvent('severe', 1200),
      t: 1200,
      queuedSec: 0,
    })
    expect(severe.line).not.toBeNull()
    expect(severe.rank).toBe(UTTERANCE_RANK.severe)
    expect(severe.reason).toBe('spoke: form_fault')
  })

  it('does NOT let a routine rep callout pre-empt a severe fault — the reverse must fail', () => {
    const severe = decideSpeech(createSpeechPolicyState(), {
      event: faultEvent('severe', 1000),
      t: 1000,
      queuedSec: 0,
    })
    expect(severe.line).not.toBeNull()
    const repAfter = decideSpeech(severe.state, {
      event: repEvent(1, 1200),
      t: 1200,
      queuedSec: 0,
    })
    expect(repAfter.line).toBeNull()
  })

  it('holds a MINOR fault that would cut off a line already in progress', () => {
    // A partial rep emits a rep callout AND a partial_depth fault from the same frame.
    const first = decideSpeech(createSpeechPolicyState(), {
      event: repEvent(1, 1000),
      t: 1000,
      queuedSec: 0,
    })
    const minor = decideSpeech(first.state, {
      event: faultEvent('minor', 1010),
      t: 1010,
      queuedSec: 0,
    })
    expect(minor.line).toBeNull()
    expect(minor.reason).toContain('cut off the line in progress')
  })
})

// --------------------------------------------------------------------- the listen window

describe('the listen window is the silence the user speaks into', () => {
  /** A coach mid-utterance: 4s of audio still queued as of t=1000. */
  function speaking(): SpeechPolicyState {
    return observeSpeech(createSpeechPolicyState(), 1000, 4)
  }

  it('is measured from when the audio DRAINS, not from when the event was pushed', () => {
    const state = speaking()
    // 4s of audio from t=1000 drains at 5000; the window runs listenWindowMs past THAT.
    expect(state.speechEndsAt).toBe(5000)
    expect(inListenWindow(state, 4999)).toBe(true)
    expect(inListenWindow(state, 5000 + SPEECH_TUNING.listenWindowMs - 1)).toBe(true)
    expect(inListenWindow(state, 5000 + SPEECH_TUNING.listenWindowMs)).toBe(false)
  })

  it('extends only — a shorter later reading means we are further through the same line', () => {
    // response.done fires with seconds still scheduled, so the two observations disagree
    // and the LONGER one has to win, or the window closes while the coach is audible.
    const state = observeSpeech(speaking(), 2000, 1)
    expect(state.speechEndsAt).toBe(5000)
  })

  it('a ROUTINE rep callout cannot break the window', () => {
    const state = speaking()
    const decision = decideSpeech(state, { event: repEvent(9, 4000), t: 4000, queuedSec: 0 })
    expect(decision.line).toBeNull()
    expect(decision.reason).toContain('listen window')
  })

  it('a SEVERE fault CAN break the window — safety beats politeness', () => {
    const state = speaking()
    const decision = decideSpeech(state, {
      event: faultEvent('severe', 4000),
      t: 4000,
      queuedSec: 0,
    })
    expect(decision.line).not.toBeNull()
    expect(decision.rank).toBe(SPEECH_TUNING.windowBreakMinRank)
  })

  it('a MAJOR fault cannot break it either, at the shipped tuning', () => {
    const decision = decideSpeech(speaking(), {
      event: faultEvent('major', 4000),
      t: 4000,
      queuedSec: 0,
    })
    expect(decision.line).toBeNull()
  })

  it('holds the floor while the USER is talking, and for a grace period after', () => {
    let state = noteUserSpeech(createSpeechPolicyState(), 1000, true)
    expect(decideSpeech(state, { event: repEvent(9, 1500), t: 1500, queuedSec: 0 }).line).toBeNull()
    state = noteUserSpeech(state, 2000, false)
    // Inside the grace period the user may still be mid-thought.
    const during = 2000 + SPEECH_TUNING.userTurnGraceMs - 1
    expect(decideSpeech(state, { event: repEvent(9, during), t: during, queuedSec: 0 }).line).toBeNull()
  })

  it('a barge-in starts the silence NOW rather than leaving a stale drain time', () => {
    // audio.stop() threw the queue away, so holding the window for an utterance nobody
    // heard would gag the coach for seconds.
    const state = noteSilenceStart(speaking(), 2000)
    expect(state.speechEndsAt).toBe(2000)
    expect(inListenWindow(state, 2000 + SPEECH_TUNING.listenWindowMs)).toBe(false)
  })

  it('a typed user turn claims the bucket so a rep cannot trample the answer', () => {
    const state = noteUserTurn(createSpeechPolicyState(), 1000)
    expect(state.gate.lastUtteranceRank).toBe(SPEECH_TUNING.userTurnRank)
    expect(decideSpeech(state, { event: repEvent(9, 1200), t: 1200, queuedSec: 0 }).line).toBeNull()
  })

  it('ignores a non-finite clock or queue reading rather than poisoning the window', () => {
    const base = createSpeechPolicyState()
    expect(observeSpeech(base, Number.NaN, 4).speechEndsAt).toBeNull()
    expect(observeSpeech(base, 1000, Number.POSITIVE_INFINITY).speechEndsAt).toBeNull()
    expect(observeSpeech(base, 1000, -1).speechEndsAt).toBeNull()
    expect(noteSilenceStart(base, Number.NaN)).toBe(base)
  })
})

// ----------------------------------------------------------------- the decaying backlog

describe('a backlog of reps DECAYS, it does not queue', () => {
  /**
   * Three reps land while the coach is mid-utterance, then the window closes. Every one of
   * them WOULD have spoken on its own — they are partials, which is a notable reason — so
   * the only thing stopping them is the window, and a queue would emit three lines.
   */
  it('a burst of three held reps yields ONE utterance, not three', () => {
    // Coach speaking from t=1000 with 4s queued: drains 5000, window to 8500.
    let state = observeSpeech(createSpeechPolicyState(), 1000, 4)
    const lines: string[] = []
    for (const [n, t] of [[2, 2000], [3, 4000], [4, 6000]] as const) {
      const decision = decideSpeech(state, {
        event: repEvent(n, t, { partial: true, clean: false }),
        t,
        queuedSec: 0,
      })
      state = decision.state
      expect(decision.line).toBeNull()
      expect(decision.reason).toContain('listen window')
    }
    expect(state.reps.silentReps).toBe(3)

    // The window has closed. A queue would now flush three lines; this emits exactly one.
    const after = decideSpeech(state, {
      event: repEvent(5, 12_000, { partial: true, clean: false }),
      t: 12_000,
      queuedSec: 0,
    })
    if (after.line !== null) lines.push(after.line)
    expect(lines).toHaveLength(1)
    // ...and the tally is discharged, so the next callout cannot mention them again.
    expect(after.state.reps.silentReps).toBe(0)
  })

  it('collapses the held reps into ONE clause on the line it was going to say anyway', () => {
    let state = createSpeechPolicyState()
    for (let n = 0; n < 3; n += 1) state = { ...state, reps: noteSilentRep(state.reps, rep()) }
    const digest = silentRepDigest(state.reps)
    expect(digest).toContain('3 reps went by without comment')
    expect(digest).toContain('no faults detected')
    // The collapsed clause rides ON the next rep line rather than becoming its own.
    const decision = decideSpeech(state, { event: repEvent(4, 4000), t: 4000, queuedSec: 0 })
    expect(decision.line).toContain('3 reps went by without comment')
  })

  it('says how many of the held reps were flagged rather than claiming they were clean', () => {
    let reps = createRepCalloutState()
    reps = noteSilentRep(reps, rep({ clean: true }))
    reps = noteSilentRep(reps, rep({ clean: false }))
    reps = noteSilentRep(reps, rep({ clean: false }))
    expect(silentRepDigest(reps)).toContain('2 of them flagged')
  })

  it('does not mention a single held rep, which is not worth a clause', () => {
    const reps = noteSilentRep(createRepCalloutState(), rep())
    expect(SPEECH_TUNING.mentionSilentRepsFrom).toBeGreaterThan(1)
    expect(silentRepDigest(reps)).toBeNull()
  })

  it('keeps tracking depth and tempo through the silent reps — only SPEECH is suppressed', () => {
    // The set's measurements must not depend on whether the coach happened to talk, or a
    // "new best depth" after a quiet stretch would be measured against a stale best.
    const reps = noteSilentRep(createRepCalloutState(), rep({ depthPct: 99 }))
    expect(reps.bestDepthPct).toBe(99)
    expect(reps.lastTempoMs).toBe(1600)
  })
})

// ---------------------------------------------------------- mandatory events and immutability

describe('the events that cannot be retried are never suppressed', () => {
  it('speaks set_started, set_ended and the framing edges even mid-utterance', () => {
    // These fire once on a debounced edge, so a dropped one is never re-proposed.
    const state = observeSpeech(createSpeechPolicyState(), 1000, 4)
    const mandatory: CoachEvent[] = [
      { kind: 'set_started', at: 4000, target: 20 },
      { kind: 'set_ended', at: 4000, totalReps: 20, cleanReps: 18, faults: [] },
      { kind: 'out_of_frame', at: 4000, missing: ['left_ankle'] },
      { kind: 'back_in_frame', at: 4000 },
    ]
    for (const event of mandatory) {
      expect(decideSpeech(state, { event, t: 4000, queuedSec: 0 }).line).not.toBeNull()
    }
  })

  it('learns the target from set_started so the finish is recognised without a caller', () => {
    const started = decideSpeech(createSpeechPolicyState(), {
      event: { kind: 'set_started', at: 0, target: 3 },
      t: 0,
      queuedSec: 0,
    })
    expect(started.state.target).toBe(3)
  })

  it('never mutates the state handed to it', () => {
    const before = createSpeechPolicyState()
    const snapshot = JSON.stringify(before)
    decideSpeech(before, { event: repEvent(1, 0), t: 0, queuedSec: 0 })
    observeSpeech(before, 1000, 4)
    noteUserSpeech(before, 1000, true)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

// ------------------------------------------------------------------- the tuning surface

describe('the tuning surface fails loudly rather than going mute or deaf', () => {
  it('accepts the shipped values', () => {
    expect(() => validateSpeechTuning()).not.toThrow()
  })

  it('refuses a window rank a rep callout could break — that is not a window', () => {
    expect(() =>
      validateSpeechTuning({ ...SPEECH_TUNING, windowBreakMinRank: UTTERANCE_RANK.routine }),
    ).toThrow(/windowBreakMinRank/)
  })

  it('refuses a rank above severe, which would make a collapsing back wait its turn', () => {
    expect(() =>
      validateSpeechTuning({ ...SPEECH_TUNING, preemptMinRank: UTTERANCE_RANK.severe + 1 }),
    ).toThrow(/preemptMinRank/)
  })

  it('refuses a cadence of 0 or a fractional one', () => {
    expect(() => validateSpeechTuning({ ...SPEECH_TUNING, repCadence: 0 })).toThrow(/repCadence/)
    expect(() => validateSpeechTuning({ ...SPEECH_TUNING, repCadence: 2.5 })).toThrow(/repCadence/)
  })

  it('refuses a negative listen window and a zero tempo ratio', () => {
    expect(() => validateSpeechTuning({ ...SPEECH_TUNING, listenWindowMs: -1 })).toThrow(
      /listenWindowMs/,
    )
    expect(() => validateSpeechTuning({ ...SPEECH_TUNING, tempoShiftRatio: 0 })).toThrow(
      /tempoShiftRatio/,
    )
  })

  it('a cadence of 1 restores the old narrate-every-rep bug, and is reachable by design', () => {
    // Documents the escape hatch AND that the knob is the only thing standing between the
    // shipped behaviour and the complaint.
    const loud = { ...SPEECH_TUNING, repCadence: 1 }
    expect(() => validateSpeechTuning(loud)).not.toThrow()
  })
})
