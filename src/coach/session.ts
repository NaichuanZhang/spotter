/**
 * The coach session: policy on top of the raw protocol in higgsSocket.ts.
 *
 * Owns four things that are each a demo-killer if missed:
 *   1. Persona hot-swap — session.update with new instructions + voice, no reconnect.
 *   2. A 4-minute heartbeat — the session closes after 5 minutes without user
 *      *speech*, and a set of pushups is grunting, not talking.
 *   3. Reconnect with backoff that reseeds workout state into the fresh session.
 *   4. The tool loop, including the mandatory response.create after every reply.
 *
 * Also owns barge-in. Pose events are time-critical: a bark about rep 3 arriving
 * during rep 7 is worse than a clipped sentence, so a new event cuts audio that is
 * still streaming or badly backlogged — but lets a finished short line play out.
 */

import { toEventLine } from '../types/events'
import type { CoachEvent, WorkoutState } from '../types/events'
import type { PersonaId, ToolRegistry, ToolResult } from '../types/tools'
import { createAudioOut } from './audioOut'
import type { AudioOut } from './audioOut'
import { classifyClose, CoachError, isRetryable, isToolName, openHiggsSocket } from './higgsSocket'
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
} as const

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
}

export interface CoachSession {
  /** Mints a token and opens the socket. Rejects on failure; no silent retry here. */
  connect: () => Promise<void>
  disconnect: () => void
  destroy: () => Promise<void>
  pushEvent: (event: CoachEvent) => void
  /** Typed user turn (the mic uplink is not wired — see the report). */
  sendUserText: (text: string) => void
  setPersona: (persona: PersonaId) => void
  setRegistry: (registry: ToolRegistry) => void
  getPersona: () => Persona
  getStatus: () => CoachStatus
  /** Must be called from a user gesture before the coach can be heard. */
  unlockAudio: () => Promise<void>
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
  let captionBuffer = ''
  let discardUntil = 0
  let handlingToolCall = false
  let heartbeatTimer: Timer | null = null
  let reconnectTimer: Timer | null = null

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
    },
    onToolCall: handleToolCall,
    onError: report,
    onClose: handleClose,
    onServerEvent: (type, payload) => debug(`unhandled server event: ${type}`, payload),
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

  function handleToolCall(call: ToolCall): void {
    handlingToolCall = true
    let result: ToolResult
    try {
      result = runTool(call)
    } finally {
      handlingToolCall = false
    }
    debug(`tool ${call.name} -> ${JSON.stringify(result)}`)
    // sendToolOutput also fires the mandatory response.create.
    conn?.sendToolOutput(call.callId, result)
  }

  function runTool(call: ToolCall): ToolResult {
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
      const detail = cause instanceof Error ? cause.message : String(cause)
      report(new CoachError('tool', `${call.name} threw: ${detail}`, cause))
      return { error: `${call.name} failed: ${detail}` }
    }
  }

  // ------------------------------------------------------------------- sending

  function pushEvent(event: CoachEvent): void {
    const line = toEventLine(event)
    if (!conn?.isOpen()) {
      debug(`dropped (socket not open): ${line}`)
      return
    }
    if (options.interruptOnEvent !== false) interrupt(line)
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
    conn.updateSession({ instructions: persona.instructions, voice: voiceFor(persona) })
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

  async function openOnce(): Promise<void> {
    const persona = getPersona(personaId)
    const voice = voiceFor(persona)
    try {
      conn = await openHiggsSocket(
        { instructions: persona.instructions, voice },
        callbacks,
        options.socket,
      )
    } catch (cause) {
      const error = asCoachError(cause)
      if (shouldRetryWithFallbackVoice(error, persona, voice)) {
        voiceOverrides.set(persona.id, persona.fallbackVoice)
        debug(`voice "${voice}" was rejected; retrying as "${persona.fallbackVoice}"`)
        await openOnce()
        return
      }
      throw error
    }
    attempts = 0
    discardUntil = 0
    captionBuffer = ''
    lastPushAt = Date.now()
    if (hasConnectedOnce) reseed()
    hasConnectedOnce = true
    startHeartbeat()
    setStatus('live')
  }

  function shouldRetryWithFallbackVoice(error: CoachError, persona: Persona, voice: string): boolean {
    return (
      error.kind === 'server_error' && /voice/i.test(error.message) && voice !== persona.fallbackVoice
    )
  }

  function handleClose(info: { code: number; reason: string; wasClean: boolean }): void {
    conn = null
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
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    audio.stop()
    conn?.close()
    conn = null
    setStatus('closed')
  }

  async function destroy(): Promise<void> {
    disconnect()
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
    audio,
  }
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
