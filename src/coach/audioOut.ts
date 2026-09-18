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

/**
 * Every tunable in one place; these get recalibrated on the demo laptop.
 *
 * The dynamics half of this object is the ONLY loudness control that exists in
 * this product. Measured against the live Higgs API: there is no volume and no
 * gain parameter — eleven plausible field names (`volume`, `gain`, `loudness`,
 * `energy`, `expressiveness`, …) are silently dropped and are indistinguishable
 * in the session echo from a field literally named `totally_made_up_xyz`, and
 * `volume: 2.0` / `gain: 6` were measured acoustically as no-ops. So per-utterance
 * loudness has to be manufactured here, in the browser.
 *
 * It cannot be a plain multiply: `jake` and `eleanor` were both measured at
 * peak = 1.0 (digital full scale, eleanor at 1.000 and 0.988 on separate takes).
 * There is literally zero headroom, so `sample * 1.35` clips. The compressor's job
 * is to MANUFACTURE the headroom — pull the crest down — and the makeup gain then
 * spends it.
 *
 * THE BUDGET, measured through this exact graph on an OfflineAudioContext with
 * speech-like input at peak 1.0, RMS 0.209, crest 4.78 (the report's loudest rung):
 * the compressor takes crest 4.78 → 3.73, and that is the ENTIRE free lunch —
 * +1.68 dB of RMS at the same peak. Past that, loudness is a zero-sum trade against
 * the ordinary line: the severe line can only be N dB louder if the ordinary line
 * gives up (N − 1.68) dB. That is not a tuning failure, it is arithmetic. With the
 * input already at full scale, more RMS REQUIRES less crest, and a compressor can
 * only take so much crest out of speech before it stops sounding like speech.
 * `emphasisNormal`/`emphasisHot` are where that trade is spent: 3.52 dB apart, which
 * lands the ordinary line 1.84 dB below the raw stream and the severe line 1.68 dB
 * above it.
 *
 * PROVENANCE, because it matters for the compressor numbers: the measurements were
 * taken on node-web-audio-api's OfflineAudioContext, which ports the same WebKit
 * DynamicsCompressorKernel that Chrome and Firefox both derive from — including the
 * undocumented internal makeup gain that makes a slow attack overshoot full scale.
 * That is the same algorithm, but it is NOT a browser, and it was measured on
 * synthetic speech-like signal rather than on real Higgs audio. Treat the parameter
 * RANKING as solid and the third decimal place as indicative.
 *
 * Nobody can verify PERCEIVED loudness from a shell. Every number below is measured
 * for RMS, peak and crest and proven not to clip; whether it SOUNDS right is an ear
 * question, and this is the one place to answer it — change these, not the graph.
 */
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

  // ── Dynamics: compressor + makeup gain ──────────────────────────────────────
  // Every number here came off a measured one-parameter sweep through a real
  // DynamicsCompressorNode, not off a rule of thumb. Each sweep is quoted WITH the
  // conditions it was run under, so the next person can move a value knowing which
  // direction costs what. All of them use speech-like input normalised to peak 1.0,
  // and all crest figures are peak/RMS of the output.

  /**
   * Threshold, dBFS. The report's measured persona RMS spans −19.1 dBFS (`oliver`,
   * 0.111) to −13.6 dBFS (`jake` on the LOUD rung, 0.210), so −16 sits INSIDE that
   * band: the loudest lines are compressed on their average, the quietest only on
   * their peaks.
   *
   * Sweep at ratio 8, attack 0.1 ms, release 120 ms, on the crest-4.78 input —
   * output crest, and the compressor's own output peak:
   *   −10 → 3.79 / 0.868    −13 → 3.76 / 0.782    −16 → 3.75 / 0.701
   *   −20 → 3.75 / 0.604    −26 → 3.75 / 0.478
   * Crest saturates from about −13 down, so the threshold does not really choose how
   * much compression you get — it chooses how much of the total gain lives in the
   * compressor's own internal makeup versus in `emphasisNormal`/`emphasisHot`. −16 is
   * picked because it leaves `emphasisNormal` near unity with room to move BOTH ways.
   */
  compressorThresholdDb: -16,
  /**
   * 8:1. Sweep at threshold −18, knee 3, attack 0.05 ms, release 120 ms — output
   * crest, and the RMS that then fits under a 0.95 peak:
   *   2 → 4.09 / 0.232   4 → 3.77 / 0.252   6 → 3.67 / 0.259   8 → 3.62 / 0.263
   *   12 → 3.57 / 0.267  16 → 3.54 / 0.268  20 → 3.53 / 0.270
   * It saturates. 8:1 captures 90% of what 20:1 gets (+1.97 dB vs +2.18 dB against
   * the raw stream) without being a brick wall on the consonants that carry a drill
   * sergeant's intelligibility. Below 4:1 the peak control gets too loose to trust.
   */
  compressorRatio: 8,
  /**
   * 3 dB knee, and measured as NOT load-bearing: at threshold −30, ratio 20,
   * attack 0.05 ms, knee 0 / 3 / 6 gave output crest 3.519 / 3.520 / 3.519 —
   * indistinguishable. A small soft knee is kept only because speech crosses the
   * threshold once per syllable and a hard knee makes that crossing the most likely
   * place to hear the compressor working. WebAudio's default of 30 dB is far too
   * wide: it would smear compression from −31 dBFS upward, across the whole signal.
   */
  compressorKneeDb: 3,
  /**
   * 0.1 ms. THE dominant parameter and the counter-intuitive one. Sweep at
   * threshold −18, ratio 20, release 120 ms — output crest, output peak, and the dB
   * of RMS that then fits under a 0.95 peak versus the raw stream:
   *   0 ms   → 3.26 / 0.54 / +2.9      0.05 ms → 3.53 / 0.59 / +2.2
   *   0.1 ms → 3.71 / 0.63 / +1.8      0.5 ms  → 4.41 / 0.80 / +0.2
   *   2 ms   → 5.33 / 1.07 / −1.4      4 ms    → 5.93 / 1.31 / −2.3
   * A textbook 3–4 ms speech attack is actively HARMFUL here: it makes the output
   * crest WORSE than the input's 4.78 and lets peaks through at 1.07 and 1.31 — OVER
   * full scale, from a compressor — because WebAudio's DynamicsCompressorNode
   * applies an internal makeup gain (measured: +3.5 dB of free gain on sub-threshold
   * signal at −10/6:1) that is already live during the attack window while the gain
   * reduction is not yet. Reducing a WAVEFORM's crest needs an attack far shorter
   * than one pitch period (8.2 ms at `jake`'s measured F0 of 122 Hz), which makes
   * this a peak limiter by construction. 0.1 ms is inside normal limiter practice;
   * 0 is the degenerate maximum and is deliberately left on the table.
   */
  compressorAttackSec: 0.0001,
  /**
   * 120 ms, and this is the one parameter with a genuine interior optimum rather
   * than a monotone curve. Sweep at threshold −18, ratio 20, attack 0.05 ms —
   * output crest: 30 ms → 4.06, 60 → 3.67, 120 → 3.53, 200 → 3.54, 350 → 3.66,
   * 600 → 3.88. Too short and the gain recovers inside a syllable, which is the
   * audible pumping; too long and the reduction from one loud syllable is still
   * held down over the next quiet one.
   */
  compressorReleaseSec: 0.12,
  /**
   * The hard non-clipping budget, and the reason `emphasisHot` is 1.35 and not 2.
   * Measured worst case through this graph is a compressor output peak of 0.701
   * (threshold −16, the crest-4.78 input at peak 1.0), so the makeup gain must stay
   * under 0.95 / 0.701 = 1.355. The offline verification asserts rendered peak <
   * this, which means raising `emphasisHot` for a louder bark turns a test red
   * instead of clipping the demo. 0.95 rather than 1.0 keeps ~0.4 dB back for the
   * browser's own resampling when the device does not run at 24 kHz.
   */
  peakCeiling: 0.95,
  /**
   * Makeup gain for an ordinary line. Under unity on purpose: this is the headroom
   * the ordinary line gives up so the severe line has somewhere to go. Measured
   * end to end on the crest-4.78 input: base RMS 0.1693 against the raw stream's
   * 0.2093, i.e. 1.84 dB quieter — but at crest 3.73 instead of 4.78, so it is
   * denser and more forward at that lower RMS. If the coach is simply too quiet on
   * the demo laptop, the fix is the system volume, or raise this AND `emphasisHot`
   * together and let the peak-ceiling assertion catch you.
   */
  emphasisNormal: 0.9,
  /**
   * Makeup gain for a SEVERE-fault line. +3.52 dB over `emphasisNormal` as measured
   * end to end (RMS 0.1693 → 0.2539 with peak 0.947), comfortably past the ~1 dB
   * loudness JND, and the largest step available without pushing the ordinary line
   * down further.
   *
   * AFTER the compressor, not before — and that ordering was measured, not assumed.
   * Driving the compressor harder instead does almost nothing, because the
   * compressor eats it: +13 dB of pre-compressor drive produced +0.65 dB of output
   * (a 20:1 ratio divides the drive by 20, and the ratio is what makes the peak
   * safe in the first place). Post-compressor the gain is a real level change, and
   * it is safe because the compressor has already bounded the peak it multiplies.
   */
  emphasisHot: 1.35,
  /**
   * Ramp length for an emphasis change. A bare `.value =` assignment is a step
   * discontinuity and clicks. Measured, by recovering the applied gain sample by
   * sample from a source→gain→destination render: the ramp moves 0.9 → 1.35 over
   * 863 samples (36.0 ms of the configured 40) at 0.000469 per sample, while
   * `.value =` moves the whole 0.45 between two ADJACENT samples at the next render
   * quantum. 40 ms is inaudible as a ramp and still finishes inside the 90 ms jitter
   * buffer, so the first syllable of a severe line is already hot.
   */
  emphasisRampMs: 40,
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
  /**
   * Lift playback loudness for a severe-fault line, then drop back. Ramped, never
   * stepped. Safe to call before the graph exists and before/while audio streams:
   * the value is remembered and applied to whatever plays next. The caller owns
   * both edges — set it when pushing the event, clear it on `response.done`.
   */
  setEmphasis(hot: boolean): void
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
  let compressor: DynamicsCompressorNode | null = null
  let emphasis: GainNode | null = null
  let gain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let scope: Pcm | null = null
  let playhead = 0
  let warnedSuspended = false
  /** Survives graph teardown so an emphasis set before unlock() is not lost. */
  let wantsEmphasis = false
  const active = new Set<AudioBufferSourceNode>()

  interface Graph {
    ctx: AudioContext
    /** Head of the chain. Every scheduled chunk enters HERE, not at `gain`. */
    compressor: DynamicsCompressorNode
    /** Makeup gain, and the only loudness lever in the product. */
    emphasis: GainNode
    /** Barge-in fade only. `stop()` ramps this to 0 and back to 1. */
    gain: GainNode
    analyser: AnalyserNode
  }

  /**
   * source → compressor → emphasis → gain → analyser → destination
   *
   * Three things about this order are load-bearing:
   *
   * 1. The compressor is FIRST, so its threshold is expressed against the stream's
   *    own measured levels (persona RMS 0.111–0.210 at peak 1.0) and nothing
   *    upstream can move the signal relative to it.
   * 2. `emphasis` is AFTER the compressor. Measured: a pre-compressor boost is
   *    swallowed by the ratio (+13 dB in → +0.65 dB out), and post-compressor is
   *    safe precisely because the compressor has already bounded the peak.
   * 3. `emphasis` and `gain` are separate nodes even though both are GainNodes.
   *    `gain` belongs to barge-in, which ramps it to 0 and back to *1*; folding
   *    makeup into it would have `stop()` silently reset loudness to unity.
   *
   * `analyser` stays last so `level()` — the UI's persona rim light — keeps
   * reporting what is actually audible, now including the compression and gain.
   */
  function ensureGraph(): Graph {
    if (ctx && compressor && emphasis && gain && analyser) {
      return { ctx, compressor, emphasis, gain, analyser }
    }
    const created = createContext()
    const createdCompressor = created.createDynamicsCompressor()
    const createdEmphasis = created.createGain()
    const createdGain = created.createGain()
    const createdAnalyser = created.createAnalyser()

    configureCompressor(createdCompressor, created.currentTime)
    // Initial values, set before anything is connected or playing. A ramp would be
    // meaningless here; the no-bare-assignment rule applies to CHANGES (setEmphasis).
    createdEmphasis.gain.value = emphasisTarget()
    createdAnalyser.fftSize = AUDIO_CONFIG.analyserFftSize

    createdCompressor.connect(createdEmphasis)
    createdEmphasis.connect(createdGain)
    createdGain.connect(createdAnalyser)
    createdAnalyser.connect(created.destination)

    ctx = created
    compressor = createdCompressor
    emphasis = createdEmphasis
    gain = createdGain
    analyser = createdAnalyser
    scope = new Float32Array(createdAnalyser.fftSize)
    playhead = created.currentTime
    return {
      ctx: created,
      compressor: createdCompressor,
      emphasis: createdEmphasis,
      gain: createdGain,
      analyser: createdAnalyser,
    }
  }

  function emphasisTarget(): number {
    return wantsEmphasis ? AUDIO_CONFIG.emphasisHot : AUDIO_CONFIG.emphasisNormal
  }

  /**
   * Ramped, never stepped: `AudioParam.value = x` is a step discontinuity in the
   * signal and clicks (measured: it moves the whole gain change between two adjacent
   * samples, where the ramp spreads it over 863).
   *
   * The change is scheduled at the PLAYHEAD, not at `currentTime`, and that is not a
   * detail. Playback runs behind generation by the whole queue — measured at 0.3–2.5 s
   * of scheduled audio — so the caller's natural "clear it on response.done" would
   * otherwise de-emphasise the severe line partway through the very sentence it was
   * turned on for. Anchoring at the playhead means an emphasis change applies to
   * audio that has not been scheduled yet, i.e. to the next utterance, which is
   * exactly what an utterance-level control should mean. Whatever is already queued
   * belongs to the previous line and keeps the setting it was spoken with.
   *
   * Three events, in order, because a bare ramp after a setValueAtTime would
   * interpolate across the whole wait instead of holding and then ramping:
   *   cancel   — drop any change that has not taken effect yet; the last caller wins
   *   hold     — pin the CURRENT value (so a reversal mid-ramp starts where it is,
   *              not where the last scheduled ramp began) through to the playhead
   *   ramp     — travel to the new value over emphasisRampMs
   */
  function setEmphasis(hot: boolean): void {
    wantsEmphasis = hot
    if (!emphasis || !ctx) return
    const now = ctx.currentTime
    const startAt = Math.max(now, playhead)
    const ramp = AUDIO_CONFIG.emphasisRampMs / 1000
    try {
      emphasis.gain.cancelScheduledValues(now)
      emphasis.gain.setValueAtTime(emphasis.gain.value, now)
      if (startAt > now) emphasis.gain.setValueAtTime(emphasis.gain.value, startAt)
      emphasis.gain.linearRampToValueAtTime(emphasisTarget(), startAt + ramp)
    } catch (error) {
      warn(`could not ramp emphasis gain: ${describe(error)}`)
    }
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
    // Head of the chain is the compressor, NOT `gain`: everything must pass through
    // it, or a hot line reaches the DAC as an unlimited multiply on a stream already
    // sitting at peak = 1.0.
    source.connect(graph.compressor)
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
    compressor = null
    emphasis = null
    gain = null
    analyser = null
    scope = null
    // `wantsEmphasis` is deliberately NOT reset: it is the caller's state, and a
    // rebuilt graph must come up matching whatever the caller last asked for.
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
    setEmphasis,
    isSpeaking,
    level,
    queuedSec,
    close,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The WebAudio defaults (−24 dBFS, 12:1, 30 dB knee) are a mastering limiter, not
 * a speech compressor, so every one of the five is set explicitly. Scheduled with
 * setValueAtTime rather than assigned, so the values are on the param timeline and
 * cannot be clobbered by a stray ramp. See AUDIO_CONFIG for why each number.
 */
function configureCompressor(node: DynamicsCompressorNode, now: number): void {
  node.threshold.setValueAtTime(AUDIO_CONFIG.compressorThresholdDb, now)
  node.ratio.setValueAtTime(AUDIO_CONFIG.compressorRatio, now)
  node.knee.setValueAtTime(AUDIO_CONFIG.compressorKneeDb, now)
  node.attack.setValueAtTime(AUDIO_CONFIG.compressorAttackSec, now)
  node.release.setValueAtTime(AUDIO_CONFIG.compressorReleaseSec, now)
}
