/**
 * play_music, the first tool the USER can reach rather than the pose engine.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The handler is pure logic over an injected
 * controller, so everything here is real: validation, the truthfulness of the result,
 * and that a refused playback cannot crash the tool loop. What it cannot prove is that
 * any sound comes out — that needs a browser, an <audio> element and an autoplay
 * policy, none of which exist under vitest.
 *
 * The invariant every case below is really defending: the coach SPEAKS FROM the result.
 * An optimistic result is not a bug in a data structure, it is a coach telling the user
 * that music is playing when the room is silent.
 */
import { describe, expect, it } from 'vitest'
import { createToolHandlers } from '../toolHandlers'
import type { MusicController, MusicNowPlaying } from '../musicControl'
import { MUSIC_CONFIG, TRACK_IDS } from '../musicPlayer'
import type { TrackId } from '../musicPlayer'
import { TOOL_DEFS } from '../../types/tools'
import type { PlayMusicResult, ToolErrorResult, ToolRegistry } from '../../types/tools'

const HYPE: TrackId = 'hype'

interface Recorder {
  readonly played: (TrackId | undefined)[]
  stops: number
}

/** A controller that succeeds, plus the record of what it was asked to do. */
function fakeMusic(overrides: Partial<MusicController> = {}): {
  music: MusicController
  log: Recorder
} {
  const log: Recorder = { played: [], stops: 0 }
  let current: TrackId | null = null
  const music: MusicController = {
    play: async (track) => {
      log.played.push(track)
      const chosen = track ?? (TRACK_IDS[0] as TrackId)
      current = chosen
      const meta = MUSIC_CONFIG.tracks[chosen]
      return { track: chosen, label: meta.label, approxSec: meta.approxSec } satisfies MusicNowPlaying
    },
    stop: () => {
      log.stops += 1
      current = null
    },
    isPlaying: () => current !== null,
    currentTrack: () => current,
    ...overrides,
  }
  return { music, log }
}

function handlers(music: MusicController): ToolRegistry {
  return createToolHandlers({
    getWorkoutState: () => null,
    setPersona: () => true,
    showReference: () => true,
    logSet: () => true,
    music,
  })
}

/** Narrowing helper: every case asserts on one branch of the result union. */
async function call(registry: ToolRegistry, args: unknown): Promise<PlayMusicResult & ToolErrorResult> {
  return (await registry.play_music(args)) as PlayMusicResult & ToolErrorResult
}

describe('the tool definition the model actually sees', () => {
  it('is registered under the name the contract declares', () => {
    const { music } = fakeMusic()
    expect(Object.keys(handlers(music))).toContain('play_music')
  })

  it('enumerates track ids from TRACK_IDS, not from a hand-copied list', () => {
    const def = TOOL_DEFS.find((entry) => entry.name === 'play_music')
    expect(def).toBeDefined()
    const properties = def?.parameters.properties as Record<string, { enum?: readonly string[] }>
    // A second source of truth for what is on disk in public/music/ is exactly the
    // runtime-string drift that has already cost this repo four bugs.
    expect(properties.track?.enum).toEqual([...TRACK_IDS])
    expect(properties.action?.enum).toEqual(['play', 'stop'])
  })

  it('names the phrasings a user actually says, and says that talking is not acting', () => {
    const def = TOOL_DEFS.find((entry) => entry.name === 'play_music')
    const description = def?.description ?? ''
    // The measured failure mode was 0 tool calls in 6 runs from a prompt that described
    // a category instead of quoting the user. These are the anchors that fixed it.
    for (const phrase of ['give me some music', 'put on a song', 'hype me up', 'stop the music']) {
      expect(description).toContain(phrase)
    }
    expect(description).toMatch(/plays nothing|only thing that makes sound/i)
  })
})

describe('play_music success path', () => {
  it('reports what is playing, with a length it did not invent', async () => {
    const { music, log } = fakeMusic()
    const result = await call(handlers(music), { action: 'play', track: HYPE })
    expect(log.played).toEqual([HYPE])
    expect(result.playing).toBe(true)
    expect(result.track).toBe(HYPE)
    expect(result.label).toBe(MUSIC_CONFIG.tracks.hype.label)
    expect(result.approxSec).toBe(MUSIC_CONFIG.tracks.hype.approxSec)
    expect(result.detail).toContain(String(MUSIC_CONFIG.tracks.hype.approxSec))
  })

  it('defaults the track when the model omits one ("just play something")', async () => {
    const { music, log } = fakeMusic()
    const result = await call(handlers(music), { action: 'play' })
    // undefined, not a guessed id: musicPlayer owns the default.
    expect(log.played).toEqual([undefined])
    expect(result.track).toBe(TRACK_IDS[0])
    expect(result.playing).toBe(true)
  })

  it('accepts the sloppy casing a voice model produces', async () => {
    const { music } = fakeMusic()
    const result = await call(handlers(music), { action: ' PLAY ' })
    expect(result.playing).toBe(true)
  })
})

describe('play_music failure paths — the coach must not claim a track is on', () => {
  it('turns a browser refusal into a truthful result, never a throw', async () => {
    const { music } = fakeMusic({
      // The real refusal: autoplay policy, because a tool call triggered by speech is
      // not a click. It arrives as a rejected promise from inside play().
      play: () => Promise.reject(new Error('the browser refused to play music: NotAllowedError')),
    })
    const result = await call(handlers(music), { action: 'play' })
    expect(result.playing).toBe(false)
    expect(result.track).toBeNull()
    expect(result.approxSec).toBeNull()
    expect(result.detail).toContain('NotAllowedError')
    // No `error` key: this is a real outcome the coach can speak, not a malformed call.
    expect(result.error).toBeUndefined()
  })

  it('survives a controller that throws synchronously', async () => {
    const { music } = fakeMusic({
      play: () => {
        throw new Error('exploded before the promise')
      },
    })
    const result = await call(handlers(music), { action: 'play' })
    // Either shape is acceptable; silence is not. A missing function_call_output
    // leaves the model waiting on a reply that never comes.
    expect(result.playing === false || typeof result.error === 'string').toBe(true)
  })

  it('rejects an unknown track by name and lists the real ones', async () => {
    const { music, log } = fakeMusic()
    const result = await call(handlers(music), { action: 'play', track: 'lo-fi-beats' })
    expect(result.error).toContain('lo-fi-beats')
    expect(result.error).toContain(TRACK_IDS[0] as string)
    // Validated at the boundary: the player is never asked for a file that is not there.
    expect(log.played).toEqual([])
  })

  it('rejects an unknown action rather than guessing at it', async () => {
    const { music, log } = fakeMusic()
    const result = await call(handlers(music), { action: 'crank it' })
    expect(result.error).toContain('action must be')
    expect(log.played).toEqual([])
    expect(log.stops).toBe(0)
  })

  it('rejects a missing action', async () => {
    const { music } = fakeMusic()
    expect((await call(handlers(music), {})).error).toContain('action must be')
  })
})

describe('play_music stop path', () => {
  it('names the track it stopped, read before the player forgets it', async () => {
    const { music, log } = fakeMusic()
    const registry = handlers(music)
    await call(registry, { action: 'play', track: HYPE })
    const result = await call(registry, { action: 'stop' })
    expect(log.stops).toBe(1)
    expect(result.playing).toBe(false)
    expect(result.track).toBe(HYPE)
    expect(result.detail).toContain(MUSIC_CONFIG.tracks.hype.label)
  })

  it('is honest when there was nothing playing', async () => {
    const { music, log } = fakeMusic()
    const result = await call(handlers(music), { action: 'stop' })
    expect(result.playing).toBe(false)
    expect(result.detail).toBe('There was no music playing.')
    // Still forwarded: stopping an already-stopped player is harmless and idempotent,
    // where skipping it would leave a track running if isPlaying() ever lied.
    expect(log.stops).toBe(1)
  })
})
