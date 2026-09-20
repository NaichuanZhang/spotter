/**
 * Ducking: two independent reasons, one level, and the failure mode is a demo where
 * the music never comes back up.
 *
 * Both halves of the contract are tested, because either alone would pass while the
 * feature is broken:
 *   - musicPlayer's REASON SET, driven through a fake AudioContext, proves the level
 *     only restores when the last reason clears;
 *   - syncDuck proves the caller reports both edges, so a reason can never be set and
 *     then forgotten.
 *
 * There is no Web Audio under vitest (Node 24, no jsdom), so the player runs against a
 * hand-rolled context that RECORDS automation instead of applying it. That makes the
 * assertions about which ramps are scheduled exact, and says nothing about how it
 * sounds. `stop()` is deliberately never called on the real player here: it schedules
 * its fade through `window.setTimeout`, and there is no window in this environment.
 */
import { describe, expect, it } from 'vitest'
import { createMusicPlayer, MUSIC_CONFIG } from '../musicPlayer'
import type { DuckReason } from '../musicPlayer'
import { DUCK_REASONS, duckReasonsFor, NO_DUCK, syncDuck } from '../musicControl'
import type { MusicDucker } from '../musicControl'
import { createDuckLoop, micLevelStep, sameMicState } from '../duckLoop'
import { MIC_OFF } from '../micUplink'
import type { MicState } from '../micUplink'

// ── fake Web Audio, just enough of it ──────────────────────────────────────────

class FakeParam {
  readonly ramps: number[] = []
  value = 0
  cancelScheduledValues(): void {}
  setValueAtTime(value: number): void {
    this.value = value
  }
  linearRampToValueAtTime(value: number): void {
    this.ramps.push(value)
  }
}

class FakeGain {
  readonly gain = new FakeParam()
  connect(): void {}
  disconnect(): void {}
}

class FakeSource {
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  currentTime = 0
  state: AudioContextState = 'running'
  readonly destination = {}
  readonly gains: FakeGain[] = []
  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
  createMediaElementSource(): FakeSource {
    return new FakeSource()
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** The <audio> element musicPlayer constructs. Only the fields it touches exist. */
class FakeAudio {
  loop = false
  crossOrigin: string | null = null
  preload = ''
  paused = false
  onended: (() => void) | null = null
  constructor(readonly src: string) {}
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
}

async function playingPlayer() {
  const context = new FakeAudioContext()
  const original = (globalThis as { Audio?: unknown }).Audio
  ;(globalThis as { Audio?: unknown }).Audio = FakeAudio
  try {
    const player = createMusicPlayer({ context: context as unknown as AudioContext })
    await player.play()
    const gain = context.gains[0]
    if (!gain) throw new Error('the player built no gain node')
    // play() ramps up to base level; clear that so each case reads only its own ramps.
    gain.gain.ramps.length = 0
    return { player, gain }
  } finally {
    ;(globalThis as { Audio?: unknown }).Audio = original
  }
}

// ── the reason set, through the real player ────────────────────────────────────

describe('musicPlayer duck reasons: the level stays down while ANY reason holds it', () => {
  it('opens at base level once playback starts', async () => {
    const context = new FakeAudioContext()
    const original = (globalThis as { Audio?: unknown }).Audio
    ;(globalThis as { Audio?: unknown }).Audio = FakeAudio
    try {
      const player = createMusicPlayer({ context: context as unknown as AudioContext })
      await player.play()
      const gain = context.gains[0]
      // Starts ducked and ramps up, so a track never slams in at full level.
      expect(gain?.gain.ramps).toEqual([MUSIC_CONFIG.baseGain])
      player.destroy()
    } finally {
      ;(globalThis as { Audio?: unknown }).Audio = original
    }
  })

  it('ducks on the first reason and does not re-duck on the second', async () => {
    const { player, gain } = await playingPlayer()
    player.setDucked('coach', true)
    expect(gain.gain.ramps).toEqual([MUSIC_CONFIG.duckedGain])
    player.setDucked('mic', true)
    // Already down. A second ramp to the same value would be audible as a pump.
    expect(gain.gain.ramps).toEqual([MUSIC_CONFIG.duckedGain])
    player.destroy()
  })

  it('stays ducked when only ONE of two reasons clears', async () => {
    const { player, gain } = await playingPlayer()
    player.setDucked('coach', true)
    player.setDucked('mic', true)
    gain.gain.ramps.length = 0

    player.setDucked('coach', false)
    // The mic is still armed. This is the case a single boolean gets wrong: the coach
    // stops talking, the gate reopens, and the music would jump back to full while the
    // user is mid-sentence.
    expect(gain.gain.ramps).toEqual([])
    player.destroy()
  })

  it('restores only when BOTH reasons have cleared', async () => {
    const { player, gain } = await playingPlayer()
    player.setDucked('coach', true)
    player.setDucked('mic', true)
    player.setDucked('coach', false)
    gain.gain.ramps.length = 0

    player.setDucked('mic', false)
    expect(gain.gain.ramps).toEqual([MUSIC_CONFIG.baseGain])
    player.destroy()
  })

  it('is order-independent — the reasons are a set, not a stack', async () => {
    const { player, gain } = await playingPlayer()
    player.setDucked('mic', true)
    player.setDucked('coach', true)
    player.setDucked('mic', false)
    expect(gain.gain.ramps).toEqual([MUSIC_CONFIG.duckedGain])
    player.setDucked('coach', false)
    expect(gain.gain.ramps).toEqual([MUSIC_CONFIG.duckedGain, MUSIC_CONFIG.baseGain])
    player.destroy()
  })

  it('clearing a reason that was never set changes nothing', async () => {
    const { player, gain } = await playingPlayer()
    player.setDucked('mic', false)
    expect(gain.gain.ramps).toEqual([])
    player.destroy()
  })

  it('ducks below base level, so speech sits over music rather than beside it', () => {
    expect(MUSIC_CONFIG.duckedGain).toBeLessThan(MUSIC_CONFIG.baseGain)
  })
})

// ── the coordinator the session drives ────────────────────────────────────────

function fakeDucker(): { ducker: MusicDucker; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ducker: {
      setDucked: (reason, ducked) => calls.push(`${reason}=${String(ducked)}`),
      stop: () => calls.push('stop'),
    },
  }
}

describe('syncDuck reports both edges, every time', () => {
  it('derives a reason per input and never a partial map', () => {
    expect(duckReasonsFor({ coachSpeaking: true, micArmed: false })).toEqual({ coach: true, mic: false })
    expect(Object.keys(duckReasonsFor({ coachSpeaking: false, micArmed: false }))).toEqual([
      ...DUCK_REASONS,
    ])
  })

  it('emits only the reasons that changed', () => {
    const { ducker, calls } = fakeDucker()
    const armed = syncDuck(ducker, NO_DUCK, { coach: true, mic: true })
    expect(calls).toEqual(['coach=true', 'mic=true'])

    calls.length = 0
    const quiet = syncDuck(ducker, armed, { coach: false, mic: true })
    expect(calls).toEqual(['coach=false'])
    expect(quiet).toEqual({ coach: false, mic: true })
  })

  it('emits nothing when the situation has not moved', () => {
    const { ducker, calls } = fakeDucker()
    const state = { coach: true, mic: false }
    syncDuck(ducker, state, { coach: true, mic: false })
    // This runs on a 100 ms tick, so a no-op tick has to cost nothing.
    expect(calls).toEqual([])
  })

  it('releases every held reason on teardown', () => {
    const { ducker, calls } = fakeDucker()
    const result = syncDuck(ducker, { coach: true, mic: true }, NO_DUCK)
    expect(calls).toEqual(['coach=false', 'mic=false'])
    expect(result).toBe(NO_DUCK)
  })

  it('does not mutate the map it was given', () => {
    const { ducker } = fakeDucker()
    const previous: Readonly<Record<DuckReason, boolean>> = { coach: true, mic: false }
    syncDuck(ducker, previous, { coach: false, mic: true })
    expect(previous).toEqual({ coach: true, mic: false })
  })
})

// ── the loop the session actually runs ────────────────────────────────────────

function loopHarness(music?: MusicDucker) {
  const ticks: (() => void)[] = []
  const state = { speaking: false, mic: { ...MIC_OFF } as MicState }
  const published: MicState[] = []
  const loop = createDuckLoop({
    isCoachSpeaking: () => state.speaking,
    getMicState: () => state.mic,
    music,
    onMicState: (next) => published.push(next),
    setInterval: (handler) => {
      ticks.push(handler)
      return ticks.length
    },
    clearInterval: () => {
      ticks.length = 0
    },
  })
  loop.start()
  return { loop, state, published, tick: () => ticks.forEach((handler) => handler()) }
}

const micState = (over: Partial<MicState>): MicState => ({ ...MIC_OFF, ...over })

describe('createDuckLoop: the two reasons, polled', () => {
  it('ducks for the coach and for the armed mic, and restores only when both clear', () => {
    const { ducker, calls } = fakeDucker()
    const { state, tick } = loopHarness(ducker)

    state.speaking = true
    tick()
    expect(calls).toEqual(['coach=true'])

    state.mic = micState({ capturing: true, armed: true, level: 0.3 })
    tick()
    expect(calls).toEqual(['coach=true', 'mic=true'])

    // The coach finishes but the user is still talking. A single boolean would restore
    // full volume here, straight over the top of the user.
    state.speaking = false
    tick()
    expect(calls).toEqual(['coach=true', 'mic=true', 'coach=false'])

    state.mic = micState({ capturing: true, armed: false })
    tick()
    expect(calls).toEqual(['coach=true', 'mic=true', 'coach=false', 'mic=false'])
  })

  it('reads armed, not capturing: a gated mic is not listening', () => {
    const { ducker, calls } = fakeDucker()
    const { state, tick } = loopHarness(ducker)
    state.mic = micState({ capturing: true, gated: true, armed: false })
    tick()
    expect(calls).toEqual([])
  })

  it('publishes a material mic change but damps level jitter', () => {
    const { published, state, tick } = loopHarness()
    state.mic = micState({ capturing: true, armed: true, level: 0.30 })
    tick()
    expect(published).toHaveLength(1)

    // Inside one quantisation step: the HUD meter cannot show this, so nothing renders.
    state.mic = micState({ capturing: true, armed: true, level: 0.31 })
    tick()
    expect(published).toHaveLength(1)

    state.mic = micState({ capturing: true, armed: true, level: 0.6 })
    tick()
    expect(published).toHaveLength(2)
  })

  it('publishes a mic failure even though the level did not move', () => {
    const { published, state, tick } = loopHarness()
    state.mic = micState({ error: { code: 'mic_denied', message: 'denied' } })
    tick()
    expect(published.at(-1)?.error?.code).toBe('mic_denied')
  })

  it('releases every reason on stop, and then stops ticking', () => {
    const { ducker, calls } = fakeDucker()
    const { loop, state, tick } = loopHarness(ducker)
    state.speaking = true
    state.mic = micState({ capturing: true, armed: true })
    tick()
    calls.length = 0

    loop.stop()
    expect(calls).toEqual(['coach=false', 'mic=false'])

    calls.length = 0
    tick()
    expect(calls).toEqual([])
  })

  it('works with no music at all — it still publishes mic state', () => {
    const { published, state, tick } = loopHarness(undefined)
    state.mic = micState({ capturing: true })
    tick()
    expect(published).toHaveLength(1)
  })

  it('quantises the level the same way in both directions', () => {
    expect(micLevelStep(0)).toBe(0)
    expect(micLevelStep(Number.NaN)).toBe(0)
    expect(micLevelStep(-1)).toBe(0)
    expect(micLevelStep(5)).toBe(micLevelStep(1))
    expect(sameMicState(MIC_OFF, MIC_OFF)).toBe(true)
  })
})
