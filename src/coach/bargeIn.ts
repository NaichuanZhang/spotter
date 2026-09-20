/**
 * BARGE-IN: how the user cuts the coach off, and the one place to tune it BY EAR.
 *
 * The other half of "leave room for user to speak". Talking less (speechTuning.ts) opens
 * the gate between utterances; this opens it DURING one.
 *
 * ── WHY THIS IS POSSIBLE AT ALL ────────────────────────────────────────────────────
 * The mic gate is a CLIENT decision. While the coach speaks, `micUplink`'s gate is shut
 * and `audioIn` keeps capturing and throws the buffers away — so the user's interruption
 * is already in our hands, in memory, and we are deleting it. This module reads the LOCAL
 * level of those discarded buffers and decides whether someone is really talking.
 *
 * ⚠️ THE LOAD-BEARING ASSUMPTION IS BROWSER ECHO CANCELLATION. `AUDIO_IN_CONFIG.constraints`
 * already requests `echoCancellation: true`, so the coach's own voice — arriving back into
 * the mic through the speakers — should be largely removed from the captured signal before
 * we ever see it. That is the ONLY reason a level test can distinguish "the user is talking"
 * from "the coach is talking". If AEC is weak (external speakers far from the mic, a virtual
 * audio device, a browser that ignores the constraint), the residue of the coach's own voice
 * is what this module measures, and it will interrupt ITSELF. Everything called a "guard"
 * below exists for that case, and `enabled: false` is the escape hatch. Nobody can verify
 * real-room AEC from a shell; the numbers here are chosen to fail quiet, not to be optimal.
 *
 * ── WHY A TRACKED NOISE FLOOR AND NOT AN ABSOLUTE NUMBER ───────────────────────────
 * A fixed RMS threshold is wrong in every room but the one it was measured in: a quiet
 * office sits near zero, a gym with a fan sits an order of magnitude higher, and
 * `autoGainControl` (also requested) moves the whole scale depending on how far the user is
 * from the laptop. So the trigger is RELATIVE — a multiple of a rolling estimate of the
 * room, tracked only while the coach is silent, with the user's own speech excluded from
 * the estimate so shouting cannot raise the bar it has to clear.
 *
 * ── PURE, SO IT CAN BE TESTED WITHOUT A MICROPHONE ─────────────────────────────────
 * Everything here is a pure function over an immutable state record. `observeLevel` never
 * touches audio, the socket or the clock; `micUplink` owns all of that and threads the
 * returned state. The only import is `audioIn` for the buffer period and the silence floor,
 * because two of the invariants below are relations against those and a relation that is not
 * checked is a relation that drifts.
 */

import { AUDIO_IN_BUFFER_PERIOD_MS, AUDIO_IN_CONFIG } from './audioIn'

/**
 * Every barge-in knob, in one place, each with what RAISING or LOWERING it does to what a
 * person in the room experiences. These are ear-tuned, not reasoned: the only honest way to
 * set them is to stand in the real room with the real speakers and try to interrupt.
 */
export const BARGE_IN_TUNING = {
  /**
   * THE MASTER SWITCH. `false` restores the old strictly half-duplex behaviour: the coach
   * cannot be interrupted, and nothing below runs.
   *
   * Turn it OFF if the coach ever cuts ITSELF off in the room you are demoing in — a coach
   * that chops its own sentences in half is far worse than one you have to wait for. The
   * symptom to watch for in the debug log is `suspected echo` lines (see
   * `BargeInState.earlySuppressions`): a few are healthy, a steady stream means the echo
   * canceller is not holding and this should be off.
   */
  enabled: true,

  /**
   * How far above the tracked room level a buffer must sit to count as speech, as a
   * MULTIPLE (4 = +12 dB).
   *
   * RAISE IT (6, 8) if the coach gets interrupted by a fan, a door, a TV or the residue of
   * its own voice. LOWER IT (2.5, 3) if you have to shout to interrupt. Must stay above
   * `floorIgnoreFactor`, or the floor tracker would absorb the very speech that is supposed
   * to trigger — `validateBargeInTuning` enforces that.
   */
  triggerOverFloor: 4,

  /**
   * An absolute floor under the computed trigger, as RMS. Without it, a digitally silent
   * input — an OS-muted mic, or an echo canceller doing an unusually good job — drives the
   * tracked floor toward zero, where `4 x nothing` is still nothing and the faintest tick
   * barges in.
   *
   * 0.012 is 3x `AUDIO_IN_CONFIG.silenceFloor` (0.004), i.e. comfortably inside the band
   * audioIn already considers "not silence". RAISE IT if barge-in fires in a silent room;
   * it must stay above the silence floor, because a buffer below that floor is never even
   * transmitted.
   */
  minTrigger: 0.012,

  /**
   * HYSTERESIS. How long the level must stay above the trigger before the coach is cut off.
   *
   * This is the constant that separates "the user started a sentence" from a cough, a door,
   * a dropped dumbbell or one buffer of echo. 250 ms is about three buffers at
   * `AUDIO_IN_CONFIG.bufferSize`, i.e. a syllable and a half of continuous sound.
   *
   * RAISE IT (400, 600) if single noises still cut the coach off; LOWER IT (170) to make
   * interrupting feel instant, at the cost of triggering on transients. It may never fall
   * below two buffer periods — one buffer must never be enough, by construction — and
   * `validateBargeInTuning` enforces that.
   */
  holdMs: 250,

  /**
   * FAIL-SAFE 1, THE ECHO GUARD. How long after the coach STARTS speaking a trigger is
   * treated as suspected echo rather than as the user.
   *
   * This window is where self-interruption lives: the speakers have just come up, the echo
   * canceller has not converged on the new signal, and the first loud thing the mic hears is
   * almost certainly the coach. Inside it the bar is multiplied by `echoGuardFactor`, so a
   * user who really does talk over the coach's first word still gets through — they just
   * have to be clearly louder than the leak.
   *
   * RAISE IT if self-interruption happens at the start of lines; LOWER IT (or 0) if you are
   * confident in the AEC and want to interrupt the first word as easily as the last.
   */
  echoGuardMs: 700,

  /**
   * How much higher the bar sits inside the echo guard, as a multiple of the ordinary
   * trigger (2.5 = +8 dB on top of the +12 dB).
   *
   * RAISE IT to make the start of a line nearly uninterruptible; 1 disables the guard while
   * leaving the window in place (not recommended — that is the failure mode this exists for).
   */
  echoGuardFactor: 2.5,

  /**
   * FAIL-SAFE 2. Minimum time between two barge-ins, i.e. a RATE LIMIT on the interrupt hook.
   * Without it a marginal room machine-guns `interruptCoach` once per buffer (every ~85 ms),
   * which would ratchet the session's own discard window forward indefinitely and leave the
   * coach permanently mute.
   *
   * It is a rate limit and NOT a one-shot, deliberately. In the normal case the question
   * never arises: the interrupt works, the coach falls silent within a buffer or two, and the
   * hold resets because there is nothing left to barge into — one interruption, one trigger.
   * The case this covers is the coach still being audible a second later (the hook did not
   * discard the rest of the response, or the server is still streaming it) while the user is
   * still talking. Re-asserting then is what the user wants; going quiet and letting the gate
   * close mid-sentence would cost them the second half of their question.
   *
   * RAISE IT if the debug log shows barge-ins in bursts; LOWER IT to re-assert sooner against
   * a coach that will not stop.
   */
  refractoryMs: 800,

  /**
   * FAIL-SAFE 3. How long the gate is force-held open after a barge-in, regardless of what
   * the coach's audio is doing.
   *
   * It exists because the interrupt is not instantaneous: `audioOut.stop()` fades over
   * `AUDIO_CONFIG.fadeOutMs` and the server keeps STREAMING the rest of the utterance for a
   * moment afterwards, so `isCoachSpeaking()` can flicker back on straight after a trigger
   * and re-gate the user mid-word. Equally, it is BOUNDED on purpose: if the interrupt hook
   * is broken or the coach ignores it, the gate closes again after this and we are back to
   * safe half-duplex instead of a permanently open mic feeding the model its own voice.
   *
   * RAISE IT if the first second of your interruption gets clipped; LOWER IT if a barge-in
   * leaves the mic open into the coach's next line.
   */
  holdGateOpenMs: 1_200,

  /**
   * PRE-ROLL. How much of the audio captured *before* the trigger is sent, in ms.
   *
   * Without this, barge-in loses exactly the `holdMs` of speech that PROVED the user was
   * talking — the user says "wait, my shoulder—" and the model receives "shoulder". Feeling
   * broken while working is worse than not existing, so the gated buffers are kept in a
   * bounded ring and replayed, in order, ahead of the buffer that triggered.
   *
   * Slightly longer than `holdMs` by design, so the whole proving window is recovered plus
   * the attack of the first word. 0 disables pre-roll entirely (the trigger buffer onward is
   * still sent). Each buffer is ~5.5 KB of base64, so the ring is tens of KB — cheap.
   */
  preRollMs: 300,

  // ── Noise-floor tracker ─────────────────────────────────────────────────────────────
  // An asymmetric EWMA: quick to follow the room DOWN, slow to follow it UP, and frozen
  // while the coach speaks or while the level looks like speech. The asymmetry is the whole
  // point — the floor should settle on the quietest thing the room does, not on its average.

  /**
   * Where the floor starts, as RMS. Deliberately HIGH (0.05 is a loud room), so the very
   * first seconds of a session are hard to barge into and the tracker converges downward
   * onto the real room. Starting low would make the first trigger the twitchiest one.
   */
  initialFloor: 0.05,

  /** Time constant for following the room DOWN. Short: the floor should find quiet fast. */
  floorFallMs: 500,

  /**
   * Time constant for following the room UP. Long, so a passing truck raises the bar slowly
   * rather than instantly deafening the detector.
   */
  floorRiseMs: 5_000,

  /**
   * Levels above `floor x this` are assumed to be SOMEONE TALKING and are excluded from the
   * floor estimate entirely (neither up nor down). Without it, a user who talks through the
   * coach's silence would drag the floor up behind them and then be unable to barge in.
   *
   * Must stay below `triggerOverFloor` so there is always a band the tracker ignores before
   * the band that triggers.
   */
  floorIgnoreFactor: 2.5,

  /**
   * Largest gap between two buffers that still counts as continuous time, in buffer periods.
   *
   * Hysteresis is accumulated in MILLISECONDS (so it survives a change to
   * `AUDIO_IN_CONFIG.bufferSize`), which means a long gap — a tab that was backgrounded, a
   * capture that stalled behind MediaPipe — would otherwise credit one loud buffer with
   * seconds of "sustained" level and trigger on it. Clamped here so a single buffer can
   * never satisfy `holdMs` no matter what the clock did.
   */
  maxSampleGapBuffers: 2,
} as const

/** The same shape widened to plain numbers, so a candidate set can be validated. */
export type BargeInTuning = {
  readonly enabled: boolean
  readonly triggerOverFloor: number
  readonly minTrigger: number
  readonly holdMs: number
  readonly echoGuardMs: number
  readonly echoGuardFactor: number
  readonly refractoryMs: number
  readonly holdGateOpenMs: number
  readonly preRollMs: number
  readonly initialFloor: number
  readonly floorFallMs: number
  readonly floorRiseMs: number
  readonly floorIgnoreFactor: number
  readonly maxSampleGapBuffers: number
}

/** How many captured buffers the pre-roll ring holds. Derived, never hand-counted. */
export function preRollBuffers(tuning: BargeInTuning = BARGE_IN_TUNING): number {
  return Math.max(0, Math.ceil(tuning.preRollMs / AUDIO_IN_BUFFER_PERIOD_MS))
}

/** Longest gap between buffers that counts as continuous time, in ms. */
export function maxSampleGapMs(tuning: BargeInTuning = BARGE_IN_TUNING): number {
  return tuning.maxSampleGapBuffers * AUDIO_IN_BUFFER_PERIOD_MS
}

/**
 * Everything the detector remembers between buffers. Immutable: `observeLevel` returns a new
 * record rather than mutating, so a caller can keep an old one for comparison and a test can
 * assert on a sequence.
 */
export interface BargeInState {
  /** Rolling estimate of the room, as RMS. The thing the trigger is relative to. */
  readonly noiseFloor: number
  /** Milliseconds the level has been continuously above the trigger. Reset by one buffer below. */
  readonly aboveMs: number
  /** Timestamp of the last observed buffer, or null before the first. */
  readonly lastAt: number | null
  /** When the coach's current run of speech started. Null while it is silent. */
  readonly coachSince: number | null
  /** The gate is force-held open until this timestamp. 0 before the first barge-in. */
  readonly openUntil: number
  /** When the last barge-in fired, for the refractory period. */
  readonly lastTriggerAt: number
  /** How many barge-ins have fired this session. Diagnostics only. */
  readonly triggers: number
  /**
   * How many buffers cleared the ordinary bar but were held back by the echo guard. A steady
   * stream of these is the signal that AEC is not holding in this room and that
   * `enabled: false` is the right call.
   */
  readonly earlySuppressions: number
}

export const INITIAL_BARGE_IN: BargeInState = Object.freeze({
  noiseFloor: BARGE_IN_TUNING.initialFloor,
  aboveMs: 0,
  lastAt: null,
  coachSince: null,
  openUntil: 0,
  lastTriggerAt: Number.NEGATIVE_INFINITY,
  triggers: 0,
  earlySuppressions: 0,
})

/** One captured buffer, as far as the detector is concerned. */
export interface BargeInSample {
  /** 0..1 RMS of the buffer, measured LOCALLY — computed even while the gate is shut. */
  readonly level: number
  /** Whether the coach is audible right now, i.e. whether there is anything to barge into. */
  readonly coachSpeaking: boolean
  /** Monotonic ms. */
  readonly at: number
}

export interface BargeInOutcome {
  readonly state: BargeInState
  /** True on exactly the buffer where the hold completes. The caller acts on this edge. */
  readonly trigger: boolean
  /** Why this buffer did or did not trigger. Fed to onDebug; never thrown away silently. */
  readonly reason: BargeInReason
}

export type BargeInReason =
  | 'disabled'
  | 'coach-silent'
  | 'below-trigger'
  | 'holding'
  | 'suspected-echo'
  | 'refractory'
  | 'triggered'

/**
 * The bar this buffer had to clear, as RMS. Exported because it is the number a human tuning
 * `triggerOverFloor` actually wants to see, and because the echo-guard multiplier is
 * invisible otherwise.
 */
export function triggerLevel(
  state: BargeInState,
  at: number,
  tuning: BargeInTuning = BARGE_IN_TUNING,
): number {
  const base = Math.max(tuning.minTrigger, state.noiseFloor * tuning.triggerOverFloor)
  return withinEchoGuard(state, at, tuning) ? base * tuning.echoGuardFactor : base
}

/** True while the coach's current utterance is young enough for a trigger to be suspect. */
export function withinEchoGuard(
  state: BargeInState,
  at: number,
  tuning: BargeInTuning = BARGE_IN_TUNING,
): boolean {
  if (state.coachSince === null) return false
  return at - state.coachSince < tuning.echoGuardMs
}

/** True while a barge-in is still force-holding the gate open. */
export function gateHeldOpen(state: BargeInState, at: number): boolean {
  return at < state.openUntil
}

/**
 * THE REDUCER. One captured buffer in, a new state plus a trigger edge out.
 *
 * Order matters and is the whole design:
 *   1. the floor is only ever updated while the coach is SILENT, so its own voice — however
 *      well cancelled — can never define the room;
 *   2. the hold only ever accumulates while the coach is SPEAKING, because there is nothing
 *      to barge into otherwise and a stale accumulator would fire on the coach's first word;
 *   3. the trigger is the EDGE where the hold completes, and it resets the hold, so one
 *      sustained sentence produces one barge-in and not one per buffer.
 */
export function observeLevel(
  state: BargeInState,
  sample: BargeInSample,
  tuning: BargeInTuning = BARGE_IN_TUNING,
): BargeInOutcome {
  const dt = elapsed(state, sample.at, tuning)
  const coachSince = trackCoachSpeech(state, sample)
  const base: BargeInState = { ...state, lastAt: sample.at, coachSince }

  if (!tuning.enabled) {
    return { state: { ...base, aboveMs: 0 }, trigger: false, reason: 'disabled' }
  }

  if (!sample.coachSpeaking) {
    // The gate is already open; the only job here is to learn the room.
    return {
      state: { ...base, noiseFloor: trackFloor(state, sample.level, dt, tuning), aboveMs: 0 },
      trigger: false,
      reason: 'coach-silent',
    }
  }

  // Coach speaking: the floor is frozen (see the header) and the hysteresis runs.
  const bar = triggerLevel(base, sample.at, tuning)
  if (sample.level < bar) {
    const suspect =
      withinEchoGuard(base, sample.at, tuning) &&
      sample.level >= bar / tuning.echoGuardFactor
    return {
      state: {
        ...base,
        aboveMs: 0,
        earlySuppressions: base.earlySuppressions + (suspect ? 1 : 0),
      },
      trigger: false,
      reason: suspect ? 'suspected-echo' : 'below-trigger',
    }
  }

  const aboveMs = base.aboveMs + dt
  if (aboveMs < tuning.holdMs) {
    return { state: { ...base, aboveMs }, trigger: false, reason: 'holding' }
  }
  if (sample.at - base.lastTriggerAt < tuning.refractoryMs) {
    // Held down but too soon: keep the gate decision out of the caller's hands rather than
    // firing the interrupt hook twice in a row, whose side effects are not idempotent.
    return { state: { ...base, aboveMs: 0 }, trigger: false, reason: 'refractory' }
  }

  return {
    state: {
      ...base,
      aboveMs: 0,
      openUntil: sample.at + tuning.holdGateOpenMs,
      lastTriggerAt: sample.at,
      triggers: base.triggers + 1,
    },
    trigger: true,
    reason: 'triggered',
  }
}

/**
 * Time since the previous buffer, CLAMPED. The clamp is a safety property, not a nicety:
 * unclamped, a stalled capture would hand one loud buffer enough credit to satisfy `holdMs`
 * on its own, which is exactly the single-transient trigger the hold exists to prevent.
 */
function elapsed(state: BargeInState, at: number, tuning: BargeInTuning): number {
  if (state.lastAt === null) return 0
  const raw = at - state.lastAt
  if (!(raw > 0)) return 0
  return Math.min(raw, maxSampleGapMs(tuning))
}

/** Rising edge of the coach's speech, which is what the echo guard is measured from. */
function trackCoachSpeech(state: BargeInState, sample: BargeInSample): number | null {
  if (!sample.coachSpeaking) return null
  return state.coachSince ?? sample.at
}

/**
 * Asymmetric EWMA with a speech exclusion band. Returns the new floor; never mutates.
 *
 * `alpha = 1 - exp(-dt/tau)` rather than a fixed per-buffer weight, so the time constants
 * above stay true if `AUDIO_IN_CONFIG.bufferSize` ever changes or a buffer arrives late.
 */
function trackFloor(
  state: BargeInState,
  level: number,
  dt: number,
  tuning: BargeInTuning,
): number {
  if (dt <= 0) return state.noiseFloor
  if (level < state.noiseFloor) {
    return blend(state.noiseFloor, level, dt, tuning.floorFallMs)
  }
  // Probably a person, not the room. Freeze rather than let speech raise its own bar.
  if (level > state.noiseFloor * tuning.floorIgnoreFactor) return state.noiseFloor
  return blend(state.noiseFloor, level, dt, tuning.floorRiseMs)
}

function blend(from: number, to: number, dt: number, tauMs: number): number {
  const alpha = 1 - Math.exp(-dt / Math.max(1, tauMs))
  return from + (to - from) * alpha
}

/**
 * Fails fast on a tuning set that has been turned into a contradiction — the same contract as
 * `validateSpeechTuning` and `validateFaultThresholds`. These are frozen constants, so this
 * can only fire just after a human moved one by ear, which is exactly when a loud failure
 * beats a barge-in that has quietly become a hair trigger.
 */
export function validateBargeInTuning(tuning: BargeInTuning = BARGE_IN_TUNING): void {
  const problems: string[] = []
  const minHold = 2 * AUDIO_IN_BUFFER_PERIOD_MS
  if (!(tuning.holdMs >= minHold)) {
    problems.push(
      `holdMs (${tuning.holdMs}) must be at least two buffer periods (${minHold.toFixed(1)}ms) — ` +
        'one buffer must never be able to cut the coach off',
    )
  }
  if (!(tuning.triggerOverFloor > tuning.floorIgnoreFactor)) {
    problems.push(
      `triggerOverFloor (${tuning.triggerOverFloor}) must exceed floorIgnoreFactor ` +
        `(${tuning.floorIgnoreFactor}), or the floor tracker absorbs the speech that should trigger`,
    )
  }
  if (!(tuning.floorIgnoreFactor > 1)) {
    problems.push(`floorIgnoreFactor (${tuning.floorIgnoreFactor}) must be above 1`)
  }
  if (!(tuning.minTrigger > AUDIO_IN_CONFIG.silenceFloor)) {
    problems.push(
      `minTrigger (${tuning.minTrigger}) must exceed AUDIO_IN_CONFIG.silenceFloor ` +
        `(${AUDIO_IN_CONFIG.silenceFloor}) — a buffer below that floor is never even transmitted`,
    )
  }
  if (!(tuning.echoGuardFactor >= 1)) {
    problems.push(
      `echoGuardFactor (${tuning.echoGuardFactor}) must be at least 1; below 1 the guard would ` +
        'make the start of a line EASIER to interrupt, which is backwards',
    )
  }
  if (!(tuning.holdGateOpenMs > 0)) {
    problems.push(
      `holdGateOpenMs (${tuning.holdGateOpenMs}) must be positive, or the gate re-closes on the ` +
        'fade-out of the line it just interrupted',
    )
  }
  problems.push(...nonNegativeProblems(tuning))
  if (problems.length > 0) {
    throw new Error(`BARGE_IN_TUNING is inconsistent:\n - ${problems.join('\n - ')}`)
  }
}

function nonNegativeProblems(tuning: BargeInTuning): string[] {
  const out: string[] = []
  const fields: [name: string, value: number][] = [
    ['echoGuardMs', tuning.echoGuardMs],
    ['refractoryMs', tuning.refractoryMs],
    ['preRollMs', tuning.preRollMs],
  ]
  for (const [name, value] of fields) {
    if (!Number.isFinite(value) || value < 0) out.push(`${name} (${value}) must be >= 0`)
  }
  const positives: [name: string, value: number][] = [
    ['minTrigger', tuning.minTrigger],
    ['initialFloor', tuning.initialFloor],
    ['floorFallMs', tuning.floorFallMs],
    ['floorRiseMs', tuning.floorRiseMs],
    ['maxSampleGapBuffers', tuning.maxSampleGapBuffers],
  ]
  for (const [name, value] of positives) {
    if (!(value > 0)) out.push(`${name} (${value}) must be positive`)
  }
  return out
}

validateBargeInTuning()
