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
 * The cost is barge-in: you cannot interrupt the coach mid-sentence, because the
 * interruption is never transmitted. That is a deliberate trade, chosen over a
 * mic that triggers itself.
 *
 * Music is deliberately NOT gated — see musicPlayer.ts. Gating on music would
 * mute the user for the whole track, so "stop the music" could never be heard.
 * Music ducks instead, and browser AEC handles the residue.
 *
 * Browser echo cancellation is requested as a second line of defence, since the
 * gate cannot cover the moment the coach starts mid-buffer.
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

export type AudioInErrorCode = 'unsupported_browser' | 'mic_denied' | 'mic_failed'

export class AudioInError extends Error {
  readonly code: AudioInErrorCode
  constructor(code: AudioInErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AudioInError'
    this.code = code
  }
}

export interface AudioInOptions {
  /** Called with base64 PCM16 ready for `input_audio_buffer.append`. */
  readonly onChunk: (base64Pcm: string) => void
  /**
   * Consulted per buffer. Return false while the coach is speaking. Kept as a
   * predicate rather than a setter so the caller owns the truth and there is no
   * stale duplicate of "is the coach talking" to drift out of sync.
   */
  readonly gateOpen: () => boolean
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

      if (!options.gateOpen()) {
        gated = true
        lastLevel = 0
        return
      }
      gated = false

      const level = rms(input)
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
