/**
 * The uplink's three load-bearing rules, driven through a fake AudioIn.
 *
 * WHAT THIS PROVES: which FRAMES go out, and when. That is the whole of the protocol
 * contract — append only, gate closed while the coach speaks, trailing silence flushed
 * once and bounded — and it is all pure logic once the microphone is injected.
 *
 * WHAT IT CANNOT PROVE: that the server accepts them. That needs the live API, and
 * liveUplink.test.ts does it: real speech in, speech_started / speech_stopped /
 * committed back, then a play_music call. The numbers in UPLINK_CONFIG came from there,
 * not from here.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_APPEND_EVENT,
  buildAudioAppend,
  createMicUplink,
  isWithinAppendLimit,
  MIC_OFF,
  silenceFrame,
  SILENCE_FLUSH_BUFFERS,
  UPLINK_CONFIG,
} from '../micUplink'
import { AUDIO_IN_CONFIG, AudioInError } from '../audioIn'
import type { AudioIn, AudioInOptions } from '../audioIn'

/** A microphone whose buffers, gate and failure are all driven by the test. */
function fakeMic(startError?: AudioInError) {
  let captured: AudioInOptions | null = null
  const handle = {
    capturing: false,
    gated: false,
    level: 0,
    /** Simulate one buffer arriving, honouring the gate exactly as audioIn does. */
    emit(payload: string) {
      if (!captured) throw new Error('not started')
      if (!captured.gateOpen()) {
        handle.gated = true
        handle.level = 0
        return
      }
      handle.gated = false
      captured.onChunk(payload)
    },
    fail(error: AudioInError) {
      captured?.onError?.(error)
    },
  }
  const factory = (options: AudioInOptions): AudioIn => {
    captured = options
    return {
      start: async () => {
        if (startError) throw startError
        handle.capturing = true
      },
      stop: () => {
        handle.capturing = false
      },
      level: () => handle.level,
      isCapturing: () => handle.capturing,
      isGated: () => handle.gated,
    }
  }
  return { factory, handle }
}

/** A clock and an interval the test steps by hand; nothing here waits on real time. */
function fakeClock() {
  let time = 1_000
  const ticks: (() => void)[] = []
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
    /** Runs every registered interval handler once. */
    tick: (times = 1) => {
      for (let i = 0; i < times; i += 1) for (const handler of ticks) handler()
    },
    setInterval: (handler: () => void) => {
      ticks.push(handler)
      return ticks.length
    },
    clearInterval: () => {
      ticks.length = 0
    },
  }
}

interface Harness {
  frames: Record<string, unknown>[]
  debug: string[]
  failures: string[]
  speaking: boolean
  sendOk: boolean
}

function harness(options: { startError?: AudioInError } = {}) {
  const state: Harness = { frames: [], debug: [], failures: [], speaking: false, sendOk: true }
  const clock = fakeClock()
  const mic = fakeMic(options.startError)
  const uplink = createMicUplink({
    send: (frame) => {
      if (!state.sendOk) return false
      state.frames.push(frame)
      return true
    },
    isCoachSpeaking: () => state.speaking,
    onFailure: (failure) => state.failures.push(`${failure.code}: ${failure.message}`),
    onDebug: (message) => state.debug.push(message),
    createAudioIn: mic.factory,
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  })
  return { state, clock, mic, uplink }
}

const types = (frames: Record<string, unknown>[]): string[] => frames.map((f) => String(f.type))

describe('frame shape: append, and never anything else', () => {
  it('builds exactly the one event the protocol allows', () => {
    expect(buildAudioAppend('QUJD')).toEqual({ type: AUDIO_APPEND_EVENT, audio: 'QUJD' })
    expect(AUDIO_APPEND_EVENT).toBe('input_audio_buffer.append')
  })

  it('sends no commit and no response.create, because server_vad owns the turn', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('AAAA')
    mic.handle.emit('BBBB')
    // A commit would cut the user off mid-sentence; a response.create would have the
    // coach answer the same turn twice. Both were live-verified as the server's job.
    expect(types(state.frames)).toEqual([AUDIO_APPEND_EVENT, AUDIO_APPEND_EVENT])
    expect(state.frames.map((f) => f.audio)).toEqual(['AAAA', 'BBBB'])
  })

  it('drops a buffer over the 1 MiB event cap rather than sending it', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('x'.repeat(UPLINK_CONFIG.maxAppendBytes + 1))
    expect(state.frames).toEqual([])
    expect(state.debug.join(' ')).toMatch(/over the append limit/)
  })

  it('measures the cap in base64 characters, which are bytes on the wire', () => {
    expect(isWithinAppendLimit('')).toBe(false)
    expect(isWithinAppendLimit('a'.repeat(UPLINK_CONFIG.maxAppendBytes))).toBe(true)
    expect(isWithinAppendLimit('a'.repeat(UPLINK_CONFIG.maxAppendBytes + 1))).toBe(false)
  })
})

describe('the gate: the coach must never be heard by the coach', () => {
  it('passes nothing upstream while the coach is speaking', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    state.speaking = true
    mic.handle.emit('SHOULD-NOT-SEND')
    // This is the line that stops the model answering its own voice through the
    // speakers, which server VAD would happily score as a user turn.
    expect(state.frames).toEqual([])
    expect(uplink.state().gated).toBe(true)
    expect(uplink.state().armed).toBe(false)
  })

  it('reopens the moment the coach stops', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    state.speaking = true
    mic.handle.emit('gated')
    state.speaking = false
    mic.handle.emit('heard')
    expect(state.frames.map((f) => f.audio)).toEqual(['heard'])
    expect(uplink.state().gated).toBe(false)
    expect(uplink.state().armed).toBe(true)
  })
})

describe('armed state: what the music duck and the HUD both read', () => {
  it('is false until a buffer has actually gone out', async () => {
    const { uplink } = harness()
    expect(uplink.state()).toEqual(MIC_OFF)
    await uplink.start()
    expect(uplink.state().capturing).toBe(true)
    expect(uplink.state().armed).toBe(false)
  })

  it('lapses after armedHoldMs of quiet, so the music un-ducks between turns', async () => {
    const { clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('talk')
    expect(uplink.state().armed).toBe(true)
    clock.advance(UPLINK_CONFIG.armedHoldMs - 1)
    expect(uplink.state().armed).toBe(true)
    clock.advance(2)
    expect(uplink.state().armed).toBe(false)
  })

  it('does not count a buffer the socket refused', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    state.sendOk = false
    mic.handle.emit('into the void')
    // Mid-reconnect there is no turn to preserve, so this is a dropped buffer and not
    // an error — but it must not read as "the mic is being heard" either.
    expect(uplink.state().armed).toBe(false)
    expect(state.failures).toEqual([])
  })
})

describe('the silence flush: the turn has to be closable', () => {
  it('emits PCM16 zeros, not spaces', () => {
    const decoded = atob(silenceFrame(4))
    expect(decoded).toHaveLength(8)
    expect([...decoded].every((char) => char.charCodeAt(0) === 0)).toBe(true)
  })

  it('derives its length from the buffer size instead of a hand-counted constant', () => {
    const period = (AUDIO_IN_CONFIG.bufferSize / AUDIO_IN_CONFIG.sampleRate) * 1000
    expect(SILENCE_FLUSH_BUFFERS).toBe(Math.ceil(UPLINK_CONFIG.silenceFlushMs / period))
    // 510 ms was measured as NOT enough to make the server close a turn.
    expect(UPLINK_CONFIG.silenceFlushMs).toBeGreaterThan(510)
  })

  it('waits for a real gap before flushing anything', async () => {
    const { state, clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('mid-word')
    clock.advance(UPLINK_CONFIG.silenceGapMs - 1)
    clock.tick(3)
    // One buffer period is ~85 ms, so a flush inside the gap would be interleaving
    // zeros into the middle of a sentence.
    expect(state.frames.map((f) => f.audio)).toEqual(['mid-word'])
  })

  it('flushes exactly the budget after the gap, then goes idle', async () => {
    const { state, clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('done talking')
    clock.advance(UPLINK_CONFIG.silenceGapMs + 1)
    clock.tick(SILENCE_FLUSH_BUFFERS + 10)

    const silence = silenceFrame(AUDIO_IN_CONFIG.bufferSize)
    const sent = state.frames.map((f) => f.audio)
    expect(sent[0]).toBe('done talking')
    expect(sent.slice(1)).toEqual(Array(SILENCE_FLUSH_BUFFERS).fill(silence))
    expect(state.debug.join(' ')).toContain('to close the turn')
  })

  it('never flushes into a turn the coach is already answering', async () => {
    const { state, clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('question')
    state.speaking = true
    mic.handle.emit('gated buffer sets the gated flag')
    clock.advance(UPLINK_CONFIG.silenceGapMs + 1)
    clock.tick(5)
    // The server closed this turn already — that is why the coach is speaking.
    expect(state.frames.map((f) => f.audio)).toEqual(['question'])
  })

  it('gets a fresh budget for every new turn', async () => {
    const { state, clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('first')
    clock.advance(UPLINK_CONFIG.silenceGapMs + 1)
    clock.tick(SILENCE_FLUSH_BUFFERS + 5)
    const afterFirst = state.frames.length

    mic.handle.emit('second')
    clock.advance(UPLINK_CONFIG.silenceGapMs + 1)
    clock.tick(SILENCE_FLUSH_BUFFERS + 5)
    expect(state.frames.length).toBe(afterFirst + 1 + SILENCE_FLUSH_BUFFERS)
  })

  it('stops flushing once the mic is stopped', async () => {
    const { state, clock, mic, uplink } = harness()
    await uplink.start()
    mic.handle.emit('talk')
    uplink.stop()
    clock.advance(UPLINK_CONFIG.silenceGapMs + 1)
    clock.tick(5)
    expect(state.frames.map((f) => f.audio)).toEqual(['talk'])
    expect(uplink.state()).toEqual(MIC_OFF)
  })
})

describe('a refused microphone degrades, it does not throw', () => {
  it('resolves start(), records the code, and reports once', async () => {
    const denied = new AudioInError('mic_denied', 'Microphone permission was denied.')
    const { state, uplink } = harness({ startError: denied })
    // Not `rejects`: the pose-driven one-way coaching is the product, and a rejected
    // promise here would take the session's open path down with it.
    await expect(uplink.start()).resolves.toBeUndefined()
    expect(uplink.state().capturing).toBe(false)
    expect(uplink.state().error).toEqual({ code: 'mic_denied', message: denied.message })
    expect(state.failures).toEqual(['mic_denied: Microphone permission was denied.'])
  })

  it('surfaces a per-buffer failure without tearing the capture down', async () => {
    const { state, mic, uplink } = harness()
    await uplink.start()
    mic.handle.fail(new AudioInError('mic_failed', 'Failed to forward a microphone buffer.'))
    expect(state.failures).toHaveLength(1)
    // Still capturing: the next buffer may well work, and restarting would need a gesture.
    expect(uplink.state().capturing).toBe(true)
  })
})
