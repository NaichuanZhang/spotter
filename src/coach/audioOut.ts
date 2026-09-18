/**
 * Gapless playback of the 24 kHz mono PCM16 chunks Higgs streams back.
 *
 * Deliberately a scheduled-buffer queue and not an AudioWorklet: a worklet needs a
 * separate module file fetched at runtime (one more thing to break on a strange
 * network), and the only thing it buys here is sub-buffer latency we cannot use —
 * the pose-to-audio budget is already ~600 ms of network.
 *
 * The scheduling rule is the whole trick: every chunk starts exactly where the
 * previous one ended (`playhead`), never at `currentTime`. Starting at currentTime
 * is what produces the clicking, stuttering "robot voice" failure.
 *
 * This file has no imports on purpose — it is unit-testable with a fake
 * AudioContext and knows nothing about the coach protocol.
 */

/** Every tunable in one place; these get recalibrated on the demo laptop. */
export const AUDIO_CONFIG = {
  /** Higgs output rate. Must match session.audio.output.format.rate. */
  sampleRate: 24000,
  /** Cushion before the first chunk of an utterance, absorbs network jitter. */
  jitterBufferMs: 90,
  /** Barge-in fade, long enough to kill the click, short enough to feel instant. */
  fadeOutMs: 18,
  /** Waveform resolution for the UI meter. */
  analyserFftSize: 512,
  /** Refuse to queue more than this; a backlog this big means something is wrong. */
  maxQueuedSec: 20,
} as const

export interface AudioOutHooks {
  /** Non-fatal problems: dropped chunk, context still suspended, bad base64. */
  onWarn?: (message: string) => void
}

export interface AudioOutOptions extends AudioOutHooks {
  /** Injected for tests. Defaults to the platform AudioContext. */
  createContext?: () => AudioContext
}

export interface AudioOut {
  /** MUST be called from a user gesture (click/keydown) or playback stays muted. */
  unlock(): Promise<void>
  unlocked(): boolean
  /** Enqueue one base64 PCM16 chunk exactly as it arrived on the wire. */
  enqueue(base64Pcm16: string): void
  /** Barge-in: fade out, drop everything scheduled, reset the playhead. */
  stop(): void
  /** True while audio is playing or scheduled to play. */
  isSpeaking(): boolean
  /** Instantaneous RMS of what is audible right now, 0..1. Cheap; call per frame. */
  level(): number
  /** Seconds of audio still queued ahead of the clock. */
  queuedSec(): number
  close(): Promise<void>
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

/**
 * Web Audio's typings demand a non-shared backing buffer, so the concrete
 * `Float32Array<ArrayBuffer>` is load-bearing — a bare `Float32Array` (which TS
 * widens to ArrayBufferLike) will not compile against copyToChannel.
 */
type Pcm = Float32Array<ArrayBuffer>

function resolveContextCtor(): AudioContextCtor {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Ctor) throw new Error('Web Audio is unavailable in this browser; the coach cannot speak.')
  return Ctor
}

function defaultCreateContext(): AudioContext {
  const Ctor = resolveContextCtor()
  try {
    // Matching the stream rate natively avoids per-chunk resampling entirely.
    return new Ctor({ sampleRate: AUDIO_CONFIG.sampleRate, latencyHint: 'interactive' })
  } catch {
    // Some browsers refuse a forced rate. createBuffer() still accepts 24 kHz and
    // the graph resamples for us, so this fallback is fully functional.
    return new Ctor({ latencyHint: 'interactive' })
  }
}

/**
 * base64 PCM16 little-endian -> Float32 in [-1, 1).
 * Exported because it is the one piece of this file worth asserting on directly.
 */
export function decodeBase64Pcm16(base64: string): Pcm {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  // byteOffset is 0 (we allocated it), so an Int16Array view is safe. Every
  // platform that runs a browser is little-endian, which is what PCM16 wants.
  const sampleCount = bytes.byteLength >> 1
  const pcm = new Int16Array(bytes.buffer, 0, sampleCount)
  const out: Pcm = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i += 1) out[i] = pcm[i] / 32768
  return out
}

export function createAudioOut(options: AudioOutOptions = {}): AudioOut {
  const createContext = options.createContext ?? defaultCreateContext
  const warn = (message: string): void => options.onWarn?.(message)

  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let scope: Pcm | null = null
  let playhead = 0
  let warnedSuspended = false
  const active = new Set<AudioBufferSourceNode>()

  interface Graph {
    ctx: AudioContext
    gain: GainNode
    analyser: AnalyserNode
  }

  function ensureGraph(): Graph {
    if (ctx && gain && analyser) return { ctx, gain, analyser }
    const created = createContext()
    const createdGain = created.createGain()
    const createdAnalyser = created.createAnalyser()
    createdAnalyser.fftSize = AUDIO_CONFIG.analyserFftSize
    createdGain.connect(createdAnalyser)
    createdAnalyser.connect(created.destination)
    ctx = created
    gain = createdGain
    analyser = createdAnalyser
    scope = new Float32Array(createdAnalyser.fftSize)
    playhead = created.currentTime
    return { ctx: created, gain: createdGain, analyser: createdAnalyser }
  }

  async function unlock(): Promise<void> {
    const graph = ensureGraph()
    if (graph.ctx.state === 'running') return
    try {
      await graph.ctx.resume()
      warnedSuspended = false
      // The clock was frozen while suspended; re-anchor so nothing plays in the past.
      playhead = Math.max(playhead, graph.ctx.currentTime)
    } catch (error) {
      throw new Error(`Could not start audio playback: ${describe(error)}`)
    }
  }

  function enqueue(base64Pcm16: string): void {
    if (typeof base64Pcm16 !== 'string' || base64Pcm16.length === 0) {
      warn('ignored an empty audio chunk')
      return
    }
    let samples: Pcm
    try {
      samples = decodeBase64Pcm16(base64Pcm16)
    } catch (error) {
      warn(`undecodable audio chunk dropped: ${describe(error)}`)
      return
    }
    if (samples.length === 0) return

    const graph = ensureGraph()
    if (graph.ctx.state === 'suspended' && !warnedSuspended) {
      warnedSuspended = true
      // Chunks still queue correctly: a suspended context's clock does not advance,
      // so everything plays in order the moment unlock() runs.
      warn('audio context is suspended — call unlock() from a click to hear the coach')
    }
    if (queuedSec() > AUDIO_CONFIG.maxQueuedSec) {
      warn(`audio backlog over ${AUDIO_CONFIG.maxQueuedSec}s — chunk dropped`)
      return
    }
    scheduleChunk(graph, samples)
  }

  function scheduleChunk(graph: Graph, samples: Pcm): void {
    const buffer = graph.ctx.createBuffer(1, samples.length, AUDIO_CONFIG.sampleRate)
    buffer.copyToChannel(samples, 0)

    const earliest = graph.ctx.currentTime + AUDIO_CONFIG.jitterBufferMs / 1000
    // Re-anchor on a new utterance or after an underrun. Mid-utterance the playhead
    // is already ahead of `earliest`, so consecutive chunks stay sample-exact.
    if (playhead < earliest) playhead = earliest

    const source = graph.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(graph.gain)
    source.onended = () => {
      active.delete(source)
    }
    try {
      source.start(playhead)
    } catch (error) {
      warn(`could not schedule audio chunk: ${describe(error)}`)
      return
    }
    active.add(source)
    playhead += buffer.duration
  }

  function stop(): void {
    if (!ctx || !gain) return
    const now = ctx.currentTime
    const fade = AUDIO_CONFIG.fadeOutMs / 1000
    try {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0, now + fade)
      for (const source of active) source.stop(now + fade)
      // Restore unity gain just after the fade; every faded source is stopped by then.
      gain.gain.setValueAtTime(1, now + fade + 0.001)
    } catch (error) {
      warn(`barge-in was not clean: ${describe(error)}`)
    }
    active.clear()
    playhead = now + fade
  }

  function queuedSec(): number {
    if (!ctx) return 0
    return Math.max(0, playhead - ctx.currentTime)
  }

  function isSpeaking(): boolean {
    return queuedSec() > 0
  }

  function level(): number {
    if (!analyser || !scope || !isSpeaking()) return 0
    analyser.getFloatTimeDomainData(scope)
    let sum = 0
    for (let i = 0; i < scope.length; i += 1) sum += scope[i] * scope[i]
    return Math.min(1, Math.sqrt(sum / scope.length))
  }

  async function close(): Promise<void> {
    stop()
    const closing = ctx
    ctx = null
    gain = null
    analyser = null
    scope = null
    if (!closing) return
    try {
      await closing.close()
    } catch (error) {
      warn(`audio context did not close cleanly: ${describe(error)}`)
    }
  }

  return {
    unlock,
    unlocked: () => ctx?.state === 'running',
    enqueue,
    stop,
    isSpeaking,
    level,
    queuedSec,
    close,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
