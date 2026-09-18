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
 * 2. THE GATE IS THE COACH'S VOICE. `gateOpen` returns false while audioOut is
 *    speaking, because the mic and the speakers are in the same room: left open, the
 *    model hears itself, server VAD scores it as a user turn, and the coach starts
 *    answering its own last sentence. See audioIn.ts's header for why half-duplex is
 *    the right trade and what it costs (no barge-in).
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

import { AUDIO_IN_CONFIG, AudioInError, createAudioIn } from './audioIn'
import type { AudioIn, AudioInErrorCode, AudioInOptions } from './audioIn'

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

/** One audioIn buffer, in ms. ~85 ms at 2048 frames / 24 kHz. */
export const BUFFER_PERIOD_MS = (AUDIO_IN_CONFIG.bufferSize / AUDIO_IN_CONFIG.sampleRate) * 1000

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
}

export function createMicUplink(options: MicUplinkOptions): MicUplink {
  const now = options.now ?? (() => Date.now())
  const makeAudioIn = options.createAudioIn ?? createAudioIn
  const schedule = options.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const unschedule = options.clearInterval ?? ((handle) => clearInterval(handle as never))
  const silence = silenceFrame(AUDIO_IN_CONFIG.bufferSize)

  let audioIn: AudioIn | null = null
  let failure: MicFailure | null = null
  let lastSentAt = Number.NEGATIVE_INFINITY
  let flushBudget = 0
  let flushTimer: unknown = null

  /**
   * The gate, and the single most important line in two-way voice. False while the
   * coach is audible, so the model cannot hear itself through the speakers.
   */
  function gateOpen(): boolean {
    return !options.isCoachSpeaking()
  }

  function onChunk(base64Pcm: string): void {
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
      options.onDebug?.(`mic uplink armed at ${AUDIO_IN_CONFIG.sampleRate} Hz`)
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

  return { start, stop, state }
}
