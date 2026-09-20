/**
 * The REAL audioIn, driven through a stubbed Web Audio graph.
 *
 * WHY: barge-in rests on three claims about this file that no other test touches, because
 * every other test injects a fake microphone and therefore asserts the fake:
 *
 *   1. the RMS of a buffer is computed EVEN WHILE THE GATE IS SHUT — a level we never
 *      measure is a barge-in we can never detect;
 *   2. `onBuffer` runs BEFORE the gate decision is acted on, and `gateOpen()` is then
 *      RE-CONSULTED — which is the whole mechanism by which the buffer that proved the user
 *      was talking gets transmitted instead of being the last one dropped;
 *   3. `takeBase64()` is valid only inside the callback, because Web Audio refills the
 *      channel data afterwards and a late call would return real-looking audio from the
 *      wrong moment.
 *
 * It also re-pins what must NOT have changed: `level()` still reads 0 while gated (the UI
 * contract), the silence floor still suppresses sub-floor buffers, and a session with no
 * monitor behaves exactly as it did before barge-in existed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIO_IN_CONFIG, AudioInError, createAudioIn } from '../audioIn'
import type { AudioInBuffer } from '../audioIn'

type ProcessHandler = ((event: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void) | null

/** Just enough Web Audio and getUserMedia for createAudioIn to build its graph. */
function installFakeAudio() {
  const stopped: string[] = []
  const graph: { process: ProcessHandler } = { process: null }

  class FakeScriptProcessor {
    onaudioprocess: ProcessHandler = null
    connect() {}
    disconnect() {}
  }
  class FakeAudioContext {
    state = 'running'
    currentTime = 0
    destination = {}
    async resume() {
      this.state = 'running'
    }
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined }
    }
    createScriptProcessor() {
      const node = new FakeScriptProcessor()
      // Captured so the test can deliver buffers the way the audio thread would.
      Object.defineProperty(node, 'onaudioprocess', {
        get: () => graph.process,
        set: (handler: ProcessHandler) => {
          graph.process = handler
        },
      })
      return node
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined }
    }
    async close() {}
  }

  const originals = {
    AudioContext: Reflect.get(globalThis, 'AudioContext'),
    navigator: Reflect.get(globalThis, 'navigator'),
  }
  Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true })
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push('track') }] }),
      },
    },
    configurable: true,
  })

  return {
    stopped,
    /** Deliver one buffer exactly as the audio thread does. */
    deliver(samples: Float32Array) {
      if (!graph.process) throw new Error('capture never installed onaudioprocess')
      graph.process({ inputBuffer: { getChannelData: () => samples } })
    },
    restore() {
      Object.defineProperty(globalThis, 'AudioContext', {
        value: originals.AudioContext,
        configurable: true,
      })
      Object.defineProperty(globalThis, 'navigator', {
        value: originals.navigator,
        configurable: true,
      })
    },
  }
}

let fake: ReturnType<typeof installFakeAudio> | null = null

afterEach(() => {
  fake?.restore()
  fake = null
})

/** A buffer at a known RMS: a constant-magnitude square wave has RMS === |amplitude|. */
function atLevel(amplitude: number, frames = 64): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = i % 2 === 0 ? amplitude : -amplitude
  return out
}

interface Recorded {
  readonly chunks: string[]
  readonly seen: { level: number; gated: boolean }[]
  readonly errors: AudioInError[]
}

async function capture(gate: { open: boolean }, monitor?: (buffer: AudioInBuffer, r: Recorded) => void) {
  fake = installFakeAudio()
  const recorded: Recorded = { chunks: [], seen: [], errors: [] }
  const mic = createAudioIn({
    onChunk: (base64) => recorded.chunks.push(base64),
    gateOpen: () => gate.open,
    onBuffer: monitor
      ? (buffer) => {
          recorded.seen.push({ level: buffer.level, gated: buffer.gated })
          monitor(buffer, recorded)
        }
      : undefined,
    onError: (error) => recorded.errors.push(error),
  })
  await mic.start()
  return { mic, recorded, deliver: fake.deliver }
}

describe('the monitor sees what the gate throws away', () => {
  it('measures the level of a GATED buffer, which is the evidence barge-in runs on', async () => {
    const gate = { open: false }
    const { mic, recorded, deliver } = await capture(gate, () => undefined)
    deliver(atLevel(0.4))

    expect(recorded.seen).toHaveLength(1)
    expect(recorded.seen[0]?.gated).toBe(true)
    // Float32 storage, so the RMS comes back one ulp off 0.4 — hence toBeCloseTo.
    expect(recorded.seen[0]?.level).toBeCloseTo(0.4, 6)
    // Nothing transmitted, and the UI still reads 0 — the level is for the detector only.
    expect(recorded.chunks).toEqual([])
    expect(mic.isGated()).toBe(true)
    expect(mic.level()).toBe(0)
  })

  it('runs the monitor BEFORE the gate decision and re-consults the gate afterwards', async () => {
    const gate = { open: false }
    // This is barge-in in miniature: the monitor decides from the level that the user is
    // talking and opens the gate, and the buffer it decided on must be the one sent.
    const { mic, recorded, deliver } = await capture(gate, () => {
      gate.open = true
    })
    deliver(atLevel(0.4))

    expect(recorded.seen[0]?.gated).toBe(true)
    expect(recorded.seen[0]?.level).toBeCloseTo(0.4, 6)
    expect(recorded.chunks).toHaveLength(1)
    expect(mic.isGated()).toBe(false)
    expect(mic.level()).toBeCloseTo(0.4, 6)
  })

  it('encodes the buffer it was handed, as little-endian PCM16', async () => {
    const gate = { open: false }
    let encoded = ''
    const { deliver } = await capture(gate, (buffer) => {
      encoded = buffer.takeBase64()
    })
    deliver(new Float32Array([0, 0.5, -0.5, 1]))

    // Decoded independently of the encoder's string handling, so this is a round trip and
    // not a restatement: clamped, scaled asymmetrically (0x7fff up, 0x8000 down), LE.
    const raw = atob(encoded)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
    const view = new DataView(bytes.buffer)
    expect(bytes).toHaveLength(8)
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([0, 16383, -16384, 32767])
  })

  it('throws if the payload is taken after the callback, instead of returning stale audio', async () => {
    const gate = { open: false }
    let escaped: (() => string) | null = null
    const { recorded, deliver } = await capture(gate, (buffer) => {
      escaped = buffer.takeBase64
    })
    deliver(atLevel(0.4))

    // Web Audio has refilled the channel data by now. Returning something plausible from
    // the wrong moment would be far harder to debug than this.
    expect(escaped).not.toBeNull()
    expect(() => escaped?.()).toThrow(/expired/)
    expect(recorded.errors).toEqual([])
  })

  it('reports a monitor that throws and keeps capturing', async () => {
    const gate = { open: true }
    const { mic, recorded, deliver } = await capture(gate, () => {
      throw new Error('detector bug')
    })
    deliver(atLevel(0.4))
    deliver(atLevel(0.4))

    expect(recorded.errors).toHaveLength(2)
    expect(recorded.errors[0]?.code).toBe('mic_failed')
    // Barge-in is additive; losing the microphone over a detector bug would be worse than
    // losing barge-in, so the buffers still go upstream.
    expect(mic.isCapturing()).toBe(true)
    expect(recorded.chunks).toHaveLength(2)
  })
})

describe('what barge-in must not have changed', () => {
  it('keeps the gate closed and encodes nothing when no monitor is installed', async () => {
    const gate = { open: false }
    const { mic, recorded, deliver } = await capture(gate)
    deliver(atLevel(0.4))
    expect(recorded.chunks).toEqual([])
    expect(recorded.seen).toEqual([])
    expect(mic.isGated()).toBe(true)
    expect(mic.level()).toBe(0)
  })

  it('still drops a sub-floor buffer, and still reports its level', async () => {
    const gate = { open: true }
    const { mic, recorded, deliver } = await capture(gate, () => undefined)
    deliver(atLevel(AUDIO_IN_CONFIG.silenceFloor / 2))
    // Skipped to save bandwidth — and this is the skip that made the measured silence flush
    // necessary in the first place (see micUplink's header).
    expect(recorded.chunks).toEqual([])
    expect(mic.level()).toBeCloseTo(AUDIO_IN_CONFIG.silenceFloor / 2, 6)
    expect(recorded.seen).toHaveLength(1)
  })

  it('stops the media track on stop()', async () => {
    const gate = { open: true }
    const { mic } = await capture(gate, () => undefined)
    mic.stop()
    expect(fake?.stopped).toEqual(['track'])
    expect(mic.isCapturing()).toBe(false)
  })
})
