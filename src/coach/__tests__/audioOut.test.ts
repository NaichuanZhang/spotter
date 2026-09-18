/**
 * WHAT THIS FILE CAN AND CANNOT PROVE.
 *
 * There is no Web Audio implementation under vitest here — Node 24 has no
 * `OfflineAudioContext` and this repo has no jsdom or happy-dom — so these tests
 * drive `createAudioOut` against a hand-rolled fake context. That means they prove
 * the GRAPH IS WIRED AND AUTOMATED CORRECTLY (topology, compressor parameters,
 * ramped rather than stepped gain changes, and that barge-in and loudness stay on
 * separate nodes) and they prove the non-clipping budget is arithmetically
 * consistent. They do NOT render any audio, so they cannot see clipping directly.
 *
 * The acoustic half was verified separately, offline, against a real
 * DynamicsCompressorNode (node-web-audio-api's port of the WebKit/Blink kernel that
 * browsers use) by rendering this exact module through an OfflineAudioContext. On
 * speech-like input at peak 1.0 / RMS 0.2093 / crest 4.78:
 *
 *   emphasis OFF  RMS 0.1693  peak 0.6312  crest 3.73
 *   emphasis ON   RMS 0.2539  peak 0.9468  crest 3.73     step +3.52 dB, no clip
 *
 * and across four input levels the step was +3.52 dB every time with peak 0.92–0.95.
 * `MEASURED_COMPRESSOR_PEAK` below is the number that verification produced, and the
 * budget test turns red if anyone raises `emphasisHot` past what it allows.
 *
 * PERCEIVED loudness is not verified by anything, here or there. RMS, peak and crest
 * are not an ear.
 */
import { describe, expect, it } from 'vitest'
import { AUDIO_CONFIG, createAudioOut, decodeBase64Pcm16 } from '../audioOut'

/**
 * Worst-case peak measured at the compressor's OUTPUT, offline, with the makeup gain
 * divided back out: 0.6312 / 0.9 = 0.7013, on full-scale speech-like input at the
 * loudest crest the report records. Every makeup gain has to fit under
 * peakCeiling / this.
 */
const MEASURED_COMPRESSOR_PEAK = 0.7013

// ── fake Web Audio ──────────────────────────────────────────────────────────────

/** Records automation instead of applying it. Does not simulate ramps. */
class FakeParam {
  readonly automation: string[] = []
  /** Direct `.value =` writes. The emphasis ramp must add none of these. */
  readonly assignments: number[] = []
  private current: number

  constructor(initial: number) {
    this.current = initial
  }

  get value(): number {
    return this.current
  }

  set value(next: number) {
    this.assignments.push(next)
    this.current = next
  }

  cancelScheduledValues(at: number): void {
    this.automation.push(`cancel@${at}`)
  }

  setValueAtTime(value: number, at: number): void {
    this.automation.push(`set(${value})@${at}`)
    this.current = value
  }

  linearRampToValueAtTime(value: number, at: number): void {
    this.automation.push(`ramp(${value})@${at}`)
  }

  setTargetAtTime(value: number, at: number, constant: number): void {
    this.automation.push(`target(${value})@${at}/${constant}`)
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = []
  constructor(readonly label: string) {}
  connect(destination: FakeNode): FakeNode {
    this.outputs.push(destination)
    return destination
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1)
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24)
  readonly ratio = new FakeParam(12)
  readonly knee = new FakeParam(30)
  readonly attack = new FakeParam(0.003)
  readonly release = new FakeParam(0.25)
  readonly reduction = 0
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048
  /** What `getFloatTimeDomainData` will hand back; the test drives this. */
  waveform: number[] = []
  getFloatTimeDomainData(into: Float32Array): void {
    for (let i = 0; i < into.length; i += 1) into[i] = this.waveform[i] ?? 0
  }
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null
  started: number | null = null
  stopped: number | null = null
  onended: (() => void) | null = null
  constructor() {
    super('source')
  }
  start(when: number): void {
    this.started = when
  }
  stop(when: number): void {
    this.stopped = when
  }
}

class FakeBuffer {
  readonly channel: Float32Array
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channel = new Float32Array(length)
  }
  get duration(): number {
    return this.length / this.sampleRate
  }
  copyToChannel(from: Float32Array): void {
    this.channel.set(from)
  }
}

class FakeContext {
  state: AudioContextState = 'running'
  currentTime = 10
  readonly destination = new FakeNode('destination')
  readonly gains: FakeGain[] = []
  readonly compressors: FakeCompressor[] = []
  readonly analysers: FakeAnalyser[] = []
  readonly sources: FakeSource[] = []
  closed = false

  createGain(): FakeGain {
    const node = new FakeGain(`gain${this.gains.length}`)
    this.gains.push(node)
    return node
  }
  createDynamicsCompressor(): FakeCompressor {
    const node = new FakeCompressor('compressor')
    this.compressors.push(node)
    return node
  }
  createAnalyser(): FakeAnalyser {
    const node = new FakeAnalyser('analyser')
    this.analysers.push(node)
    return node
  }
  createBufferSource(): FakeSource {
    const node = new FakeSource()
    this.sources.push(node)
    return node
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate)
  }
  async resume(): Promise<void> {
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.closed = true
  }

  /** The graph nodes in the order audioOut creates them. */
  get emphasis(): FakeGain {
    return this.gains[0]
  }
  get fade(): FakeGain {
    return this.gains[1]
  }
  get compressor(): FakeCompressor {
    return this.compressors[0]
  }
  get analyser(): FakeAnalyser {
    return this.analysers[0]
  }
}

interface Harness {
  ctx: FakeContext
  out: ReturnType<typeof createAudioOut>
  warns: string[]
  contexts: FakeContext[]
}

/** 24 kHz PCM16 base64 of `samples` full-scale-ish sine, `ms` long. */
function chunk(ms: number, amplitude = 0.5): string {
  const count = Math.round((ms / 1000) * AUDIO_CONFIG.sampleRate)
  const bytes = new Uint8Array(count * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < count; i += 1) {
    const s = amplitude * Math.sin((2 * Math.PI * 200 * i) / AUDIO_CONFIG.sampleRate)
    view.setInt16(i * 2, Math.round(s * 32767), true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function harness(): Harness {
  const contexts: FakeContext[] = []
  const warns: string[] = []
  const out = createAudioOut({
    createContext: () => {
      const created = new FakeContext()
      contexts.push(created)
      return created as unknown as AudioContext
    },
    onWarn: (message) => warns.push(message),
  })
  // The graph is built lazily; force it so tests can inspect it.
  out.enqueue(chunk(20))
  return { ctx: contexts[0], out, warns, contexts }
}

// ── the graph ───────────────────────────────────────────────────────────────────

describe('playback graph', () => {
  it('routes source -> compressor -> emphasis -> fade -> analyser -> destination', () => {
    const { ctx } = harness()
    expect(ctx.compressors).toHaveLength(1)
    expect(ctx.gains).toHaveLength(2)
    // Every chunk must enter at the compressor. If a source ever connects straight
    // to a gain node, a hot line reaches the DAC as an unlimited multiply on a
    // stream already measured at peak = 1.0.
    expect(ctx.sources[0].outputs).toEqual([ctx.compressor])
    expect(ctx.compressor.outputs).toEqual([ctx.emphasis])
    expect(ctx.emphasis.outputs).toEqual([ctx.fade])
    expect(ctx.fade.outputs).toEqual([ctx.analyser])
    expect(ctx.analyser.outputs).toEqual([ctx.destination])
  })

  it('keeps the analyser last, so level() still reports what is audible', () => {
    const { ctx } = harness()
    // The UI's persona rim light reads level(). If the analyser moved upstream of
    // the compressor or the makeup gain it would report the wrong loudness.
    expect(ctx.analyser.outputs).toEqual([ctx.destination])
    expect(ctx.analyser.fftSize).toBe(AUDIO_CONFIG.analyserFftSize)
  })

  it('sets all five compressor parameters explicitly', () => {
    const { ctx } = harness()
    // WebAudio's defaults (-24 dBFS, 12:1, 30 dB knee, 3 ms attack) are a mastering
    // limiter. Measured, a 3 ms attack lets peaks through at 1.07-1.31 — over full
    // scale — so none of these may be left to default.
    const c = ctx.compressor
    expect(c.threshold.automation).toEqual([`set(${AUDIO_CONFIG.compressorThresholdDb})@10`])
    expect(c.ratio.automation).toEqual([`set(${AUDIO_CONFIG.compressorRatio})@10`])
    expect(c.knee.automation).toEqual([`set(${AUDIO_CONFIG.compressorKneeDb})@10`])
    expect(c.attack.automation).toEqual([`set(${AUDIO_CONFIG.compressorAttackSec})@10`])
    expect(c.release.automation).toEqual([`set(${AUDIO_CONFIG.compressorReleaseSec})@10`])
  })

  it('opens at the ordinary makeup gain with the fade node at unity', () => {
    const { ctx } = harness()
    expect(ctx.emphasis.gain.value).toBe(AUDIO_CONFIG.emphasisNormal)
    expect(ctx.fade.gain.value).toBe(1)
  })
})

// ── emphasis ────────────────────────────────────────────────────────────────────

describe('setEmphasis', () => {
  it('ramps instead of stepping', () => {
    const { ctx, out } = harness()
    const directWritesBefore = ctx.emphasis.gain.assignments.length
    out.setEmphasis(true)
    out.setEmphasis(false)
    // A bare `.value =` is a step discontinuity. Measured on a real render: it moves
    // the whole 0.45 between two ADJACENT samples, where the ramp spreads it over
    // 863 samples at 0.000469 each. So an emphasis change must add automation and
    // no new direct writes at all.
    expect(ctx.emphasis.gain.assignments).toHaveLength(directWritesBefore)
    const ramps = ctx.emphasis.gain.automation.filter((e) => e.startsWith('ramp'))
    expect(ramps).toHaveLength(2)
    expect(ramps[0]).toContain(`ramp(${AUDIO_CONFIG.emphasisHot})@`)
    expect(ramps[1]).toContain(`ramp(${AUDIO_CONFIG.emphasisNormal})@`)
  })

  it('holds the current value, then ramps — never one long interpolation', () => {
    const { ctx, out } = harness()
    // harness() queued 20 ms, so the playhead sits at 10 + jitter + 0.02.
    const playhead = 10 + AUDIO_CONFIG.jitterBufferMs / 1000 + 0.02
    out.setEmphasis(true)
    expect(ctx.emphasis.gain.automation).toEqual([
      'cancel@10',
      // Anchor at the CURRENT value, so a reversal mid-ramp starts where the gain
      // actually is rather than where the last scheduled ramp began...
      `set(${AUDIO_CONFIG.emphasisNormal})@10`,
      // ...held all the way to the playhead, because a lone ramp after that anchor
      // would interpolate across the entire wait instead of holding and then moving.
      `set(${AUDIO_CONFIG.emphasisNormal})@${playhead}`,
      `ramp(${AUDIO_CONFIG.emphasisHot})@${playhead + AUDIO_CONFIG.emphasisRampMs / 1000}`,
    ])
  })

  it('defers the change to the playhead, so a severe line keeps it to the end', () => {
    const { ctx, out } = harness()
    out.setEmphasis(true)
    // A severe line is now streaming; two more seconds of it are already scheduled.
    out.enqueue(chunk(1000))
    out.enqueue(chunk(1000))
    const playhead = 10 + out.queuedSec()
    ctx.emphasis.gain.automation.length = 0
    // session.ts clears emphasis on response.done — which fires when GENERATION
    // ends, while 2 s of hot audio is still queued. Dropping the gain at
    // currentTime would de-emphasise the back half of the very line it was for.
    out.setEmphasis(false)
    const rampAt = ctx.emphasis.gain.automation.find((e) => e.startsWith('ramp'))
    expect(rampAt).toBe(`ramp(${AUDIO_CONFIG.emphasisNormal})@${playhead + AUDIO_CONFIG.emphasisRampMs / 1000}`)
    expect(playhead - 10).toBeGreaterThan(2)
  })

  it('lets the newest call win, cancelling a deferred one that never took effect', () => {
    const { ctx, out } = harness()
    out.enqueue(chunk(1000))
    out.setEmphasis(true)
    out.setEmphasis(false)
    // Two cancels, and the last scheduled ramp is the one the last caller asked for.
    expect(ctx.emphasis.gain.automation.filter((e) => e.startsWith('cancel'))).toHaveLength(2)
    const ramps = ctx.emphasis.gain.automation.filter((e) => e.startsWith('ramp'))
    expect(ramps[ramps.length - 1]).toContain(`ramp(${AUDIO_CONFIG.emphasisNormal})@`)
  })

  it('is safe before the graph exists, and is not lost', () => {
    const contexts: FakeContext[] = []
    const out = createAudioOut({
      createContext: () => {
        const created = new FakeContext()
        contexts.push(created)
        return created as unknown as AudioContext
      },
    })
    // session.ts may set emphasis while pushing an event, which can precede the
    // first audio delta and therefore the first graph.
    expect(() => out.setEmphasis(true)).not.toThrow()
    expect(contexts).toHaveLength(0)
    out.enqueue(chunk(20))
    expect(contexts[0].emphasis.gain.value).toBe(AUDIO_CONFIG.emphasisHot)
  })

  it('survives close(), so a rebuilt graph comes up matching the caller', async () => {
    const { out, contexts } = harness()
    out.setEmphasis(true)
    await out.close()
    out.enqueue(chunk(20))
    expect(contexts).toHaveLength(2)
    expect(contexts[1].emphasis.gain.value).toBe(AUDIO_CONFIG.emphasisHot)
  })

  it('reports a failure to ramp instead of swallowing it', () => {
    const { ctx, out, warns } = harness()
    ctx.emphasis.gain.linearRampToValueAtTime = () => {
      throw new Error('param detached')
    }
    out.setEmphasis(true)
    expect(warns.some((w) => /emphasis/i.test(w) && /param detached/.test(w))).toBe(true)
  })
})

// ── barge-in must stay independent of loudness ──────────────────────────────────

describe('stop() and emphasis are separate nodes', () => {
  it('fades the fade node and leaves the makeup gain alone', () => {
    const { ctx, out } = harness()
    out.setEmphasis(true)
    const emphasisAutomation = [...ctx.emphasis.gain.automation]
    out.stop()
    // stop() ramps its node to 0 and back to *1*. If makeup lived on that node,
    // every barge-in would silently reset loudness to unity.
    expect(ctx.emphasis.gain.automation).toEqual(emphasisAutomation)
    expect(ctx.fade.gain.automation.join(' ')).toContain('ramp(0)')
    expect(ctx.fade.gain.automation.join(' ')).toContain('set(1)')
  })

  it('still stops every scheduled source and resets the playhead', () => {
    const { ctx, out } = harness()
    out.enqueue(chunk(100))
    const queuedBefore = out.queuedSec()
    out.stop()
    expect(queuedBefore).toBeGreaterThan(0.1)
    for (const source of ctx.sources) expect(source.stopped).not.toBeNull()
    expect(out.queuedSec()).toBeCloseTo(AUDIO_CONFIG.fadeOutMs / 1000, 6)
  })
})

// ── the contract that existed before the compressor ─────────────────────────────

describe('scheduled-buffer queue (unchanged contract)', () => {
  it('starts the first chunk one jitter buffer ahead, then schedules gaplessly', () => {
    const { ctx, out } = harness()
    out.enqueue(chunk(100))
    out.enqueue(chunk(100))
    const starts = ctx.sources.map((s) => s.started as number)
    expect(starts[0]).toBeCloseTo(10 + AUDIO_CONFIG.jitterBufferMs / 1000, 6)
    // Every chunk begins exactly where the last one ended. Starting at currentTime
    // instead is what produces the clicking "robot voice".
    expect(starts[1]).toBeCloseTo(starts[0] + 0.02, 6)
    expect(starts[2]).toBeCloseTo(starts[1] + 0.1, 6)
  })

  it('reports queuedSec and isSpeaking off that playhead', () => {
    const { out } = harness()
    out.enqueue(chunk(500))
    expect(out.isSpeaking()).toBe(true)
    expect(out.queuedSec()).toBeCloseTo(AUDIO_CONFIG.jitterBufferMs / 1000 + 0.52, 6)
  })

  it('drops a chunk rather than queueing an absurd backlog', () => {
    const { out, warns } = harness()
    for (let i = 0; i < 12; i += 1) out.enqueue(chunk(2000))
    expect(warns.some((w) => w.includes('audio backlog'))).toBe(true)
    expect(out.queuedSec()).toBeLessThan(AUDIO_CONFIG.maxQueuedSec + 2.2)
  })

  it('warns and drops rather than throwing on a bad chunk', () => {
    const { out, warns } = harness()
    out.enqueue('')
    out.enqueue('not base64 at all !!!')
    expect(warns.some((w) => w.includes('empty audio chunk'))).toBe(true)
    expect(out.isSpeaking()).toBe(true)
  })

  it('level() is the RMS of the analyser window, clamped, and 0 when silent', () => {
    const { ctx, out } = harness()
    ctx.analyser.waveform = new Array(AUDIO_CONFIG.analyserFftSize).fill(0.5)
    expect(out.level()).toBeCloseTo(0.5, 6)
    ctx.analyser.waveform = new Array(AUDIO_CONFIG.analyserFftSize).fill(4)
    expect(out.level()).toBe(1)
    out.stop()
    ctx.currentTime = 99
    // Not speaking -> 0, so the rim light goes dark instead of holding its last value.
    expect(out.level()).toBe(0)
  })

  it('decodes PCM16 little-endian into [-1, 1)', () => {
    // Guards the one piece of arithmetic the compressor sits downstream of.
    const pcm = decodeBase64Pcm16(btoa('\x00\x00\xff\x7f\x00\x80'))
    expect(Array.from(pcm)).toEqual([0, 32767 / 32768, -1])
  })
})

// ── the budget ──────────────────────────────────────────────────────────────────

describe('non-clipping budget', () => {
  it('keeps the hot makeup gain under the measured peak ceiling', () => {
    // THIS is the test that should fail if someone wants a louder bark. The offline
    // render measured the compressor's worst-case output peak; anything above
    // peakCeiling / that peak clips instead of getting louder.
    const maxSafe = AUDIO_CONFIG.peakCeiling / MEASURED_COMPRESSOR_PEAK
    expect(AUDIO_CONFIG.emphasisHot).toBeLessThanOrEqual(maxSafe)
    expect(AUDIO_CONFIG.emphasisNormal).toBeLessThanOrEqual(maxSafe)
    expect(AUDIO_CONFIG.peakCeiling).toBeLessThan(1)
  })

  it('makes the severe line audibly louder than the ordinary one', () => {
    const stepDb = 20 * Math.log10(AUDIO_CONFIG.emphasisHot / AUDIO_CONFIG.emphasisNormal)
    // ~1 dB is the loudness JND; a step that small is not worth the wire.
    expect(stepDb).toBeGreaterThan(2.5)
    expect(stepDb).toBeLessThan(6)
  })

  it('uses a compressor attack short enough to actually reduce crest', () => {
    // Measured: at 2 ms and 4 ms the output peak was 1.07 and 1.31 — ABOVE full
    // scale, out of a compressor — because WebAudio applies an internal makeup gain
    // during the attack window. Crest reduction needs an attack well under one pitch
    // period, and jake's measured F0 of 122 Hz is a 8.2 ms period.
    expect(AUDIO_CONFIG.compressorAttackSec).toBeLessThan(0.0082 / 10)
    expect(AUDIO_CONFIG.compressorAttackSec).toBeGreaterThan(0)
  })
})

// ── real render, only where a Web Audio implementation exists ───────────────────

const hasOfflineAudio = typeof (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext === 'function'

describe.skipIf(!hasOfflineAudio)('offline render (skipped without OfflineAudioContext)', () => {
  it('raises RMS with emphasis on and never reaches full scale', async () => {
    const Ctor = (globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext })
      .OfflineAudioContext
    const seconds = 1.2
    const measure = async (hot: boolean): Promise<{ rms: number; peak: number }> => {
      const ctx = new Ctor(1, Math.round(seconds * AUDIO_CONFIG.sampleRate), AUDIO_CONFIG.sampleRate)
      const out = createAudioOut({ createContext: () => ctx as unknown as AudioContext })
      if (hot) out.setEmphasis(true)
      for (let i = 0; i < 8; i += 1) out.enqueue(chunk(100, 0.9))
      const pcm = (await ctx.startRendering()).getChannelData(0)
      let sum = 0
      let peak = 0
      for (const s of pcm) {
        sum += s * s
        peak = Math.max(peak, Math.abs(s))
      }
      return { rms: Math.sqrt(sum / pcm.length), peak }
    }
    const base = await measure(false)
    const emphasised = await measure(true)
    expect(emphasised.rms).toBeGreaterThan(base.rms)
    expect(emphasised.peak).toBeLessThan(1)
    expect(base.peak).toBeLessThan(1)
  })
})
