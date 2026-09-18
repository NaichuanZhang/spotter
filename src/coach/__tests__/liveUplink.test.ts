/**
 * LIVE probe for the mic uplink. Skipped unless you ask for it:
 *
 *   say -v Samantha -r 180 -o /tmp/spotter-say.aiff "Hey coach, put on a song for me. I need a beat."
 *   afconvert /tmp/spotter-say.aiff -f WAVE -d LEI16@24000 -c 1 /tmp/spotter-say.wav
 *   SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveUplink
 *
 * Everything else in this repo's coach tests runs against fakes, which can prove the
 * frames are SHAPED right and never that the server accepts them. This one drives the
 * real createCoachSession — real token mint, real WebSocket, real session payload,
 * real TOOL_DEFS — and substitutes only the microphone, feeding it prerecorded 24 kHz
 * PCM16 through exactly the AudioIn seam the browser uses. So what it proves is the one
 * thing no fake can: that `input_audio_buffer.append` is accepted and that the server's
 * VAD actually hears it.
 *
 * It is skipped by default because it costs a real session, and the voices API 429s
 * intermittently and then terminates the session before the ack — so run it ONCE, with
 * a pause, never in a loop.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCoachSession } from '../session'
import { AUDIO_IN_CONFIG } from '../audioIn'
import type { AudioIn, AudioInOptions } from '../audioIn'
import type { AudioOut } from '../audioOut'
import type { ToolRegistry } from '../../types/tools'

const LIVE = process.env.SPOTTER_LIVE === '1'
const KEY = process.env.BOSON_API_KEY ?? ''
const PCM_PATH = process.env.SPOTTER_LIVE_PCM ?? '/tmp/spotter-say.wav'

/** Minting has to happen against Boson directly here; there is no /api/session in Node. */
const CLIENT_SECRETS_URL = 'https://api.boson.ai/v1/realtime/client_secrets'
const TOKEN_TTL_SEC = 600
/** Real-time pacing: one AUDIO_IN_CONFIG.bufferSize buffer is ~85 ms at 24 kHz. */
const CHUNK_MS = Math.round((AUDIO_IN_CONFIG.bufferSize / AUDIO_IN_CONFIG.sampleRate) * 1000)
/** How long to listen for the server's reaction after the last buffer goes out. */
const SETTLE_MS = 12_000

// ---------------------------------------------------------------------- wav input

/** Locates the `data` chunk rather than assuming a 44-byte header; afconvert adds more. */
function readWavPcm16(path: string): Int16Array {
  const buffer = readFileSync(path)
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      return new Int16Array(buffer.buffer.slice(buffer.byteOffset + start, buffer.byteOffset + start + size))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

function base64Pcm16(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64')
}

/** The same RMS-over-the-buffer rule audioIn applies before it decides to send. */
function rms(samples: Int16Array): number {
  let sum = 0
  for (const sample of samples) {
    const normalised = sample / 32768
    sum += normalised * normalised
  }
  return Math.sqrt(sum / (samples.length || 1))
}

/**
 * Stands in for the browser microphone and NOTHING else. It honours `gateOpen` and the
 * silence floor exactly as audioIn does, so what reaches the server is what a real user
 * speaking into a laptop would produce.
 */
function recordedAudioIn(samples: Int16Array, onDone: () => void) {
  return (options: AudioInOptions): AudioIn => {
    let timer: ReturnType<typeof setInterval> | null = null
    let cursor = 0
    let capturing = false
    let gated = false
    let level = 0

    return {
      start: async () => {
        capturing = true
        timer = setInterval(() => {
          if (cursor >= samples.length) {
            if (timer) clearInterval(timer)
            timer = null
            onDone()
            return
          }
          const slice = samples.subarray(cursor, cursor + AUDIO_IN_CONFIG.bufferSize)
          cursor += AUDIO_IN_CONFIG.bufferSize
          if (!options.gateOpen()) {
            gated = true
            level = 0
            return
          }
          gated = false
          level = rms(slice)
          if (level < AUDIO_IN_CONFIG.silenceFloor) return
          options.onChunk(base64Pcm16(slice))
        }, CHUNK_MS)
      },
      stop: () => {
        if (timer) clearInterval(timer)
        timer = null
        capturing = false
      },
      level: () => level,
      isCapturing: () => capturing,
      isGated: () => gated,
    }
  }
}

/** Node has no Web Audio. isSpeaking() false keeps the gate open for the whole clip. */
function silentAudioOut(): AudioOut {
  return {
    unlock: () => Promise.resolve(),
    unlocked: () => true,
    enqueue: () => {},
    stop: () => {},
    setEmphasis: () => {},
    isSpeaking: () => false,
    level: () => 0,
    queuedSec: () => 0,
    close: () => Promise.resolve(),
  }
}

const tokenFetch = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, {
    ...init,
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: TOKEN_TTL_SEC } }),
  })

describe.skipIf(!LIVE || KEY === '')('live: the server hears the uplink', () => {
  it('accepts input_audio_buffer.append and reports speech', async () => {
    const samples = readWavPcm16(PCM_PATH)
    const debugLines: string[] = []
    const errors: string[] = []
    const toolCalls: string[] = []
    let finished = () => {}
    const clipDone = new Promise<void>((resolve) => {
      finished = resolve
    })

    const registry = {
      play_music: (args: unknown) => {
        toolCalls.push(`play_music ${JSON.stringify(args)}`)
        return {
          action: 'play' as const,
          playing: true,
          track: 'hype' as const,
          label: 'Hype',
          approxSec: 35,
          detail: 'Hype is playing now, about 35 seconds of it.',
        }
      },
    } as unknown as ToolRegistry

    const session = createCoachSession({
      persona: 'mean',
      registry,
      audio: silentAudioOut(),
      createAudioIn: recordedAudioIn(samples, finished),
      socket: { tokenEndpoint: CLIENT_SECRETS_URL, fetchImpl: tokenFetch },
      onDebug: (message) => debugLines.push(message),
      onError: (error) => errors.push(`${error.kind}: ${error.message}`),
    })

    await session.connect()
    await clipDone
    await new Promise((done) => setTimeout(done, SETTLE_MS))
    session.disconnect()

    // Printed because the point of this probe is the transcript, not a boolean.
    console.warn('[live] debug:', debugLines.join('\n  '))
    console.warn('[live] errors:', errors)
    console.warn('[live] tool calls:', toolCalls)
    console.warn('[live] mic:', JSON.stringify(session.getMicState()))

    // The server tells us it heard a turn start. Nothing else in this repo can prove
    // a byte left the browser.
    expect(debugLines.join('\n')).toContain('input_audio_buffer.speech_started')
    expect(errors.filter((line) => line.includes('input_audio_buffer'))).toEqual([])
    await session.destroy()
  }, 90_000)
})
