/**
 * The uplink: microphone buffers on the wire, and the state the UI shows for them.
 *
 * audioIn.ts captures and gates; this module decides what a buffer means and puts it
 * on the socket. It exists as its own file because the three rules below are the
 * whole of two-way voice and they are easy to get wrong quietly:
 *
 * 1. APPEND, AND NOTHING ELSE. turn_detection is `server_vad`, so THE SERVER owns
 *    turn boundaries. We never send input_audio_buffer.commit and never send
 *    response.create for speech. Appending is the entire contract; adding a commit
 *    would cut the user off mid-sentence, and adding a response.create would make the
 *    coach answer twice. Confirmed live: the server emits
 *    `input_audio_buffer.committed` ITSELF once its VAD decides the turn ended.
 * 2. THE GATE IS THE COACH'S VOICE — UNLESS THE USER IS CLEARLY TALKING. `gateOpen`
 *    returns false while audioOut is speaking, because the mic and the speakers are in
 *    the same room: left open, the model hears itself, server VAD scores it as a user
 *    turn, and the coach starts answering its own last sentence. See audioIn.ts's
 *    header for why half-duplex is the right trade.
 *
 *    The one exception is BARGE-IN. Capture never stopped while the gate was shut — only
 *    transmission did — so the level of the buffers being discarded is evidence, and
 *    `bargeIn.ts` turns sustained evidence into a decision. On a trigger this module
 *    stops the coach (`interruptCoach`), force-holds the gate open for a bounded window,
 *    replays the pre-roll so the first words are not lost, and then resumes appending.
 *    Everything about it is guarded and switchable, because a coach that interrupts
 *    ITSELF is much worse than one you have to wait for: see BARGE_IN_TUNING.
 * 3. A DENIED MIC IS NOT AN OUTAGE. The pose-driven one-way coaching is the product;
 *    two-way is additive. `start()` therefore never rejects — it records the failure,
 *    reports it once, and leaves the app running with a visible OFF indicator.
 *
 * ── THE SILENCE FLUSH, AND THE MEASUREMENT THAT FORCED IT ───────────────────
 * Server VAD closes a turn on SILENCE IN THE STREAM, not on the absence of frames.
 * That distinction is the difference between a coach that answers and one that never
 * does, and it was measured against the live API by feeding prerecorded speech through
 * this exact path (see __tests__/liveUplink.test.ts):
 *
 *   clip ending in true DIGITAL SILENCE   -> speech_started, then NOTHING. No
 *                                            speech_stopped, no commit, no response.
 *                                            The coach sat mute with no error event.
 *   same clip + 1.6 s of room tone        -> speech_started, speech_stopped,
 *   at RMS 0.0115 (above the 0.004 floor)    input_audio_buffer.committed BY THE
 *                                            SERVER, then a play_music tool call and a
 *                                            spoken reply.
 *   digital-silence clip + 510 ms of      -> speech_started, and STILL no
 *   flushed zeros from this module           speech_stopped. Not enough.
 *   digital-silence clip + 1800 ms of     -> full loop: speech_stopped, committed,
 *   flushed zeros                            play_music({action:"play",track:"hype"}),
 *                                            reply spoken. So the server's hangover is
 *                                            somewhere in (0.51 s, 1.8 s]; the exact
 *                                            figure was not worth another session.
 *
 * The cause is audioIn's `silenceFloor`: a sub-floor buffer is skipped to save
 * bandwidth, so the tail of an utterance is never transmitted and the server is still
 * waiting for the user to stop talking. A real mic with autoGainControl almost always
 * sits above that floor on room noise, which is why this works at all in a browser —
 * but "almost always" is not a demo guarantee, and a mic muted in the OS, or one with
 * aggressive noise suppression, lands exactly on the broken case.
 *
 * So once the buffers stop arriving, this module appends a bounded run of digital
 * silence itself. It is cheap (~5.5 KB per buffer), it is self-limiting, and it makes
 * the end of a turn explicit instead of inferred.
 */

import { AUDIO_IN_BUFFER_PERIOD_MS, AUDIO_IN_CONFIG, AudioInError, createAudioIn } from './audioIn'
import type { AudioIn, AudioInBuffer, AudioInErrorCode, AudioInOptions } from './audioIn'
import {
  BARGE_IN_TUNING,
  gateHeldOpen,
  INITIAL_BARGE_IN,
  observeLevel,
  preRollBuffers,
  triggerLevel,
} from './bargeIn'
import type { BargeInState, BargeInTuning } from './bargeIn'

export const UPLINK_CONFIG = {
  /**
   * Server cap for one input_audio_buffer.append event. A 2048-frame mono buffer is
   * 4 KiB of PCM, ~5.5 KB of base64, so nothing we generate comes near it — this
   * exists because the limit is a documented boundary and an unchecked one is how a
   * future larger bufferSize turns into a silent server-side reject.
   */
  maxAppendBytes: 1024 * 1024,
  /**
   * How long after a passed buffer the mic still counts as ARMED. At
   * AUDIO_IN_CONFIG.bufferSize frames a buffer lands every ~85 ms, so this spans the
   * gaps between words (and the sub-silenceFloor buffers that get skipped) without
   * letting the music un-duck and re-duck between syllables.
   */
  armedHoldMs: 400,
  /**
   * How much digital silence to append after the mic falls quiet, in ms. MEASURED, and
   * the first guess was wrong: ~510 ms of zeros produced speech_started and still no
   * speech_stopped, where 1.6 s of room tone closed the turn. So the server's hangover
   * is longer than half a second and this has to cover it with margin. Bounded, so a
   * silent room streams at most this much and then goes genuinely idle; the budget is
   * reset by every real buffer, i.e. once per user turn.
   */
  silenceFlushMs: 1_800,
  /**
   * A gap this long counts as "the mic has fallen quiet". One buffer period is ~85 ms,
   * so 150 ms is past the jitter of a single late buffer without adding audible delay
   * to the end of a turn.
   */
  silenceGapMs: 150,
  /** How often the flush condition is checked. Well inside silenceGapMs. */
  flushCheckMs: 50,
} as const

/** The one wire event this module sends. Named so a test can assert on it. */
export const AUDIO_APPEND_EVENT = 'input_audio_buffer.append'

/** base64 is ASCII, so its string length IS its byte length on the wire. */
export function buildAudioAppend(base64Pcm: string): Record<string, unknown> {
  return { type: AUDIO_APPEND_EVENT, audio: base64Pcm }
}

export function isWithinAppendLimit(base64Pcm: string): boolean {
  return base64Pcm.length > 0 && base64Pcm.length <= UPLINK_CONFIG.maxAppendBytes
}

/**
 * One audioIn buffer, in ms. ~85 ms at 2048 frames / 24 kHz. Derived in audioIn, which owns
 * both numbers, and re-exported here because this module's callers already import it.
 */
export const BUFFER_PERIOD_MS = AUDIO_IN_BUFFER_PERIOD_MS

/** Derived, never hand-counted, so changing bufferSize cannot silently shorten the flush. */
export const SILENCE_FLUSH_BUFFERS = Math.ceil(UPLINK_CONFIG.silenceFlushMs / BUFFER_PERIOD_MS)

/** 0x00, built this way so no raw NUL byte ever sits in this source file. */
const NUL = String.fromCharCode(0)

/**
 * `frames` samples of PCM16 ZEROS as base64 — the silence the server has to SEE before
 * it will close a turn. Zero bytes, not spaces: 0x20 repeated decodes to a constant
 * sample value of 8224, which is a loud DC offset rather than silence.
 */
export function silenceFrame(frames: number): string {
  return btoa(NUL.repeat(frames * 2))
}

export interface MicFailure {
  readonly code: AudioInErrorCode
  readonly message: string
}

/** What the HUD needs to distinguish LISTENING from MUTED from OFF. */
export interface MicState {
  /** The capture graph is running, whatever the gate is doing. */
  readonly capturing: boolean
  /** The last buffer was suppressed because the coach is speaking. Expected, not an error. */
  readonly gated: boolean
  /** Capturing, un-gated, and a buffer went upstream within armedHoldMs. */
  readonly armed: boolean
  /** 0..1 RMS of the last passed buffer. 0 while gated or stopped. */
  readonly level: number
  /** Non-null once the mic has failed. Never cleared by anything but a restart. */
  readonly error: MicFailure | null
}

export const MIC_OFF: MicState = Object.freeze({
  capturing: false,
  gated: false,
  armed: false,
  level: 0,
  error: null,
})

export interface MicUplinkOptions {
  /**
   * Puts one frame on the socket. Returns false when there is nothing open to send
   * on, which is normal (pre-connect, mid-reconnect) and must not be reported as an
   * error — a dropped buffer during a reconnect is a gap in a turn the server has
   * already abandoned.
   */
  readonly send: (frame: Record<string, unknown>) => boolean
  /** audioOut.isSpeaking(). Consulted per buffer; false closes the gate. */
  readonly isCoachSpeaking: () => boolean
  /**
   * ARMS BARGE-IN. Called once per trigger, and it must be a FULL interrupt: stop what is
   * playing, drop what is queued, AND discard the remainder of the response the server is
   * still streaming. `session.ts`'s own `interrupt(reason, force)` does all three; plain
   * `audio.stop()` does only the first two, and the coach would resume mid-sentence a
   * moment later as the next deltas arrive.
   *
   * OMITTING IT DISABLES BARGE-IN, deliberately. Opening the gate without silencing the
   * coach is the exact feedback loop the gate exists to prevent — the model would hear
   * itself and answer its own sentence — so this module refuses to open the gate when it
   * has no way to stop the voice.
   *
   * Called once per trigger, and triggers are rate-limited by `BARGE_IN_TUNING.refractoryMs`
   * because the shipped hook's side effects (a 6 s discard window, a policy silence marker)
   * are not idempotent. Normally that means exactly one call per interruption: the coach
   * falls silent, so there is nothing left to barge into.
   */
  readonly interruptCoach?: () => void
  /** Overridden in tests; defaults to BARGE_IN_TUNING. The master switch lives in there. */
  readonly bargeInTuning?: BargeInTuning
  /** Reported once per distinct failure, never swallowed. */
  readonly onFailure?: (failure: MicFailure) => void
  readonly onDebug?: (message: string) => void
  /** Injected in tests, which have no getUserMedia. */
  readonly createAudioIn?: (options: AudioInOptions) => AudioIn
  /** Injected in tests. */
  readonly now?: () => number
  /** Injected in tests. Defaults to the platform timer. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface MicUplink {
  /** Never rejects. A failure lands in state() and onFailure instead. */
  start(): Promise<void>
  stop(): void
  state(): MicState
  /**
   * The barge-in detector's state: tracked noise floor, trigger count, and how many
   * triggers the echo guard held back. Read-only, for tests and for a human deciding
   * whether this room needs `BARGE_IN_TUNING.enabled = false`. Deliberately NOT part of
   * `MicState`, which is a UI contract read by three components and compared field by
   * field in duckLoop.
   */
  bargeIn(): BargeInState
}

export function createMicUplink(options: MicUplinkOptions): MicUplink {
  const now = options.now ?? (() => Date.now())
  const makeAudioIn = options.createAudioIn ?? createAudioIn
  const schedule = options.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const unschedule = options.clearInterval ?? ((handle) => clearInterval(handle as never))
  const silence = silenceFrame(AUDIO_IN_CONFIG.bufferSize)

  const tuning = options.bargeInTuning ?? BARGE_IN_TUNING
  /**
   * Barge-in is armed only when there is a way to SILENCE the coach. Without the hook,
   * opening the gate would hand the model its own voice — see `interruptCoach`.
   */
  const bargeInArmed = tuning.enabled && typeof options.interruptCoach === 'function'
  const preRollCap = bargeInArmed ? preRollBuffers(tuning) : 0

  let audioIn: AudioIn | null = null
  let failure: MicFailure | null = null
  let lastSentAt = Number.NEGATIVE_INFINITY
  let flushBudget = 0
  let flushTimer: unknown = null
  let barge: BargeInState = INITIAL_BARGE_IN
  /**
   * The last few GATED buffers, oldest first, already base64-encoded. Flushed ahead of the
   * triggering buffer so the user's first words survive the hold window; bounded by
   * `preRollCap`, so a long coach utterance cannot grow it.
   */
  let preRoll: string[] = []

  /**
   * The gate, and the single most important line in two-way voice. False while the
   * coach is audible, so the model cannot hear itself through the speakers — except
   * inside a barge-in window, which is the user's own interruption being let through.
   */
  function gateOpen(): boolean {
    if (!options.isCoachSpeaking()) return true
    return bargeInArmed && gateHeldOpen(barge, now())
  }

  /**
   * Every buffer audioIn captures, gated or not. Three jobs, in this order: feed the
   * detector, act on a trigger, and otherwise keep the pre-roll fresh.
   *
   * The trigger path deliberately does NOT push the current buffer into the pre-roll —
   * audioIn re-consults the gate straight after this returns and sends it through
   * `onChunk`, so storing it here would transmit the same 85 ms twice.
   */
  function onBuffer(buffer: AudioInBuffer): void {
    if (!bargeInArmed) return
    const at = now()
    const outcome = observeLevel(barge, { level: buffer.level, coachSpeaking: options.isCoachSpeaking(), at }, tuning)
    barge = outcome.state

    if (outcome.trigger) {
      fireBargeIn(buffer.level, at)
      return
    }
    if (outcome.reason === 'suspected-echo') {
      options.onDebug?.(
        `suspected echo, not barge-in: level ${buffer.level.toFixed(4)} inside the ` +
          `${tuning.echoGuardMs}ms guard (bar ${triggerLevel(barge, at, tuning).toFixed(4)})`,
      )
    }
    rememberPreRoll(buffer)
  }

  /** Stop the coach, hold the gate open, and replay what the user already said. */
  function fireBargeIn(level: number, at: number): void {
    options.onDebug?.(
      `barge-in: level ${level.toFixed(4)} held ${tuning.holdMs}ms over ` +
        `${triggerLevel(barge, at, tuning).toFixed(4)} (floor ${barge.noiseFloor.toFixed(4)})`,
    )
    try {
      options.interruptCoach?.()
    } catch (cause) {
      // Never swallowed, and never fatal: the gate is already held open, so the user is
      // being heard even if the coach could not be silenced. The room will sound bad; a
      // thrown error here would additionally cost the microphone.
      options.onFailure?.({
        code: 'mic_failed',
        message: `barge-in could not stop the coach: ${describe(cause)}`,
      })
    }
    flushPreRoll()
  }

  /** Bounded ring of gated buffers; anything the gate let through needs no pre-roll. */
  function rememberPreRoll(buffer: AudioInBuffer): void {
    if (preRollCap === 0) return
    if (!buffer.gated) {
      if (preRoll.length > 0) preRoll = []
      return
    }
    // Sub-floor buffers are the ones audioIn would never transmit anyway; keeping them
    // would spend the ring on room tone instead of on the user's first syllable.
    if (buffer.level < AUDIO_IN_CONFIG.silenceFloor) return
    // Encoded HERE, synchronously: takeBase64() expires when onBuffer returns.
    const next = preRoll.concat(buffer.takeBase64())
    preRoll = next.length > preRollCap ? next.slice(next.length - preRollCap) : next
  }

  function flushPreRoll(): void {
    const pending = preRoll
    preRoll = []
    // In order, oldest first, and through the same accounting as a live buffer so the
    // silence flush treats the barged-in turn as the live turn it is.
    for (const frame of pending) sendAudio(frame)
    if (pending.length > 0) {
      options.onDebug?.(`replayed ${pending.length} pre-roll buffers so the first words survive`)
    }
  }

  function onChunk(base64Pcm: string): void {
    sendAudio(base64Pcm)
  }

  function sendAudio(base64Pcm: string): void {
    if (!isWithinAppendLimit(base64Pcm)) {
      // Not fatal and not silent: dropping one 85 ms buffer costs a syllable, where
      // sending an oversized event costs the whole turn.
      options.onDebug?.(`dropped a ${base64Pcm.length}-byte mic buffer: over the append limit`)
      return
    }
    // NO commit and NO response.create. server_vad owns the turn.
    if (!options.send(buildAudioAppend(base64Pcm))) return
    lastSentAt = now()
    // Real audio arrived, so the turn is live again and gets a fresh flush budget.
    flushBudget = SILENCE_FLUSH_BUFFERS
  }

  /**
   * Appends the trailing silence audioIn's silence floor swallowed, so the server can
   * see the end of the turn. Bounded by flushBudget, so a quiet room sends at most
   * silenceFlushBuffers frames and then goes genuinely idle.
   */
  function flushSilence(): void {
    if (flushBudget <= 0) return
    if (!audioIn?.isCapturing()) return
    // Gated means the coach is talking, which means the server already closed this
    // turn to produce that speech. Appending into it would be noise on a dead turn.
    if (audioIn.isGated()) return
    if (now() - lastSentAt < UPLINK_CONFIG.silenceGapMs) return
    if (!options.send(buildAudioAppend(silence))) return
    flushBudget -= 1
    if (flushBudget === 0) {
      options.onDebug?.(`flushed ${UPLINK_CONFIG.silenceFlushMs}ms of silence to close the turn`)
    }
  }

  function recordFailure(error: AudioInError): void {
    failure = { code: error.code, message: error.message }
    options.onFailure?.(failure)
  }

  async function start(): Promise<void> {
    if (audioIn?.isCapturing()) return
    const created = makeAudioIn({
      onChunk,
      gateOpen,
      // Installed only when barge-in is armed, so an un-armed session keeps audioIn on
      // its original path: gate first, nothing encoded while shut.
      onBuffer: bargeInArmed ? onBuffer : undefined,
      // A per-buffer failure (a send that threw) is reported but does not stop
      // capture: the next buffer may well work, and stopping would need a gesture
      // to restart.
      onError: (error) => recordFailure(error),
    })
    audioIn = created
    try {
      await created.start()
      failure = null
      if (flushTimer === null) flushTimer = schedule(flushSilence, UPLINK_CONFIG.flushCheckMs)
      options.onDebug?.(
        `mic uplink armed at ${AUDIO_IN_CONFIG.sampleRate} Hz, barge-in ` +
          (bargeInArmed
            ? `on (hold ${tuning.holdMs}ms, ${tuning.triggerOverFloor}x room, ` +
              `pre-roll ${preRollCap} buffers)`
            : tuning.enabled
              ? 'OFF: no interruptCoach hook was supplied, so the coach cannot be silenced'
              : 'OFF by BARGE_IN_TUNING.enabled'),
      )
    } catch (cause) {
      audioIn = null
      recordFailure(
        cause instanceof AudioInError
          ? cause
          : new AudioInError('mic_failed', 'The microphone could not be started.', { cause }),
      )
    }
  }

  function stop(): void {
    audioIn?.stop()
    audioIn = null
    lastSentAt = Number.NEGATIVE_INFINITY
    flushBudget = 0
    // The room, the hold and any held-open gate all belong to the capture that just ended:
    // a restart must not inherit a window that would let the first buffer through, nor a
    // pre-roll recorded minutes ago.
    barge = INITIAL_BARGE_IN
    preRoll = []
    if (flushTimer !== null) {
      unschedule(flushTimer)
      flushTimer = null
    }
  }

  function state(): MicState {
    const capturing = audioIn?.isCapturing() ?? false
    const gated = capturing && (audioIn?.isGated() ?? false)
    return {
      capturing,
      gated,
      armed: capturing && !gated && now() - lastSentAt < UPLINK_CONFIG.armedHoldMs,
      level: capturing ? (audioIn?.level() ?? 0) : 0,
      error: failure,
    }
  }

  return { start, stop, state, bargeIn: () => barge }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
