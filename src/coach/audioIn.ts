/**
 * Microphone uplink — the other half of the realtime conversation.
 *
 * Higgs Realtime is genuinely bidirectional: the session already advertises
 * `audio.input.format {type:'audio/pcm', rate:24000}` with `turn_detection:
 * {type:'server_vad'}`, but until now nothing ever sent a byte upstream, so the
 * coach could talk and never listen. This module closes that loop.
 *
 * WIRE FORMAT: base64-encoded 16-bit little-endian PCM, 24 kHz, mono, pushed as
 * `input_audio_buffer.append` events. Server-side VAD then decides where a turn
 * ends, so we do NOT commit or request a response ourselves — appending is the
 * whole contract.
 *
 * ── THE GATE ───────────────────────────────────────────────────────────────
 * The coach plays out of the same speakers the mic is listening to. Left open,
 * the mic hears the coach, server VAD scores it as a user turn, and the model
 * starts answering itself — a feedback loop that is fatal on stage and that no
 * amount of prompt work can fix.
 *
 * So the uplink is HALF-DUPLEX by design: `gateOpen` is consulted per buffer and
 * while it is false we simply stop appending. Server VAD sees a gap, which is
 * exactly right — we are asserting the user was not speaking, and while the coach
 * is talking over them that is true enough for a demo.
 *
 * The cost USED to be barge-in: you could not interrupt the coach mid-sentence,
 * because the interruption was never transmitted. It is now recoverable, and the
 * reason is that capture never stopped — only transmission did. While the gate is
 * shut this file still receives every buffer, measures its RMS, and offers it to
 * `onBuffer`; `bargeIn.ts` decides from those levels whether the user is really
 * talking, and `micUplink` then re-opens the gate. THE GATE IS RE-CONSULTED AFTER
 * `onBuffer` RETURNS, which is what lets the very buffer that proved the user was
 * speaking be the first one sent rather than the first one dropped.
 *
 * Music is deliberately NOT gated — see musicPlayer.ts. Gating on music would
 * mute the user for the whole track, so "stop the music" could never be heard.
 * Music ducks instead, and browser AEC handles the residue.
 *
 * Browser echo cancellation is requested as a second line of defence, since the
 * gate cannot cover the moment the coach starts mid-buffer — and it is now
 * LOAD-BEARING for barge-in, which can only tell the user apart from the coach
 * because the coach's voice is largely cancelled out of the captured signal. See
 * bargeIn.ts's header.
 */

/** Everything tunable in one place — this gets adjusted by ear, not by reasoning. */
export const AUDIO_IN_CONFIG = {
  /** Higgs expects 24 kHz. Asking the AudioContext for it avoids resampling. */
  sampleRate: 24_000,
  /**
   * ScriptProcessor buffer size. 2048 frames at 24 kHz is ~85 ms — small enough
   * that the gate reacts promptly, large enough not to flood the socket.
   */
  bufferSize: 2048,
  /**
   * Constraints. All three matter: echoCancellation is the backstop for speaker
   * bleed the gate misses, noiseSuppression kills gym/venue hum, and
   * autoGainControl keeps a distant user (on the floor doing pushups, metres from
   * the laptop) audible.
   */
  constraints: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  } satisfies MediaTrackConstraints,
  /** Below this RMS a buffer is treated as silence and skipped, to save bandwidth. */
  silenceFloor: 0.004,
} as const

/**
 * One capture buffer, in ms — ~85 ms at 2048 frames / 24 kHz.
 *
 * Derived here, in the file that owns both numbers, because three modules need it and a
 * hand-copied 85 is how a change to `bufferSize` silently shortens a timing window
 * somewhere else. Re-exported as `BUFFER_PERIOD_MS` by micUplink for its own callers.
 */
export const AUDIO_IN_BUFFER_PERIOD_MS =
  (AUDIO_IN_CONFIG.bufferSize / AUDIO_IN_CONFIG.sampleRate) * 1000

export type AudioInErrorCode = 'unsupported_browser' | 'mic_denied' | 'mic_failed'

export class AudioInError extends Error {
  readonly code: AudioInErrorCode
  constructor(code: AudioInErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AudioInError'
    this.code = code
  }
}

/**
 * One captured buffer offered to a monitor, gated or not. This is the seam barge-in
 * needs: the level of audio we are about to THROW AWAY is the only evidence that the
 * user is trying to interrupt.
 */
export interface AudioInBuffer {
  /**
   * 0..1 RMS of this buffer. Computed for EVERY buffer, including gated ones — that
   * is the change barge-in required, and it costs one pass over 2048 floats.
   */
  readonly level: number
  /** What `gateOpen()` said for this buffer, BEFORE the monitor ran. */
  readonly gated: boolean
  /**
   * base64 PCM16 of this buffer, for a monitor that wants to keep it (barge-in's
   * pre-roll does).
   *
   * SYNCHRONOUS ONLY. Web Audio reuses the underlying channel data as soon as the
   * callback returns, so a deferred call would encode whatever the next buffer put
   * there — silently, as plausible-looking audio. Calling it late therefore THROWS
   * rather than returning garbage.
   */
  takeBase64(): string
}

export interface AudioInOptions {
  /** Called with base64 PCM16 ready for `input_audio_buffer.append`. */
  readonly onChunk: (base64Pcm: string) => void
  /**
   * Consulted per buffer. Return false while the coach is speaking. Kept as a
   * predicate rather than a setter so the caller owns the truth and there is no
   * stale duplicate of "is the coach talking" to drift out of sync.
   *
   * Consulted TWICE when it says false and an `onBuffer` monitor is installed: once
   * before the monitor, once after. The second call is what lets barge-in claim the
   * buffer it triggered on instead of losing the user's first syllable.
   */
  readonly gateOpen: () => boolean
  /**
   * Every buffer, gated or not, before the gate decision is acted on. Optional: with
   * no monitor installed this file behaves exactly as it did, gate check first and
   * nothing encoded while shut.
   */
  readonly onBuffer?: (buffer: AudioInBuffer) => void
  readonly onError?: (error: AudioInError) => void
}

export interface AudioIn {
  start(): Promise<void>
  stop(): void
  /** 0..1 RMS of the most recent buffer, for a mic meter. 0 when gated or stopped. */
  level(): number
  /** True while capturing, regardless of gate state. */
  isCapturing(): boolean
  /** True when the last buffer was suppressed by the gate — drives a "muted" pill. */
  isGated(): boolean
}

function toBase64Pcm16(samples: Float32Array): string {
  const pcm = new Uint8Array(samples.length * 2)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a float above 1 would wrap to a large negative int16
    // and arrive as a loud click.
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  const CHUNK = 0x8000 // avoid blowing the argument limit on String.fromCharCode
  for (let i = 0; i < pcm.length; i += CHUNK) {
    binary += String.fromCharCode(...pcm.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Hands one buffer to the monitor with a lazily-encoded payload, then expires it.
 *
 * Lazy because most gated buffers are never kept: barge-in only wants the last few, so
 * encoding all of them would burn a btoa per 85 ms beside MediaPipe for nothing. Expired
 * afterwards because the alternative to throwing is a monitor that stores a closure over
 * a buffer Web Audio has already refilled, and gets back audio from the wrong moment —
 * plausible-sounding, wrong, and effectively undebuggable.
 *
 * A throwing monitor is reported and does NOT stop capture: barge-in is additive, and
 * losing the microphone because a detector had a bad buffer is a far worse outcome.
 */
function offerToMonitor(
  options: AudioInOptions,
  input: Float32Array,
  level: number,
  gated: boolean,
): void {
  let live = true
  const buffer: AudioInBuffer = {
    level,
    gated,
    takeBase64: () => {
      if (!live) {
        throw new AudioInError(
          'mic_failed',
          'takeBase64() was called after its buffer expired; encode inside onBuffer or not at all.',
        )
      }
      return toBase64Pcm16(input)
    },
  }
  try {
    options.onBuffer?.(buffer)
  } catch (cause) {
    options.onError?.(
      new AudioInError('mic_failed', 'A microphone buffer monitor threw; capture continues.', {
        cause,
      }),
    )
  } finally {
    live = false
  }
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0
    sum += s * s
  }
  return Math.sqrt(sum / (samples.length || 1))
}

export function createAudioIn(options: AudioInOptions): AudioIn {
  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let lastLevel = 0
  let gated = false
  let capturing = false

  async function start(): Promise<void> {
    if (capturing) return
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new AudioInError(
        'unsupported_browser',
        'This browser exposes no microphone API. A secure context (https or localhost) is required.',
      )
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_IN_CONFIG.constraints,
        video: false,
      })
    } catch (cause) {
      const denied =
        cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
      throw new AudioInError(
        denied ? 'mic_denied' : 'mic_failed',
        denied ? 'Microphone permission was denied.' : 'Could not open the microphone.',
        { cause },
      )
    }

    // Asking for 24 kHz up front means the browser resamples once, in native
    // code, instead of us doing it per buffer in JS.
    context = new AudioContext({ sampleRate: AUDIO_IN_CONFIG.sampleRate })
    if (context.state === 'suspended') await context.resume()

    source = context.createMediaStreamSource(stream)
    // ScriptProcessorNode is deprecated but universally present and synchronous,
    // and audioOut.ts already chose the same pragmatism over an AudioWorklet.
    // At 2048 frames of mono the main-thread cost is negligible.
    processor = context.createScriptProcessor(AUDIO_IN_CONFIG.bufferSize, 1, 1)

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      // Always measured, even when the gate is shut: a level we never compute is a
      // barge-in we can never detect. One pass over 2048 floats.
      const level = rms(input)
      const shut = !options.gateOpen()

      if (options.onBuffer) offerToMonitor(options, input, level, shut)

      // Re-consulted, deliberately: the monitor may have just opened the gate, and if
      // it did, THIS buffer is the start of the user's sentence.
      if (shut && !options.gateOpen()) {
        gated = true
        lastLevel = 0
        return
      }
      gated = false

      lastLevel = level
      if (level < AUDIO_IN_CONFIG.silenceFloor) return

      try {
        options.onChunk(toBase64Pcm16(input))
      } catch (cause) {
        options.onError?.(new AudioInError('mic_failed', 'Failed to forward a microphone buffer.', { cause }))
      }
    }

    source.connect(processor)
    // A ScriptProcessor only fires while connected to a destination. Routing it
    // through a zero gain keeps the graph alive without echoing the mic back out
    // of the speakers, which would be its own feedback loop.
    const mute = context.createGain()
    mute.gain.value = 0
    processor.connect(mute)
    mute.connect(context.destination)

    capturing = true
  }

  function stop(): void {
    capturing = false
    gated = false
    lastLevel = 0
    if (processor) {
      processor.onaudioprocess = null
      processor.disconnect()
      processor = null
    }
    source?.disconnect()
    source = null
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    void context?.close().catch(() => undefined)
    context = null
  }

  return {
    start,
    stop,
    level: () => lastLevel,
    isCapturing: () => capturing,
    isGated: () => gated,
  }
}
