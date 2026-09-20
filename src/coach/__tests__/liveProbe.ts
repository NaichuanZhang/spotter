/**
 * Harness for driving the REAL coach session against the live API with no microphone.
 *
 * The trick that makes two-way voice testable at all: Higgs TTS will generate the
 * USER's voice, and the realtime uplink takes raw PCM16 at 24 kHz. So a spoken turn
 * can be synthesised, fed through the exact AudioIn seam the browser uses, and the
 * server cannot tell the difference — it does its own VAD on whatever arrives.
 *
 * What is REAL here and what is faked, precisely, because a probe that fakes the thing
 * under test proves nothing:
 *   REAL — createCoachSession, buildSessionPayload, TOOL_DEFS, the persona prompts,
 *          createToolHandlers, micUplink's framing/gate/silence flush, socketTap, the
 *          WebSocket, the token mint, server VAD, the tool loop and response.create.
 *   FAKE — the microphone (prerecorded PCM instead of getUserMedia), the speakers
 *          (Node has no Web Audio; enqueue only records arrival times), the music
 *          player (no AudioContext), and the pose engine (static WorkoutState).
 *
 * Every outgoing frame is recorded by wrapping `createSocket`, which is how the probe
 * can PROVE the server opened a turn on its own: if no `response.create` left the
 * client between the last append and `response.created`, server VAD owns the turn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AUDIO_IN_CONFIG } from '../audioIn'
import type { AudioIn, AudioInOptions } from '../audioIn'
import type { AudioOut } from '../audioOut'
import { createCoachSession } from '../session'
import type { CoachSession } from '../session'
import { createToolHandlers } from '../toolHandlers'
import type { MusicController, MusicNowPlaying } from '../musicControl'
import { MUSIC_CONFIG, TRACK_IDS } from '../musicPlayer'
import type { TrackId } from '../musicPlayer'
import type { WorkoutState } from '../../types/events'
import type { PersonaId, ToolRegistry } from '../../types/tools'

// --------------------------------------------------------------------- config

export const PROBE = {
  key: process.env.BOSON_API_KEY ?? '',
  live: process.env.SPOTTER_LIVE === '1',
  clientSecrets: 'https://api.boson.ai/v1/realtime/client_secrets',
  tokenTtlSec: 600,
  speech: 'https://api.boson.ai/v1/audio/speech',
  /** `higgs-tts-3` does not exist on this key; /v1/models lists `higgs-tts-v3`. */
  ttsModel: 'higgs-tts-v3',
  /** A different voice from any coach persona, so a transcript cannot be confused. */
  ttsVoice: 'chloe',
  /** What the uplink requires. Anything else is resampled by `ttsPcm24k`. */
  targetRate: AUDIO_IN_CONFIG.sampleRate,
  cacheDir: '/tmp/spotter-tts-cache',
  /** One audioIn buffer at 2048 frames / 24 kHz. Paces the fake mic in real time. */
  chunkMs: Math.round((AUDIO_IN_CONFIG.bufferSize / AUDIO_IN_CONFIG.sampleRate) * 1000),
} as const

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/**
 * Transcript sink. A file, not just console.warn, because vitest's reporter swallows
 * worker console output — and the transcript IS the result of a live probe.
 */
export const LOG_PATH = process.env.SPOTTER_LIVE_LOG ?? '/tmp/spotter-live.log'

export function say(line: string): void {
  appendFileSync(LOG_PATH, `${line}\n`)
  console.warn(line)
}

// ------------------------------------------------------------------------ TTS

interface WavInfo {
  readonly rate: number
  readonly channels: number
  readonly bits: number
  readonly samples: Int16Array
}

/** Walks the chunk list rather than assuming a 44-byte header. */
function parseWav(buffer: Buffer): WavInfo {
  let offset = 12
  let rate = 0
  let channels = 0
  let bits = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      rate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    }
    if (id === 'data') {
      const end = Math.min(body + size, buffer.length)
      const bytes = buffer.subarray(body, end)
      const samples = new Int16Array(bytes.byteLength / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
      return { rate, channels, bits, samples }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk in the TTS response')
}

function downmix(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const mono = new Int16Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c] ?? 0
    mono[i] = Math.round(sum / channels)
  }
  return mono
}

/**
 * Linear resample. Only runs if the endpoint ever stops returning 24 kHz — sending the
 * wrong rate is the most likely silent failure in this whole probe, because the server
 * accepts it and simply never hears a word.
 */
function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples
  const ratio = to / from
  const out = new Int16Array(Math.floor(samples.length * ratio))
  for (let i = 0; i < out.length; i++) {
    const source = i / ratio
    const low = Math.floor(source)
    const high = Math.min(low + 1, samples.length - 1)
    const t = source - low
    out[i] = Math.round((samples[low] ?? 0) * (1 - t) + (samples[high] ?? 0) * t)
  }
  return out
}

export interface SpokenClip {
  readonly text: string
  readonly samples: Int16Array
  readonly seconds: number
  /** What the endpoint actually returned, so the log states it rather than assuming it. */
  readonly sourceRate: number
  readonly rms: number
}

export function rmsOf(samples: Int16Array): number {
  let sum = 0
  for (const sample of samples) {
    const n = sample / 32768
    sum += n * n
  }
  return Math.sqrt(sum / (samples.length || 1))
}

/** Synthesises one user utterance as 24 kHz mono PCM16, cached on disk between runs. */
export async function ttsPcm24k(text: string, voice: string = PROBE.ttsVoice): Promise<SpokenClip> {
  mkdirSync(PROBE.cacheDir, { recursive: true })
  const key = createHash('sha1').update(`${PROBE.ttsModel}|${voice}|${text}`).digest('hex').slice(0, 16)
  const path = `${PROBE.cacheDir}/${key}.wav`
  // The speech endpoint 429s readily, so synthesis retries and the result is cached on
  // disk: a rate limit while PREPARING a probe must not be reported as a probe failure.
  for (let attempt = 0; !existsSync(path); attempt++) {
    const res = await fetch(PROBE.speech, {
      method: 'POST',
      headers: { authorization: `Bearer ${PROBE.key}`, 'content-type': 'application/json' },
      // wav, NOT pcm: the header is the only place the endpoint states its sample rate,
      // and guessing it is how a probe silently tests nothing.
      body: JSON.stringify({ model: PROBE.ttsModel, voice, response_format: 'wav', input: text }),
    })
    if (res.ok) {
      writeFileSync(path, Buffer.from(await res.arrayBuffer()))
      break
    }
    const detail = await res.text()
    if (res.status !== 429 || attempt >= 4) throw new Error(`TTS ${res.status}: ${detail}`)
    await sleep(4_000 * (attempt + 1))
  }
  const wav = parseWav(readFileSync(path))
  if (wav.bits !== 16) throw new Error(`TTS returned ${wav.bits}-bit audio; the uplink needs PCM16`)
  const samples = resample(downmix(wav.samples, wav.channels), wav.rate, PROBE.targetRate)
  return {
    text,
    samples,
    seconds: samples.length / PROBE.targetRate,
    sourceRate: wav.rate,
    rms: rmsOf(samples),
  }
}

/**
 * Room tone for the negative control. Above audioIn's silence floor on purpose — the
 * question is not whether digital zeros trigger VAD (nothing would) but whether the
 * background level a real mic with autoGainControl produces trips it.
 */
export function roomTone(seconds: number, rms: number): Int16Array {
  const samples = new Int16Array(Math.round(seconds * PROBE.targetRate))
  const amplitude = rms * Math.sqrt(3) * 32768
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round((Math.random() * 2 - 1) * amplitude)
  }
  return samples
}

// ------------------------------------------------------------------ fake mic

export interface FakeMic {
  readonly createAudioIn: (options: AudioInOptions) => AudioIn
  /** Streams one clip through the capture path in ~real time. Resolves at its end. */
  speak(samples: Int16Array): Promise<void>
  /** Buffers that passed the gate and the silence floor. */
  passed(): number
  /**
   * performance.now() of the last buffer of REAL audio. Distinct from the last
   * `input_audio_buffer.append` on the wire, because micUplink appends its own silence
   * after this — and the latency of a spoken turn has to be quoted against both.
   */
  lastPassedAt(): number
}

/**
 * Stands in for the browser microphone and nothing else: it honours `gateOpen` and
 * AUDIO_IN_CONFIG.silenceFloor exactly as audioIn does, so what reaches the server is
 * what a user talking into a laptop would produce.
 */
export function createFakeMic(): FakeMic {
  let hooks: AudioInOptions | null = null
  let capturing = false
  let gated = false
  let level = 0
  let sent = 0
  let lastPassedAt = 0

  function base64(samples: Int16Array): string {
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64')
  }

  return {
    createAudioIn: (options) => {
      hooks = options
      return {
        start: async () => {
          capturing = true
        },
        stop: () => {
          capturing = false
        },
        level: () => level,
        isCapturing: () => capturing,
        isGated: () => gated,
      }
    },
    speak: (samples) =>
      new Promise<void>((resolve) => {
        const options = hooks
        if (!options || !capturing) {
          resolve()
          return
        }
        let cursor = 0
        const timer = setInterval(() => {
          if (cursor >= samples.length) {
            clearInterval(timer)
            level = 0
            resolve()
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
          level = rmsOf(slice)
          if (level < AUDIO_IN_CONFIG.silenceFloor) return
          sent += 1
          lastPassedAt = performance.now()
          options.onChunk(base64(slice))
        }, PROBE.chunkMs)
      }),
    passed: () => sent,
    lastPassedAt: () => lastPassedAt,
  }
}

// ------------------------------------------------------------- fake speakers

export interface FakeAudioOut {
  readonly audio: AudioOut
  /** performance.now() of every response.output_audio.delta that reached playback. */
  readonly deltaAt: readonly number[]
}

/**
 * How long after the last audio chunk a simulated speaker is still considered audible.
 *
 * Stands in for audioOut's real answer, which is "seconds still scheduled ahead of the
 * audio clock" — and the gap between DELIVERY and PLAYOUT is why this is seconds and not
 * milliseconds: the server streams a four-second utterance in about 300 ms of wall time,
 * so an interval keyed to delivery would report the coach silent while it is still
 * talking out loud. That is precisely the window in which a mic hears the coach.
 */
export const SPEAKING_TAIL_MS = 4_000

/**
 * Node has no Web Audio, so playback is a sink that records arrival times.
 *
 * `speaks` decides what `isSpeaking()` answers, and that is the most consequential knob
 * in this harness. False (the default) holds the mic gate OPEN for the whole probe, which
 * is what you want when the question is "does the server hear us". True makes the gate
 * behave as it does in a room with speakers — closed while the coach is audible — which
 * is the only way to test the half-duplex rule against the real server.
 */
export function createFakeAudioOut(speaks = false): FakeAudioOut {
  const deltaAt: number[] = []
  const lastAt = (): number => deltaAt[deltaAt.length - 1] ?? Number.NEGATIVE_INFINITY
  return {
    deltaAt,
    audio: {
      unlock: () => Promise.resolve(),
      unlocked: () => true,
      enqueue: () => {
        deltaAt.push(performance.now())
      },
      stop: () => {
        deltaAt.length = 0
      },
      setEmphasis: () => {},
      isSpeaking: () => speaks && performance.now() - lastAt() < SPEAKING_TAIL_MS,
      level: () => 0,
      queuedSec: () => 0,
      close: () => Promise.resolve(),
    },
  }
}

// ------------------------------------------------------------------- the probe

export interface Frame {
  readonly at: number
  readonly type: string
  readonly bytes: number
}

export interface ServerFrame {
  readonly at: number
  readonly type: string
  readonly payload: Record<string, unknown>
}

export interface ToolInvocation {
  readonly at: number
  readonly name: string
  readonly args: unknown
}

export interface Probe {
  readonly session: CoachSession
  readonly mic: FakeMic
  /** Every frame the client sent, in order. The proof that we sent no response.create. */
  readonly sent: readonly Frame[]
  /** Every frame the server sent, verbatim types with arrival times. */
  readonly received: readonly ServerFrame[]
  readonly tools: readonly ToolInvocation[]
  readonly captions: readonly string[]
  readonly errors: readonly string[]
  readonly debug: readonly string[]
  readonly audioDeltaAt: readonly number[]
  readonly music: { plays: TrackId[]; stops: number; playing: boolean }
  /** Types seen, in first-seen order — the one-line summary for a report. */
  types(): string[]
  count(type: string): number
  /** First arrival of a server event after `after`, or null. */
  firstAt(type: string, after?: number): number | null
  lastSentAt(type: string): number | null
}

export interface ProbeOptions {
  readonly persona?: PersonaId
  readonly workout?: WorkoutState
  /** Fail play_music the way a browser autoplay refusal does. */
  readonly refuseMusic?: boolean
  /**
   * Make isSpeaking() answer truthfully while the coach's audio is arriving, so the mic
   * gate closes exactly as it does in a room with speakers. Off by default.
   */
  readonly simulateSpeaker?: boolean
}

const DEFAULT_WORKOUT: WorkoutState = Object.freeze({
  target: 20,
  totalReps: 7,
  cleanReps: 4,
  phase: 'top' as const,
  activeFaults: [],
  setElapsedSec: 46,
  inFrame: true,
})

/** Mints against Boson directly: there is no /api/session in Node. */
function tokenFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    method: 'POST',
    headers: { authorization: `Bearer ${PROBE.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expires_after: { seconds: PROBE.tokenTtlSec } }),
  })
}

export function createProbe(options: ProbeOptions = {}): Probe {
  const sent: Frame[] = []
  const received: ServerFrame[] = []
  const tools: ToolInvocation[] = []
  const captions: string[] = []
  const errors: string[] = []
  const debug: string[] = []
  const music = { plays: [] as TrackId[], stops: 0, playing: false }
  const mic = createFakeMic()
  const speakers = createFakeAudioOut(options.simulateSpeaker === true)

  const controller: MusicController = {
    play: async (track) => {
      if (options.refuseMusic) throw new Error('the browser refused to play music: NotAllowedError')
      const id: TrackId = track ?? (TRACK_IDS[0] as TrackId)
      const meta = MUSIC_CONFIG.tracks[id]
      music.plays.push(id)
      music.playing = true
      const now: MusicNowPlaying = { track: id, label: meta.label, approxSec: meta.approxSec }
      return now
    },
    stop: () => {
      music.stops += 1
      music.playing = false
    },
    isPlaying: () => music.playing,
    currentTrack: () => (music.playing ? ((TRACK_IDS[0] as TrackId) ?? null) : null),
  }

  // The SHIPPED handlers, so the probe exercises toolHandlers.ts rather than a stand-in.
  const registry: ToolRegistry = createToolHandlers({
    getWorkoutState: () => options.workout ?? DEFAULT_WORKOUT,
    setPersona: () => true,
    showReference: () => true,
    logSet: () => true,
    music: controller,
  })

  const createSocket = (url: string, protocols: string[]): WebSocket => {
    const socket = new WebSocket(url, protocols)
    const raw = socket.send.bind(socket)
    const patch = socket as unknown as { send: (data: string) => void }
    patch.send = (data: string) => {
      let type = 'unparsed'
      try {
        const parsed: unknown = JSON.parse(data)
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          type = String((parsed as { type: unknown }).type)
        }
      } catch {
        /* recorded as unparsed */
      }
      sent.push({ at: performance.now(), type, bytes: data.length })
      raw(data)
    }
    // Additive listener: higgsSocket owns `onmessage`, and both fire.
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      try {
        const parsed: unknown = JSON.parse(event.data)
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          const payload = parsed as Record<string, unknown>
          received.push({ at: performance.now(), type: String(payload.type), payload })
        }
      } catch {
        /* ignored: higgsSocket reports malformed JSON itself */
      }
    })
    return socket
  }

  const session = createCoachSession({
    persona: options.persona ?? 'mean',
    registry: wrapRegistry(registry, tools),
    audio: speakers.audio,
    createAudioIn: mic.createAudioIn,
    music: { setDucked: () => {}, stop: () => controller.stop() },
    socket: { tokenEndpoint: PROBE.clientSecrets, fetchImpl: tokenFetch, createSocket },
    onDebug: (message) => debug.push(message),
    onError: (error) => errors.push(`${error.kind}: ${error.message}`),
    onCaption: (caption) => {
      if (caption.final) captions.push(caption.text)
    },
  })

  return {
    session,
    mic,
    sent,
    received,
    tools,
    captions,
    errors,
    debug,
    audioDeltaAt: speakers.deltaAt,
    music,
    types: () => [...new Set(received.map((frame) => frame.type))],
    count: (type) => received.filter((frame) => frame.type === type).length,
    firstAt: (type, after = 0) =>
      received.find((frame) => frame.type === type && frame.at >= after)?.at ?? null,
    lastSentAt: (type) => {
      const matches = sent.filter((frame) => frame.type === type)
      return matches.length > 0 ? (matches[matches.length - 1]?.at ?? null) : null
    },
  }
}

/** Records what the model asked for without changing what the shipped handler returns. */
function wrapRegistry(registry: ToolRegistry, log: ToolInvocation[]): ToolRegistry {
  const entries = Object.entries(registry).map(([name, handler]) => [
    name,
    (args: unknown) => {
      log.push({ at: performance.now(), name, args })
      return handler(args)
    },
  ])
  return Object.fromEntries(entries) as ToolRegistry
}

/** One-line-per-frame dump. The point of a live probe is the transcript, not a boolean. */
export function transcriptOf(probe: Probe, label: string): string {
  const lines = [
    `=== ${label} ===`,
    `sent:     ${probe.sent.map((frame) => frame.type).join(' -> ')}`,
    `received: ${probe.received.map((frame) => frame.type).join(' -> ')}`,
    `tools:    ${probe.tools.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join(' ; ')}`,
    `captions: ${probe.captions.join(' | ')}`,
    `errors:   ${probe.errors.join(' | ')}`,
    `mic:      ${JSON.stringify(probe.session.getMicState())} passed=${probe.mic.passed()}`,
  ]
  return lines.join('\n')
}
