/**
 * Barge-in as the uplink actually performs it: which FRAMES leave the client, and when.
 *
 * WHY THIS EXISTS SEPARATELY FROM bargeIn.test.ts. Every test of the pure detector can pass
 * while `micUplink` drops the state it returns, never opens the gate, or never calls the
 * interrupt hook — and a detector whose decision is not acted on is exactly as half-duplex
 * as no detector. So this drives the real `createMicUplink`, with a fake microphone that
 * mirrors audioIn's per-buffer order (level, gate, monitor, RE-CONSULT the gate, silence
 * floor, chunk). That mirroring is the one thing it takes on trust, and
 * `audioInMonitor.test.ts` pins it against the real audioIn so the fake cannot drift.
 *
 * The regressions it is here to stop, all of which would look like a working feature:
 *   - the trigger buffer being dropped, so the user's first syllable is lost;
 *   - the pre-roll being replayed out of order, or twice;
 *   - the gate staying open after the barge-in window, i.e. an open mic on a talking coach;
 *   - barge-in arming itself with no way to silence the coach;
 *   - the measured silence flush no longer closing a barged-in turn, which would leave the
 *     coach permanently mute (found and fixed once already — see micUplink's header).
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_APPEND_EVENT,
  BUFFER_PERIOD_MS,
  createMicUplink,
  silenceFrame,
  UPLINK_CONFIG,
} from '../micUplink'
import { AUDIO_IN_CONFIG } from '../audioIn'
import type { AudioIn, AudioInOptions } from '../audioIn'
import { BARGE_IN_TUNING, preRollBuffers } from '../bargeIn'
import type { BargeInTuning } from '../bargeIn'

/** Room tone: above audioIn's silence floor, so it is a level a real mic really reports. */
const ROOM = 0.01
/** A person talking, comfortably past `triggerOverFloor` x ROOM. */
const VOICE = 0.5

/**
 * A microphone that reproduces audioIn's `onaudioprocess` ordering exactly — including the
 * second `gateOpen()` call, which is the mechanism that lets the triggering buffer itself be
 * transmitted instead of being the last one dropped.
 */
function fakeMic() {
  let captured: AudioInOptions | null = null
  const handle = {
    capturing: false,
    gated: false,
    level: 0,
    /** One buffer, at `level`, carrying `payload` as its encoded audio. */
    emit(level: number, payload: string) {
      const options = captured
      if (!options) throw new Error('not started')
      const shut = !options.gateOpen()
      if (options.onBuffer) {
        let live = true
        try {
          options.onBuffer({
            level,
            gated: shut,
            takeBase64: () => {
              if (!live) throw new Error('takeBase64 called after the buffer expired')
              return payload
            },
          })
        } finally {
          live = false
        }
      }
      if (shut && !options.gateOpen()) {
        handle.gated = true
        handle.level = 0
        return
      }
      handle.gated = false
      handle.level = level
      if (level < AUDIO_IN_CONFIG.silenceFloor) return
      options.onChunk(payload)
    },
  }
  const factory = (options: AudioInOptions): AudioIn => {
    captured = options
    return {
      start: async () => {
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

interface HarnessOptions {
  /** Omitted on purpose in one test: no hook must mean no barge-in. */
  readonly withInterrupt?: boolean
  readonly tuning?: BargeInTuning
}

async function harness(options: HarnessOptions = {}) {
  const frames: Record<string, unknown>[] = []
  const debug: string[] = []
  const failures: string[] = []
  const state = { speaking: false, interrupts: 0, interruptThrows: false }
  let time = 10_000
  const ticks: (() => void)[] = []
  const mic = fakeMic()

  const uplink = createMicUplink({
    send: (frame) => {
      frames.push(frame)
      return true
    },
    isCoachSpeaking: () => state.speaking,
    onFailure: (failure) => failures.push(`${failure.code}: ${failure.message}`),
    onDebug: (message) => debug.push(message),
    createAudioIn: mic.factory,
    now: () => time,
    setInterval: (handler) => {
      ticks.push(handler)
      return ticks.length
    },
    clearInterval: () => {
      ticks.length = 0
    },
    bargeInTuning: options.tuning,
    // Undefined on purpose in one test: no hook must mean no barge-in at all.
    interruptCoach:
      options.withInterrupt === false
        ? undefined
        : () => {
            state.interrupts += 1
            if (state.interruptThrows) throw new Error('audio graph is gone')
          },
  })

  await uplink.start()

  /** `count` buffers, one period apart, exactly as a real capture delivers them. */
  const feed = (count: number, level: number, label = 'buf') => {
    for (let i = 0; i < count; i += 1) {
      time += BUFFER_PERIOD_MS
      mic.handle.emit(level, `${label}-${i}`)
    }
  }
  const advance = (ms: number) => {
    time += ms
  }
  const tick = (times = 1) => {
    for (let i = 0; i < times; i += 1) for (const handler of ticks) handler()
  }
  const audio = () => frames.map((frame) => String(frame.audio))

  /** Let the floor tracker learn the room, then forget the frames it produced. */
  const settleRoom = () => {
    feed(40, ROOM, 'room')
    frames.length = 0
  }

  return { uplink, mic, frames, debug, failures, state, feed, advance, tick, audio, settleRoom }
}

const holdBuffers = Math.ceil(BARGE_IN_TUNING.holdMs / BUFFER_PERIOD_MS) + 1

describe('barge-in through the real uplink', () => {
  it('stops the coach, opens the gate, and appends from the triggering buffer on', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true

    // Room tone while the coach talks: nothing goes upstream, which is the half-duplex
    // behaviour barge-in must not break.
    h.feed(12, ROOM, 'gated-room')
    expect(h.frames).toEqual([])
    expect(h.uplink.state().gated).toBe(true)

    h.feed(holdBuffers, VOICE, 'user')
    expect(h.state.interrupts).toBe(1)
    expect(h.uplink.bargeIn().triggers).toBe(1)
    // The gate is open, so the buffer that PROVED it and every buffer after it are sent.
    expect(h.uplink.state().gated).toBe(false)
    expect(h.uplink.state().armed).toBe(true)
    expect(h.audio().filter((a) => a.startsWith('user-')).length).toBeGreaterThan(0)
    expect(h.frames.every((frame) => frame.type === AUDIO_APPEND_EVENT)).toBe(true)

    // ...and it keeps appending while the user carries on, coach audio or not.
    const before = h.frames.length
    h.feed(5, VOICE, 'more')
    expect(h.frames.length).toBe(before + 5)
  })

  it('replays the pre-roll first, in order, and never twice', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    h.feed(holdBuffers, VOICE, 'user')

    // EXACT, because this is the assertion that says the beginning of the sentence survived:
    // buffers 0 and 1 are the ones the hold swallowed, 2 is the one that triggered, 3 is the
    // first ordinary open-gate buffer. Every one of them, once, in order.
    expect(h.audio()).toEqual(['user-0', 'user-1', 'user-2', 'user-3'])
    expect(preRollBuffers()).toBeGreaterThan(0)
  })

  it('loses the start of the sentence with the pre-roll turned off, which is what it buys', async () => {
    const h = await harness({ tuning: { ...BARGE_IN_TUNING, preRollMs: 0 } })
    h.settleRoom()
    h.state.speaking = true
    h.feed(holdBuffers, VOICE, 'user')

    // The same input, and the two buffers that PROVED the user was talking are simply gone.
    // ~170ms of a first word: enough to make "wait, my shoulder—" arrive as "shoulder".
    expect(h.audio()).toEqual(['user-2', 'user-3'])
    expect(h.state.interrupts).toBe(1)
  })

  it('bounds the pre-roll ring, so a long coach line cannot grow it', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    // Thirty seconds of buffers that are above the silence floor (so they are candidates
    // for the ring) but below the trigger (so nothing fires). Unbounded, the ring would
    // hold ~350 of them and dump all of them on the wire at once.
    h.feed(350, ROOM, 'gated-room')
    expect(h.frames).toEqual([])
    h.feed(holdBuffers, VOICE, 'user')
    const roomFrames = h.audio().filter((a) => a.startsWith('gated-room'))
    expect(roomFrames.length).toBeLessThanOrEqual(preRollBuffers())
  })

  it('does not fire on a single loud buffer', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    for (let i = 0; i < 15; i += 1) {
      h.feed(1, VOICE, 'thud')
      h.feed(2, ROOM, 'gated-room')
    }
    expect(h.state.interrupts).toBe(0)
    expect(h.frames).toEqual([])
    expect(h.uplink.state().gated).toBe(true)
  })

  it('does not fire on a level that only just clears the tracked room', async () => {
    const h = await harness()
    h.settleRoom()
    // Learned, not assumed: the bar is a multiple of THIS room.
    expect(h.uplink.bargeIn().noiseFloor).toBeCloseTo(ROOM, 2)
    h.state.speaking = true
    h.feed(60, ROOM * 1.5, 'gated-room')
    expect(h.state.interrupts).toBe(0)
    expect(h.frames).toEqual([])
  })

  it('suppresses a trigger immediately after the coach starts', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    // A level above the ordinary bar but under the guarded one — an echo canceller that has
    // not converged on the line that just started looks exactly like this.
    const leak = ROOM * BARGE_IN_TUNING.triggerOverFloor * 1.5
    h.feed(holdBuffers + 2, leak, 'echo')
    expect(h.state.interrupts).toBe(0)
    expect(h.uplink.bargeIn().earlySuppressions).toBeGreaterThan(0)
    expect(h.debug.join(' ')).toMatch(/suspected echo/)

    // Past the guard, the same level is treated as a person.
    h.feed(Math.ceil(BARGE_IN_TUNING.echoGuardMs / BUFFER_PERIOD_MS) + 1, ROOM, 'gated-room')
    h.feed(holdBuffers, leak, 'user')
    expect(h.state.interrupts).toBe(1)
  })

  it('closes the gate again after the hold window if the coach is still talking', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    h.feed(holdBuffers, VOICE, 'user')
    expect(h.uplink.state().gated).toBe(false)

    // The interrupt did not take: the coach is still audible after the window. Back to safe
    // half-duplex rather than an open mic feeding the model its own voice.
    h.advance(BARGE_IN_TUNING.holdGateOpenMs)
    h.feed(1, ROOM, 'after-window')
    expect(h.uplink.state().gated).toBe(true)
  })

  it('keeps the measured silence flush working on a barged-in turn', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    h.feed(holdBuffers, VOICE, 'user')
    h.frames.length = 0

    // Server VAD closes a turn on silence IN THE STREAM. Without this the barged-in
    // question is never answered and the coach goes permanently mute — the exact failure
    // this repo already found and fixed once.
    h.advance(UPLINK_CONFIG.silenceGapMs + 1)
    h.tick(3)
    expect(h.audio()).toEqual(Array(3).fill(silenceFrame(AUDIO_IN_CONFIG.bufferSize)))
  })

  it('reports an interrupt hook that throws, and keeps the microphone', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    h.state.interruptThrows = true
    h.feed(holdBuffers, VOICE, 'user')

    expect(h.failures.join(' ')).toMatch(/barge-in could not stop the coach: audio graph is gone/)
    // Never fatal: the gate is open, so the user is still being heard even though the room
    // will sound bad. Losing capture on top of that would be strictly worse.
    expect(h.uplink.state().capturing).toBe(true)
    expect(h.audio().length).toBeGreaterThan(0)
  })

  it('forgets the room and any open window when capture stops', async () => {
    const h = await harness()
    h.settleRoom()
    h.state.speaking = true
    h.feed(holdBuffers, VOICE, 'user')
    expect(h.uplink.bargeIn().triggers).toBe(1)

    h.uplink.stop()
    expect(h.uplink.bargeIn()).toEqual(
      expect.objectContaining({ triggers: 0, openUntil: 0, noiseFloor: BARGE_IN_TUNING.initialFloor }),
    )
  })
})

describe('barge-in stays off unless it can silence the coach', () => {
  it('is disabled with no interruptCoach hook, and says so', async () => {
    const h = await harness({ withInterrupt: false })
    h.settleRoom()
    h.state.speaking = true
    h.feed(60, VOICE, 'user')
    // Opening the gate with no way to stop the voice is the feedback loop the gate exists
    // for: the model would hear itself and answer its own sentence.
    expect(h.frames).toEqual([])
    expect(h.uplink.state().gated).toBe(true)
    expect(h.debug.join(' ')).toMatch(/barge-in OFF: no interruptCoach hook/)
  })

  it('is disabled by the master switch, and says so', async () => {
    const h = await harness({ tuning: { ...BARGE_IN_TUNING, enabled: false } })
    h.settleRoom()
    h.state.speaking = true
    h.feed(60, VOICE, 'user')
    expect(h.state.interrupts).toBe(0)
    expect(h.frames).toEqual([])
    expect(h.uplink.state().gated).toBe(true)
    expect(h.debug.join(' ')).toMatch(/barge-in OFF by BARGE_IN_TUNING.enabled/)
  })

  it('still passes the user through normally once the coach stops, in both modes', async () => {
    for (const mode of [{ withInterrupt: false }, { tuning: { ...BARGE_IN_TUNING, enabled: false } }]) {
      const h = await harness(mode)
      h.state.speaking = false
      h.feed(3, VOICE, 'user')
      expect(h.audio()).toEqual(['user-0', 'user-1', 'user-2'])
    }
  })
})
