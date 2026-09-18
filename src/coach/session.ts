/**
 * The coach session: policy on top of the raw protocol in higgsSocket.ts.
 *
 * Owns six things that are each a demo-killer if missed:
 *   1. Persona hot-swap — session.update with new instructions + voice, no reconnect.
 *   2. A 4-minute heartbeat — the session closes after 5 minutes without user
 *      *speech*, and a set of pushups is grunting, not talking.
 *   3. Reconnect with backoff that reseeds workout state into the fresh session.
 *   4. The tool loop, including the mandatory response.create after every reply.
 *   5. The MIC UPLINK, i.e. the half of the conversation that used to be missing.
 *   6. Music ducking, whose two reasons live on either side of that uplink.
 *
 * Also owns barge-in. Pose events are time-critical: a bark about rep 3 arriving
 * during rep 7 is worse than a clipped sentence, so a new event cuts audio that is
 * still streaming or badly backlogged — but lets a finished short line play out.
 *
 * ── THE UPLINK, AND WHY IT TAPS THE SOCKET FACTORY ──────────────────────────
 * `input_audio_buffer.append` has to go out on the SAME socket the connection uses,
 * and HiggsConnection deliberately exposes only the policy frames it knows about —
 * there is no raw send. Rather than fork the transport (which would duplicate its
 * dedupe, ack and close state), this file wraps the `createSocket` seam OpenOptions
 * already provides for tests, and keeps the resulting WebSocket beside `conn`. The
 * socket is only promoted to `liveSocket` once openHiggsSocket RESOLVES: a failed
 * attempt builds a socket too, and appending audio to that one is shouting into a
 * corpse while the real session is elsewhere.
 */

import { toEventLine } from '../types/events'
import type { CoachEvent, Severity, WorkoutState } from '../types/events'
import type { PersonaId, ToolRegistry, ToolResult } from '../types/tools'
import { createAudioOut } from './audioOut'
import type { AudioOut } from './audioOut'
import type { AudioIn, AudioInOptions } from './audioIn'
import { createMicUplink, MIC_OFF } from './micUplink'
import type { MicState, MicUplink } from './micUplink'
import { duckReasonsFor, NO_DUCK, syncDuck } from './musicControl'
import type { DuckReasons, MusicDucker } from './musicControl'
import {
  classifyClose,
  clampSpeed,
  CoachError,
  isRetryable,
  isToolName,
  openHiggsSocket,
} from './higgsSocket'
import type {
  CoachErrorKind,
  HiggsCallbacks,
  HiggsConnection,
  OpenOptions,
  ToolCall,
} from './higgsSocket'
import { DEFAULT_PERSONA_ID, getPersona, isPersonaId } from './personas'
import type { Persona } from './personas'

export const COACH_TIMING = {
  /** Push a keepalive if nothing else has been pushed for this long. */
  heartbeatMs: 4 * 60 * 1000,
  /** How often we check whether a keepalive is due. */
  heartbeatCheckMs: 30_000,
  reconnectBaseMs: 600,
  reconnectMaxMs: 15_000,
  reconnectFactor: 2,
  /** +/- fraction applied to each backoff delay. */
  reconnectJitter: 0.3,
  reconnectMaxAttempts: 6,
  /** Close code 1013 means someone else holds the session; wait longer. */
  rateLimitedFloorMs: 6_000,
  /** Audio already queued beyond this is stale enough to cut on a new event. */
  bargeInBacklogSec: 1.2,
  /** Failsafe: stop discarding even if response.done never arrives. */
  discardWindowMs: 6_000,
  /**
   * How often the duck reasons are recomputed. Polled rather than evented because
   * neither input is an event: `audioOut.isSpeaking()` is derived from how much audio
   * is still scheduled ahead of the clock, and response.done fires while seconds of it
   * are still queued. 100 ms is comfortably inside musicPlayer's 180 ms duck ramp, so
   * the level is already moving before the first syllable lands.
   */
  duckTickMs: 100,
} as const

/**
 * OFF, and the reason is a live measurement that falsified the plan this came from.
 *
 * The idea was a speed-only `session.update` before each event, so a severe fault
 * is delivered faster than a routine rep callout. The stated premise was that a
 * patch carrying no `voice` would skip the rate-limited server-side voices lookup.
 * IT DOES NOT. Measured over two runs of 20 consecutive speed-only patches in one
 * live session, every patch answered exactly once — either an ack or an error:
 *
 *   gap 300ms:  12 acks / 8 error frames  (40%)
 *   gap 2500ms: 19 acks / 1 error frame   (5%)
 *
 * and every error read "Could not validate voice 'jake': voices API returned HTTP
 * 429" — for a frame that contains no voice at all. The server re-validates the
 * session's CURRENT voice on every session.update regardless of what the patch
 * carries, so there is no such thing as a lookup-free partial patch.
 *
 * Mitigating, and the reason this is a flag rather than a deletion: post-ack that
 * error is NOT fatal. Both sessions stayed open, audio still flowed afterwards
 * (38 kB and 46 kB), and a rejected patch is a plain no-op that leaves the previous
 * pace in place. The cost is a CoachError per failure reaching options.onError, and
 * one in five to one in twenty severe barks silently running at routine pace.
 * The acked patches DID apply — the echoed speeds alternated 1.12/1.25 exactly —
 * so the lever works; it is the delivery channel that is unreliable.
 *
 * Per-severity dynamics therefore ship through the two levers that cost nothing on
 * the wire: the orthography ladder in CORE (model-mediated) and setEmphasis
 * (client-side, deterministic). Flip this to true only after deciding a 5% error
 * rate at realistic event spacing is acceptable in the UI's error path.
 *
 * Annotated `boolean` on purpose: `as const` would narrow it to `false` and make
 * the guarded branch look like dead code to every reader and tool.
 */
export const PER_EVENT_PACE_ENABLED: boolean = false

/**
 * Per-event pace multiplier, applied on top of the persona's base `speed` only
 * while PER_EVENT_PACE_ENABLED is true.
 *
 * audio.output.speed is undocumented but exact — duration = base/speed across
 * 0.25-4.0 — and changeable mid-session: six changes inside one WebSocket, the
 * duration tracked every one. It buys URGENCY, not loudness: RMS was flat across
 * the entire range. Because it is a naive resample, pitch rises with it, so these
 * multipliers stay small and higgsSocket clamps the product to speedSafeMax
 * (Mean's 1.12 x 1.12 = 1.254 lands on the 1.25 ceiling).
 *
 * `minor` is deliberately exactly 1.0 so a clean-rep stream sends no frame at all.
 */
export const URGENCY_SPEED: Readonly<Record<Severity, number>> = Object.freeze({
  minor: 1.0,
  major: 1.06,
  severe: 1.12,
})

/**
 * Voice validation happens server-side on every non-`default` voice and answers
 * HTTP 429 in roughly 1 attempt in 7, terminating the session before the ack.
 * The right response is to retry the SAME voice — the voice name was never the
 * problem, so spending the fallback on it is how a persona loses its identity.
 */
export const VOICE_RETRY = { attempts: 3, delayMs: 2_000 } as const

/** Innocuous, prefixed like every other pushed line so it cannot be read aloud. */
export const HEARTBEAT_LINE = '[EVENT] keepalive — no reply needed'

export type CoachStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error'

export interface CoachCaption {
  text: string
  /** False for streaming partials, true for the completed utterance. */
  final: boolean
  persona: PersonaId
}

export interface CoachSessionOptions {
  persona?: PersonaId
  /** Can also be supplied later with setRegistry(), which avoids a construction cycle. */
  registry?: ToolRegistry
  audio?: AudioOut
  socket?: OpenOptions
  /** Read after a reconnect so the fresh session knows where the set stands. */
  getWorkoutState?: () => WorkoutState | null
  onStatus?: (status: CoachStatus) => void
  onCaption?: (caption: CoachCaption) => void
  onError?: (error: CoachError) => void
  onPersonaChange?: (persona: Persona) => void
  onDebug?: (message: string, detail?: unknown) => void
  /** Cut stale audio when a new pose event arrives. Default true. */
  interruptOnEvent?: boolean
  /** Let a user-initiated persona swap greet in character. Default true. */
  announceOnPersonaSwap?: boolean
  /** Wait between same-voice retries after a voices-API 429. Tests pass 0. */
  voiceRetryDelayMs?: number
  /**
   * Music, as the duck-and-stop view only. Omit it and the session simply never
   * ducks — nothing else changes, and play_music still works through its own
   * controller in App. Passing the player here does NOT let the session start a track.
   */
  music?: MusicDucker
  /**
   * Mic uplink. Default ON — two-way voice is the point. Set false to run the
   * one-way pose-driven demo with no microphone permission prompt at all.
   */
  micEnabled?: boolean
  /** Injected in tests, which have no getUserMedia. */
  createAudioIn?: (options: AudioInOptions) => AudioIn
  /** Fired when the mic's reported state changes materially (armed, gated, failed). */
  onMicState?: (state: MicState) => void
}

export interface CoachSession {
  /** Mints a token and opens the socket. Rejects on failure; no silent retry here. */
  connect: () => Promise<void>
  disconnect: () => void
  destroy: () => Promise<void>
  pushEvent: (event: CoachEvent) => void
  /** Typed user turn. The spoken path is the mic uplink, which needs no call here. */
  sendUserText: (text: string) => void
  setPersona: (persona: PersonaId) => void
  setRegistry: (registry: ToolRegistry) => void
  getPersona: () => Persona
  getStatus: () => CoachStatus
  /** Must be called from a user gesture before the coach can be heard. */
  unlockAudio: () => Promise<void>
  /**
   * Mic health for the UI. A denied mic degrades VISIBLY — `error` is set, `capturing`
   * is false, and the HUD shows OFF — rather than looking like a coach that ignores you.
   */
  getMicState: () => MicState
  /**
   * Stop any track. Exposed because music outlives a socket: R (reconnect) or leaving
   * the workout would otherwise leave 35 seconds of hype playing over a dead session.
   */
  stopMusic: () => void
  audio: AudioOut
}

type Timer = ReturnType<typeof setTimeout>

export function createCoachSession(options: CoachSessionOptions = {}): CoachSession {
  const audio = options.audio ?? createAudioOut({ onWarn: (m) => debug(`audio: ${m}`) })
  const voiceOverrides = new Map<PersonaId, string>()

  let personaId: PersonaId = options.persona ?? DEFAULT_PERSONA_ID
  let registry: ToolRegistry | null = options.registry ?? null
  let conn: HiggsConnection | null = null
  let status: CoachStatus = 'idle'
  let userClosed = false
  let attempts = 0
  let hasConnectedOnce = false
  let lastPushAt = 0
  /** Last `speed` the server was told about, so an unchanged value sends no frame. */
  let sentSpeed = 0
  let captionBuffer = ''
  let discardUntil = 0
  let handlingToolCall = false
  let heartbeatTimer: Timer | null = null
  let reconnectTimer: Timer | null = null
  let duckTimer: Timer | null = null
  /** Bumped per open attempt, so a socket we gave up on cannot close the one that replaced it. */
  let generation = 0
  /** The socket behind `conn`, kept only so mic frames can be appended to it. */
  let liveSocket: WebSocket | null = null
  /** Built by the createSocket tap; promoted to liveSocket only on a successful open. */
  let pendingSocket: WebSocket | null = null
  let duckReasons: DuckReasons = NO_DUCK
  let lastMicState: MicState = MIC_OFF

  function debug(message: string, detail?: unknown): void {
    options.onDebug?.(message, detail)
  }

  function report(error: CoachError): void {
    options.onError?.(error)
  }

  function setStatus(next: CoachStatus): void {
    if (status === next) return
    status = next
    options.onStatus?.(next)
  }

  // ------------------------------------------------------------ uplink + ducking

  /**
   * Wraps the caller's socket factory so the raw WebSocket stays reachable. The
   * default branch is the same `new WebSocket(url, protocols)` higgsSocket would have
   * used, so injecting a tap changes nothing about how the socket is opened.
   */
  function socketOptions(): OpenOptions {
    const base = options.socket ?? {}
    const create =
      base.createSocket ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols))
    return {
      ...base,
      createSocket: (url, protocols) => {
        const socket = create(url, protocols)
        pendingSocket = socket
        return socket
      },
    }
  }

  /**
   * One `input_audio_buffer.append`, and NOTHING else — no input_audio_buffer.commit
   * and no response.create. turn_detection is server_vad, so the server decides where
   * the user's turn ended; committing would cut them off mid-sentence and a
   * response.create would have the coach answer a turn twice.
   *
   * Deliberately does NOT touch `lastPushAt`. That timestamp guards the 4-minute
   * keepalive against the server's 5-minute no-speech close, and mic buffers are not
   * proof of speech — a quiet room still produces buffers above the silence floor. If
   * the user really is talking, the server's own idle timer is reset by the audio, and
   * the extra keepalive is harmless either way.
   */
  function sendMicFrame(frame: Record<string, unknown>): boolean {
    const socket = liveSocket
    if (!conn?.isOpen() || !socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch (cause) {
      report(new CoachError('audio', 'could not send a microphone buffer', cause))
      return false
    }
  }

  const mic: MicUplink = createMicUplink({
    send: sendMicFrame,
    /**
     * THE GATE. audioOut owns "is the coach speaking"; asking it per buffer rather
     * than keeping a copy here is what stops the two drifting apart — and a drifted
     * gate means the mic hears the coach, server VAD calls it a user turn, and the
     * model answers its own last sentence on stage.
     */
    isCoachSpeaking: () => audio.isSpeaking(),
    onFailure: (failure) => {
      // Surfaced, never swallowed — and never fatal. The pose-driven one-way coaching
      // is the product; two-way is additive, so a denied mic degrades and carries on.
      report(new CoachError('audio', `microphone unavailable (${failure.code}): ${failure.message}`))
      publishMicState()
    },
    onDebug: debug,
    createAudioIn: options.createAudioIn,
  })

  function publishMicState(): void {
    const next = mic.state()
    if (sameMicState(lastMicState, next)) return
    lastMicState = next
    options.onMicState?.(next)
  }

  /**
   * Recomputes BOTH duck reasons every tick and applies only the transitions. Both
   * edges, always: 'coach' and 'mic' overlap constantly, and a caller that sets one
   * and forgets to clear it leaves the music quiet for the rest of the demo.
   */
  function tickDuck(): void {
    publishMicState()
    const ducker = options.music
    if (!ducker) return
    duckReasons = syncDuck(
      ducker,
      duckReasons,
      duckReasonsFor({ coachSpeaking: audio.isSpeaking(), micArmed: lastMicState.armed }),
    )
  }

  function startDuckTick(): void {
    if (duckTimer !== null) return
    duckTimer = setInterval(tickDuck, COACH_TIMING.duckTickMs)
  }

  function stopDuckTick(): void {
    if (duckTimer === null) return
    clearInterval(duckTimer)
    duckTimer = null
    // Release both reasons on the way out. A track can outlive the socket, and with
    // the tick stopped there would be nothing left running to restore its level.
    if (options.music) duckReasons = syncDuck(options.music, duckReasons, NO_DUCK)
  }

  /** Never rejects: the uplink converts a refused mic into state, not an exception. */
  async function startMic(): Promise<void> {
    if (options.micEnabled === false) return
    await mic.start()
    publishMicState()
  }

  // ------------------------------------------------------------------ receiving

  function shouldDiscard(): boolean {
    return Date.now() < discardUntil
  }

  const callbacks: HiggsCallbacks = {
    onAudioDelta: (chunk) => {
      if (!shouldDiscard()) audio.enqueue(chunk)
    },
    onTranscriptDelta: (text) => {
      if (shouldDiscard()) return
      captionBuffer += text
      emitCaption(captionBuffer, false)
    },
    onTranscriptDone: (text) => {
      captionBuffer = ''
      if (!shouldDiscard()) emitCaption(text, true)
    },
    onAudioDone: () => debug('utterance finished'),
    // Either boundary ends the discard window. Clearing on the NEXT response too
    // means a barge-in can never swallow the opening word of the new bark, which
    // is the worse of the two failure modes.
    onResponseStart: () => {
      discardUntil = 0
    },
    onResponseDone: () => {
      discardUntil = 0
      // Emphasis is per-utterance. Leaving it hot would make every later line
      // loud, which destroys the contrast that made the severe line land.
      audio.setEmphasis(false)
    },
    onToolCall: handleToolCall,
    onError: report,
    onClose: handleClose,
    onServerEvent: (type, payload) => debug(`unhandled server event: ${type}`, payload),
  }

  /**
   * A failed attempt's socket closes AFTER we have already started the next one —
   * the fallback-voice retry opens in ~1s, the dead socket's close can land later.
   * Routing that late close into handleClose would null a live `conn`, stop its
   * heartbeat and schedule a reconnect nobody asked for, leaving two live sessions
   * racing for the one-session-per-key limit. So a close only counts if it came
   * from the attempt we are still using.
   */
  function closeCallbackFor(attempt: number): HiggsCallbacks['onClose'] {
    return (info) => {
      if (attempt !== generation) {
        debug(`ignored close ${info.code} from a superseded socket`)
        return
      }
      handleClose(info)
    }
  }

  function emitCaption(text: string, final: boolean): void {
    options.onCaption?.({ text, final, persona: personaId })
  }

  /**
   * Barge-in. `force` is for a persona swap, where the previous voice must not be
   * allowed to finish its sentence in the wrong character.
   */
  function interrupt(reason: string, force = false): void {
    const responding = conn?.isResponding() ?? false
    const backlogged = audio.queuedSec() > COACH_TIMING.bargeInBacklogSec
    if (!force && !responding && !backlogged) return
    audio.stop()
    captionBuffer = ''
    if (responding) discardUntil = Date.now() + COACH_TIMING.discardWindowMs
    debug(`barge-in: ${reason}`)
  }

  // ----------------------------------------------------------------- tool loop

  /**
   * A handler may now be async (play_music waits for the browser to accept or refuse
   * playback), so the reply can land a tick later than the call. Two things follow:
   *
   *   - `handlingToolCall` stays set until the handler SETTLES, not just until it
   *     returns. It is what stops a set_persona inside the same turn firing a second
   *     response.create that would collide with the tool reply.
   *   - a rejected promise must still produce a function_call_output. Omit the reply
   *     and the model waits on it forever; omit the response.create that
   *     sendToolOutput appends and the coach goes mute with no error event at all.
   */
  function handleToolCall(call: ToolCall): void {
    handlingToolCall = true
    const outcome = runTool(call)
    if (!(outcome instanceof Promise)) {
      handlingToolCall = false
      replyToTool(call, outcome)
      return
    }
    void outcome
      .catch((cause) => toolFailure(call, cause))
      .then((result) => {
        handlingToolCall = false
        replyToTool(call, result)
      })
  }

  function replyToTool(call: ToolCall, result: ToolResult): void {
    debug(`tool ${call.name} -> ${JSON.stringify(result)}`)
    // sendToolOutput also fires the mandatory response.create.
    conn?.sendToolOutput(call.callId, result)
  }

  function toolFailure(call: ToolCall, cause: unknown): ToolResult {
    const detail = cause instanceof Error ? cause.message : String(cause)
    report(new CoachError('tool', `${call.name} threw: ${detail}`, cause))
    return { error: `${call.name} failed: ${detail}` }
  }

  function runTool(call: ToolCall): ToolResult | Promise<ToolResult> {
    if (call.parseError) {
      return { error: `arguments were not valid JSON (${call.parseError}); try again` }
    }
    if (!registry) return { error: 'the app is still starting up; try again in a moment' }
    if (!isToolName(call.name, Object.keys(registry))) {
      return { error: `there is no tool called "${call.name}"` }
    }
    try {
      return registry[call.name](call.args)
    } catch (cause) {
      return toolFailure(call, cause)
    }
  }

  // ------------------------------------------------------------------- sending

  /**
   * Sends a speed-only patch, or nothing if the server already has this value.
   * Skipping the no-op frame is what keeps a clean-rep stream (every severity
   * `minor`, multiplier 1.0) from adding a frame per rep.
   */
  function applySpeed(target: number): void {
    if (!conn?.isOpen()) return
    const next = clampSpeed(target)
    // 0.005 is half of the smallest step these multipliers can produce, so it
    // separates real changes without chasing float noise.
    if (Math.abs(next - sentSpeed) < 0.005) return
    conn.setSpeed(next)
    sentSpeed = next
    debug(`pace -> ${next.toFixed(3)}`)
  }

  function pushEvent(event: CoachEvent): void {
    const line = toEventLine(event)
    if (!conn?.isOpen()) {
      debug(`dropped (socket not open): ${line}`)
      return
    }
    if (options.interruptOnEvent !== false) interrupt(line)
    // Both of these MUST precede conversation.item.create / response.create: a
    // session patch applies to the NEXT generated response and never retroactively
    // to one in flight, and response-scoped overrides are silently dropped.
    if (PER_EVENT_PACE_ENABLED) applySpeed(urgencyFor(event, getPersona(personaId).speed))
    // The API has no volume or gain control at all — eleven plausible field names
    // were silently dropped and `volume: 2.0` measured as an acoustic no-op — so
    // actual loudness dynamics can only be made client-side. This is the one
    // per-severity lever that puts nothing on the wire, which is why it stays on
    // while the pace patch does not. Cleared on response.done.
    audio.setEmphasis(isSevere(event))
    conn.pushEvent(line)
    lastPushAt = Date.now()
  }

  function sendUserText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!conn?.isOpen()) {
      debug(`dropped user text (socket not open): ${trimmed}`)
      return
    }
    interrupt('user spoke', true)
    conn.pushUserText(trimmed)
    lastPushAt = Date.now()
  }

  // ------------------------------------------------------------------- persona

  function voiceFor(persona: Persona): string {
    return voiceOverrides.get(persona.id) ?? persona.voice
  }

  function setPersona(next: PersonaId): void {
    if (!isPersonaId(next)) {
      report(new CoachError('protocol', `ignored unknown persona "${String(next)}"`))
      return
    }
    if (next === personaId) return
    personaId = next
    const persona = getPersona(next)
    options.onPersonaChange?.(persona)
    if (!conn?.isOpen()) return

    interrupt('persona swap', true)
    conn.updateSession({
      instructions: persona.instructions,
      voice: voiceFor(persona),
      speed: persona.speed,
    })
    // The full payload already carried the new speed, so record it rather than
    // letting the next pushEvent send a redundant patch for the same value.
    sentSpeed = clampSpeed(persona.speed)
    lastPushAt = Date.now()

    // When the model itself called set_persona it is already mid-turn: a second
    // response.create here would collide with the tool reply.
    if (handlingToolCall || options.announceOnPersonaSwap === false) return
    conn.pushEvent(`[EVENT] coach switched to ${persona.label} — greet the user in one short line`)
  }

  // ------------------------------------------------------------- connect / retry

  async function connect(): Promise<void> {
    if (conn?.isOpen()) return
    userClosed = false
    attempts = 0
    // An explicit connect supersedes any pending backoff, or we end up with two sockets.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    setStatus('connecting')
    try {
      await openOnce()
    } catch (cause) {
      const error = asCoachError(cause)
      setStatus('error')
      report(error)
      throw error
    }
  }

  // The explicit `number` is load-bearing: VOICE_RETRY is `as const`, so an
  // inferred default would narrow the parameter to the literal 3.
  async function openOnce(voiceRetriesLeft: number = VOICE_RETRY.attempts): Promise<void> {
    const persona = getPersona(personaId)
    const voice = voiceFor(persona)
    generation += 1
    const attempt = generation
    try {
      conn = await openHiggsSocket(
        { instructions: persona.instructions, voice, speed: persona.speed },
        { ...callbacks, onClose: closeCallbackFor(attempt) },
        socketOptions(),
      )
    } catch (cause) {
      pendingSocket = null
      const error = asCoachError(cause)
      // Order matters: a 429 must be caught BEFORE the fallback check, or a
      // transient rate limit spends the fallback and the persona loses its voice
      // for the rest of the session.
      if (isVoiceRateLimit(error) && voiceRetriesLeft > 0) {
        debug(`voice validation was rate limited; retrying "${voice}" unchanged`)
        await sleep(options.voiceRetryDelayMs ?? VOICE_RETRY.delayMs)
        if (userClosed) throw error
        await openOnce(voiceRetriesLeft - 1)
        return
      }
      if (shouldRetryWithFallbackVoice(error, persona, voice)) {
        voiceOverrides.set(persona.id, persona.fallbackVoice)
        debug(`voice "${voice}" was rejected; retrying as "${persona.fallbackVoice}"`)
        await openOnce(voiceRetriesLeft)
        return
      }
      throw error
    }
    // Only now is the socket the one we are actually talking on.
    liveSocket = pendingSocket
    pendingSocket = null
    attempts = 0
    discardUntil = 0
    captionBuffer = ''
    lastPushAt = Date.now()
    sentSpeed = clampSpeed(persona.speed)
    if (hasConnectedOnce) reseed()
    hasConnectedOnce = true
    startHeartbeat()
    startDuckTick()
    setStatus('live')
    // Fire-and-forget on purpose, and it cannot reject: two-way voice must not gate
    // the session going live, and a mic that never arrives leaves a working one-way
    // coach rather than a screen stuck on CONNECTING. The capture survives a
    // reconnect, so this is a no-op on every attempt after the first.
    void startMic()
  }

  /**
   * Only an actually-unknown voice earns the fallback. Measured live: any
   * non-`default` voice is validated against a rate-limited internal voices API on
   * every session.update, and roughly 1 attempt in 7 comes back as
   *   "Could not validate voice 'oliver': voices API returned HTTP 429"
   * The old /voice/i test matched that too, so ONE transient rate limit
   * permanently pinned the persona to its fallback — which is how Super Sarcastic
   * finished a demo sounding exactly like Super Mean. A 429 is not a voice
   * problem; the same-voice retry above handles it. A real miss reads
   * "Invalid voice 'x': not found".
   */
  function shouldRetryWithFallbackVoice(error: CoachError, persona: Persona, voice: string): boolean {
    if (error.kind !== 'server_error') return false
    if (voice === persona.fallbackVoice) return false
    if (isVoiceRateLimit(error)) return false
    return /not found|invalid voice|unknown voice/i.test(error.message)
  }

  function handleClose(info: { code: number; reason: string; wasClean: boolean }): void {
    conn = null
    // Dropped here rather than in the tap: sendMicFrame must never append to a socket
    // that is on its way out. The mic itself keeps capturing, so a reconnect resumes
    // the uplink without a second permission prompt.
    liveSocket = null
    stopHeartbeat()
    audio.stop()
    if (userClosed) {
      setStatus('closed')
      return
    }
    debug(`socket closed unexpectedly (${info.code})`, info)
    const kind = classifyClose(info.code)
    if (!isRetryable(kind)) {
      // Same policy as the connect path: a rejected key is a backend problem, and
      // six silent retries would only hide it.
      setStatus('error')
      report(
        new CoachError(kind, 'the ephemeral token was rejected — check POST /api/session', info),
      )
      return
    }
    scheduleReconnect(kind)
  }

  function scheduleReconnect(kind: CoachErrorKind): void {
    if (reconnectTimer) return
    if (attempts >= COACH_TIMING.reconnectMaxAttempts) {
      setStatus('error')
      report(
        new CoachError(
          'socket_closed',
          `gave up reconnecting after ${attempts} attempts — reload to start a new session`,
        ),
      )
      return
    }
    attempts += 1
    setStatus('reconnecting')
    const delay = backoffDelayMs(attempts, kind)
    debug(`reconnecting in ${Math.round(delay)}ms (attempt ${attempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void reconnectNow()
    }, delay)
  }

  async function reconnectNow(): Promise<void> {
    if (userClosed) return
    try {
      await openOnce()
    } catch (cause) {
      const error = asCoachError(cause)
      report(error)
      if (isRetryable(error.kind)) scheduleReconnect(error.kind)
      else setStatus('error')
    }
  }

  /** Silent context restore — no response.create, so the coach does not restart its patter. */
  function reseed(): void {
    const state = options.getWorkoutState?.() ?? null
    if (!state) return
    conn?.pushUserText(reseedLine(state), { respond: false })
    lastPushAt = Date.now()
    debug('reseeded workout state into the fresh session')
  }

  // ----------------------------------------------------------------- heartbeat

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!conn?.isOpen()) return
      if (Date.now() - lastPushAt < COACH_TIMING.heartbeatMs) return
      conn.pushUserText(HEARTBEAT_LINE, { respond: false })
      lastPushAt = Date.now()
      debug('pushed keepalive')
    }, COACH_TIMING.heartbeatCheckMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer === null) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  // ------------------------------------------------------------------ teardown

  function disconnect(): void {
    userClosed = true
    stopHeartbeat()
    stopDuckTick()
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    // The mic goes down with the session: an open capture with nowhere to send is a
    // live microphone the user cannot see a reason for.
    mic.stop()
    publishMicState()
    audio.stop()
    conn?.close()
    conn = null
    liveSocket = null
    pendingSocket = null
    setStatus('closed')
  }

  async function destroy(): Promise<void> {
    disconnect()
    // Leaving the workout must not leave a track playing. disconnect() has already
    // released the duck reasons, so this is the last thing music hears from us.
    options.music?.stop()
    await audio.close()
  }

  return {
    connect,
    disconnect,
    destroy,
    pushEvent,
    sendUserText,
    setPersona,
    setRegistry: (next) => {
      registry = next
    },
    getPersona: () => getPersona(personaId),
    getStatus: () => status,
    unlockAudio: () => audio.unlock(),
    getMicState: () => mic.state(),
    stopMusic: () => options.music?.stop(),
    audio,
  }
}

/** Below this the mic level has not moved enough to redraw a three-segment meter. */
export const MIC_LEVEL_STEP = 0.05

/**
 * Quantised comparison, because `level` moves on every 85 ms buffer and an un-damped
 * onMicState would re-render the HUD at 10 Hz for changes no eye can see.
 */
export function sameMicState(a: MicState, b: MicState): boolean {
  return (
    a.capturing === b.capturing &&
    a.gated === b.gated &&
    a.armed === b.armed &&
    (a.error?.code ?? null) === (b.error?.code ?? null) &&
    micLevelStep(a.level) === micLevelStep(b.level)
  )
}

export function micLevelStep(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.round(Math.min(1, level) / MIC_LEVEL_STEP)
}

/** What the fresh session is told after a reconnect, in the usual event shape. */
export function reseedLine(state: WorkoutState): string {
  const faults = state.activeFaults.length > 0 ? state.activeFaults.join(', ') : 'none'
  return [
    '[EVENT] session reconnected',
    `${state.totalReps} reps done`,
    `${state.cleanReps} clean`,
    `target ${state.target}`,
    `active faults: ${faults}`,
    'do not greet again, just keep coaching',
  ].join(' | ')
}

/**
 * The persona's base pace, scaled by how bad the reading is. Only form faults
 * carry a severity, so everything else runs at the persona's base speed — which
 * is also what makes the no-change skip in applySpeed effective.
 */
export function urgencyFor(event: CoachEvent, base: number): number {
  return event.kind === 'form_fault' ? base * URGENCY_SPEED[event.severity] : base
}

/** The one tier that earns client-side emphasis gain. */
export function isSevere(event: CoachEvent): boolean {
  return event.kind === 'form_fault' && event.severity === 'severe'
}

/**
 * Distinguishes "the voices API was busy" from "that voice does not exist". Both
 * arrive as a server_error mentioning a voice, and conflating them is what cost a
 * persona its voice for a whole session.
 */
export function isVoiceRateLimit(error: CoachError): boolean {
  return (
    error.kind === 'server_error' &&
    /voice/i.test(error.message) &&
    /\b429\b|rate.?limit|too many requests/i.test(error.message)
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

export function backoffDelayMs(attempt: number, kind: CoachErrorKind): number {
  const growth = COACH_TIMING.reconnectBaseMs * COACH_TIMING.reconnectFactor ** (attempt - 1)
  const floor = kind === 'rate_limited' ? COACH_TIMING.rateLimitedFloorMs : 0
  const base = Math.min(Math.max(growth, floor), COACH_TIMING.reconnectMaxMs)
  const jitter = 1 + (Math.random() * 2 - 1) * COACH_TIMING.reconnectJitter
  return Math.max(COACH_TIMING.reconnectBaseMs, base * jitter)
}

function asCoachError(cause: unknown): CoachError {
  if (cause instanceof CoachError) return cause
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new CoachError('connect_failed', detail, cause)
}
