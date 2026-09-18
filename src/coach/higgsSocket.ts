/**
 * Browser-direct transport to Higgs Realtime. No proxy, no SDK, no server in the
 * hot path — a browser cannot set an Authorization header on a WebSocket, so the
 * ephemeral key rides in the subprotocol instead.
 *
 * This file is pure protocol: it knows the wire shapes and nothing about personas,
 * workouts or the DOM. Policy (reconnect, heartbeat, persona swap, tool dispatch)
 * lives in session.ts.
 *
 * Shapes below were verified against the live API. Do not "tidy" them:
 *   - output_modalities must hold EXACTLY one entry; a mixed array is rejected.
 *   - response.create is mandatory after every item you want answered.
 *   - every tool call is announced twice, so dedupe on call_id.
 */

import { TOOL_DEFS } from '../types/tools'
import type { ToolName } from '../types/tools'

export const HIGGS = {
  model: 'higgs-realtime',
  url: 'wss://api.boson.ai/v1/realtime?model=higgs-realtime',
  tokenEndpoint: '/api/session',
  /** Both directions run at 24 kHz PCM16. */
  pcmRate: 24000,
  subprotocol: 'realtime',
  secretPrefix: 'bai-client-secret.',
  /**
   * 0.3, NOT 0.8. This is a measurement precondition, not a taste setting: every
   * acoustic number this file and personas.ts are tuned to was taken at 0.3. At
   * 0.8 the model overruns the 14-word cap (13-21 words observed) and at 1.2 one
   * of three free generations degenerated into mixed Cyrillic/CJK gibberish.
   * temperature is NOT a delivery lever — on pinned text 0.2 vs 1.2 sat entirely
   * inside the spread. All it changes is word choice and length, and length is
   * exactly what invalidates the orthography result.
   */
  temperature: 0.3,
  /**
   * audio.output.speed hard range. Outside it the server accepts and echoes the
   * value, then never emits an audio delta and the session wedges with no error
   * and no close (confirmed at 0.1 / 0.2 / 0 / -1 / 5 / 6 / 8 / 100; one wait ran
   * 260s). Clamp BEFORE sending; there is nothing to validate after.
   */
  speedMin: 0.25,
  speedMax: 4.0,
  /**
   * Demo ceiling. speed is a naive resample, so pitch rises 1:1: F0 measured
   * 146 -> 185 -> 222 -> 296 Hz at speed 1.0 -> 1.25 -> 1.5 -> 2.0. Above ~1.25
   * it is audibly a sped-up tape rather than an urgent coach.
   */
  speedSafeMax: 1.25,
  speedDefault: 1.0,
  /**
   * audio.output.temperature. UNDOCUMENTED, and the value that WOULD be sent if
   * `useOutputTemperature` were true. 0 does deliver what it promised — 8 of 9 runs
   * byte-identical, where at the server default the SAME text swung RMS 0.065-0.121
   * (1.9x) run to run. It is off anyway; see below.
   */
  outputTemperature: 0,
  /**
   * OFF, and this is a regression that was measured on the shipped payload, not a
   * taste call. `audio.output.temperature: 0` is greedy decoding, and greedy
   * decoding degenerates: across 18 live turns (3 personas x 6 varied [EVENT]
   * lines) 5 replies ran away, 28%, one per persona minimum —
   *   sarcastic/oliver 3/6: 72.6s, 141.9s and 71.7s of PCM for a ~2s line, i.e.
   *     speech, then ~68s of digital silence, then a short tail
   *   mean/jake 1/6 (73.8s) and nice/eleanor 1/6 (77.2s, and that one was 75.7s
   *     SPEECH-ACTIVE at RMS 0.286 — a loud 75-second babble, not silence)
   * With this field omitted the same 18 turns produced 0 runaways and turns also
   * came back inside the word cap (nice 11-14 words vs 14-23 at 0), so the field
   * was inflating length as well: audio and text share one decode.
   * A 75-second utterance is a demo-ender: audioOut's maxQueuedSec drops every
   * chunk past 20s, so the line loses its tail and the UI reads "speaking" for 20s.
   * Repeatability is not worth a 28% chance of that. Annotated `boolean` so the
   * guarded branch does not narrow to dead code.
   */
  useOutputTemperature: false as boolean,
  /**
   * `speed` and `audio.output.temperature` are UNDOCUMENTED. They work today and
   * are silently ignored by design elsewhere in this API, but an undocumented
   * field can be withdrawn and start answering 400. Flip this to false and the
   * session payload goes back to exactly what shipped before — one-character fix
   * on stage. `speed` survived the runaway probe cleanly (oliver at 1.15 with no
   * output temperature: 6/6 normal), so it is the half of the pair worth keeping.
   */
  useUndocumentedAudioParams: true,
  /** Give up if session.created never lands. */
  connectTimeoutMs: 12_000,
  /** Bound on the dedupe set so a long session cannot leak. */
  seenCallIdCap: 256,
} as const

/** Close codes with documented meaning. Everything else is a plain transport drop. */
export const CLOSE_CODE = {
  /** Bad or expired ephemeral key — mint a fresh one, do not retry the same key. */
  badToken: 3000,
  /** Max concurrency exceeded — back off and retry later. */
  maxConcurrency: 1013,
} as const

export type CoachErrorKind =
  | 'token_mint_failed'
  | 'connect_failed'
  | 'connect_timeout'
  | 'bad_token'
  | 'rate_limited'
  | 'socket_closed'
  | 'server_error'
  | 'protocol'
  | 'idle_timeout'
  | 'max_duration'
  | 'audio'
  | 'tool'

export class CoachError extends Error {
  readonly kind: CoachErrorKind
  readonly detail?: unknown
  constructor(kind: CoachErrorKind, message: string, detail?: unknown) {
    super(message)
    this.name = 'CoachError'
    this.kind = kind
    this.detail = detail
  }
}

/** True when reconnecting with a fresh token has a chance of working. */
export function isRetryable(kind: CoachErrorKind): boolean {
  return kind !== 'bad_token' && kind !== 'token_mint_failed'
}

export function classifyClose(code: number): CoachErrorKind {
  if (code === CLOSE_CODE.badToken) return 'bad_token'
  if (code === CLOSE_CODE.maxConcurrency) return 'rate_limited'
  return 'socket_closed'
}

export interface ToolCall {
  callId: string
  name: string
  /** Parsed JSON from the wire. Untrusted — handlers must validate. */
  args: unknown
  /** Set when `arguments` was not valid JSON; reply with an error, never silence. */
  parseError?: string
}

/** Everything that varies per connection or per persona swap. */
export interface SessionSetup {
  instructions: string
  voice: string
  temperature?: number
  /** Per-persona pace. Clamped by clampSpeed; omit for HIGGS.speedDefault. */
  speed?: number
}

export interface HiggsCallbacks {
  onAudioDelta: (base64Pcm16: string) => void
  onTranscriptDelta: (text: string) => void
  onTranscriptDone: (text: string) => void
  /** One spoken utterance finished playing out of the server. */
  onAudioDone: () => void
  /** A new response turn opened; everything after this belongs to it. */
  onResponseStart?: () => void
  /** A whole response turn is closed; safe point to clear interrupt state. */
  onResponseDone: () => void
  onToolCall: (call: ToolCall) => void
  onError: (error: CoachError) => void
  onClose: (info: { code: number; reason: string; wasClean: boolean }) => void
  /** Unrecognised server events, for the debug panel. Never throws. */
  onServerEvent?: (type: string, payload: Record<string, unknown>) => void
}

export interface HiggsConnection {
  /** Push one toEventLine() string as a synthetic user turn and ask for a reply. */
  pushEvent: (line: string) => void
  /** Push user text. `respond: false` seeds context silently (heartbeat, reseed). */
  pushUserText: (text: string, opts?: { respond?: boolean }) => void
  /** function_call_output + the mandatory response.create. */
  sendToolOutput: (callId: string, result: unknown) => void
  /** Persona hot-swap: re-sends the full session object with new instructions/voice. */
  updateSession: (setup: SessionSetup) => void
  /**
   * Pace for the NEXT response. MUST be sent before conversation.item.create —
   * a patch never applies retroactively to a response already in flight, and
   * response-scoped overrides are silently dropped (byte-identical output).
   */
  setSpeed: (speed: number) => void
  /** True between response.created and response.done. */
  isResponding: () => boolean
  isOpen: () => boolean
  close: () => void
}

// --------------------------------------------------------------- token minting

interface TokenFetch {
  (input: string, init?: RequestInit): Promise<Response>
}

/**
 * POST /api/session -> { value: "bai-eph-..." }. A fresh token per connection:
 * they are short-lived and reuse shows up as close code 3000 mid-demo.
 */
export async function mintEphemeralToken(
  endpoint: string = HIGGS.tokenEndpoint,
  fetchImpl?: TokenFetch,
): Promise<string> {
  const doFetch: TokenFetch = fetchImpl ?? ((input, init) => fetch(input, init))
  let res: Response
  try {
    res = await doFetch(endpoint, { method: 'POST', headers: { accept: 'application/json' } })
  } catch (cause) {
    throw new CoachError('token_mint_failed', `could not reach ${endpoint}`, cause)
  }
  if (!res.ok) {
    throw new CoachError(
      'token_mint_failed',
      `${endpoint} returned ${res.status} ${res.statusText}`,
    )
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (cause) {
    throw new CoachError('token_mint_failed', `${endpoint} returned non-JSON`, cause)
  }
  const value = readTokenValue(body)
  if (!value) {
    throw new CoachError('token_mint_failed', `${endpoint} returned no token value`, body)
  }
  return value
}

function readTokenValue(body: unknown): string | null {
  if (!isRecord(body)) return null
  if (typeof body.value === 'string' && body.value.length > 0) return body.value
  // Boson's REST shape nests it; accept either so the backend contract can move.
  const nested = body.client_secret
  if (isRecord(nested) && typeof nested.value === 'string' && nested.value.length > 0) {
    return nested.value
  }
  return null
}

// ------------------------------------------------------------------- session.update

/**
 * Guards the one value that can wedge a session beyond recovery. Out-of-range
 * `speed` passes server validation and echoes back in session.updated, then no
 * audio delta ever arrives — no error, no close, nothing to retry on. So the only
 * place this can be caught is before the frame leaves.
 */
export function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return HIGGS.speedDefault
  return Math.min(Math.max(speed, HIGGS.speedMin), HIGGS.speedSafeMax)
}

/**
 * The full session object. A persona swap changes `voice`, so this still sends the
 * whole thing. Partial merge IS now verified (deep merge, five consecutive patches,
 * including an empty `{}` — voice, audio.output.temperature and instructions all
 * survived omission), but the partial path is buildSpeedPatch, not this one.
 */
export function buildSessionPayload(setup: SessionSetup): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      model: HIGGS.model,
      instructions: setup.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: HIGGS.pcmRate },
          turn_detection: { type: 'server_vad' },
        },
        output: {
          format: { type: 'audio/pcm', rate: HIGGS.pcmRate },
          voice: setup.voice,
          ...audioOutputTuning(setup.speed),
        },
      },
      tools: TOOL_DEFS,
      tool_choice: 'auto',
      temperature: setup.temperature ?? HIGGS.temperature,
    },
  }
}

/**
 * The undocumented output fields, behind the kill switch. `temperature` is omitted
 * entirely rather than sent as the server default, because the default value is not
 * documented either — the only safe way to ask for it is to say nothing.
 */
function audioOutputTuning(speed: number | undefined): Record<string, number> {
  if (!HIGGS.useUndocumentedAudioParams) return {}
  const tuning: Record<string, number> = { speed: clampSpeed(speed) }
  if (HIGGS.useOutputTemperature) tuning.temperature = HIGGS.outputTemperature
  return tuning
}

/**
 * Speed-only patch — the per-utterance pace lever. Partial merge is verified: this
 * frame changes the pace and leaves voice, instructions and audio.output.temperature
 * untouched, and the server echoes the new speed back in session.updated.
 *
 * READ THIS BEFORE PUTTING IT IN A HOT PATH. Omitting `voice` does NOT skip the
 * server's voices lookup. Measured over two runs of 20 consecutive speed-only
 * patches in one live session — 12 acks / 8 errors at a 300 ms gap, 19 acks / 1
 * error at 2500 ms — every failure read "Could not validate voice 'jake': voices
 * API returned HTTP 429" for a frame that carries no voice at all. The session
 * survives (the rejected patch is a no-op), but the caller gets a CoachError per
 * failure. session.ts ships this disabled behind PER_EVENT_PACE_ENABLED.
 *
 * `format` is not required in a partial patch (verified); if a patch ever fails
 * for some other reason, add it back first.
 */
export function buildSpeedPatch(speed: number): Record<string, unknown> {
  return { type: 'session.update', session: { audio: { output: { speed: clampSpeed(speed) } } } }
}

// ------------------------------------------------------------------------ connect

export interface OpenOptions {
  url?: string
  tokenEndpoint?: string
  /** Injected in tests; defaults to the platform WebSocket. */
  createSocket?: (url: string, protocols: string[]) => WebSocket
  fetchImpl?: TokenFetch
}

/**
 * Mints a token, opens the socket, sends session.update, and resolves once the
 * server acknowledges with session.created / session.updated. Rejects with a
 * CoachError if anything fails before that acknowledgement.
 */
export async function openHiggsSocket(
  setup: SessionSetup,
  callbacks: HiggsCallbacks,
  options: OpenOptions = {},
): Promise<HiggsConnection> {
  const token = await mintEphemeralToken(options.tokenEndpoint ?? HIGGS.tokenEndpoint, options.fetchImpl)
  const url = options.url ?? HIGGS.url
  const protocols = [HIGGS.subprotocol, HIGGS.secretPrefix + token]
  const ws = options.createSocket
    ? options.createSocket(url, protocols)
    : new WebSocket(url, protocols)

  return await new Promise<HiggsConnection>((resolve, reject) => {
    const state = createState(ws, callbacks)
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      state.detach()
      try {
        ws.close()
      } catch {
        /* already gone */
      }
      reject(new CoachError('connect_timeout', `no session.created within ${HIGGS.connectTimeoutMs}ms`))
    }, HIGGS.connectTimeoutMs)

    state.onReady = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(state.connection)
    }
    state.onFatal = (error) => {
      if (settled) {
        callbacks.onError(error)
        return
      }
      settled = true
      clearTimeout(timer)
      // Nobody outside this promise has a reference to the socket yet, so an
      // abandoned half-open session would just sit there counting against the
      // concurrency limit (close 1013) while the caller retries. Close through
      // the connection so the close is marked as ours and does not re-report as
      // a second failure — onClose still fires, so reconnect policy is intact.
      state.connection.close()
      reject(error)
    }

    ws.onopen = () => state.send(buildSessionPayload(setup))
    state.attach()
  })
}

// --------------------------------------------------------------- event plumbing

interface SocketState {
  connection: HiggsConnection
  send: (payload: Record<string, unknown>) => boolean
  attach: () => void
  detach: () => void
  onReady: () => void
  onFatal: (error: CoachError) => void
}

function createState(ws: WebSocket, cb: HiggsCallbacks): SocketState {
  const seenCallIds = new Set<string>()
  let transcript = ''
  let responding = false
  let closedByUs = false
  /** True once the server has acknowledged session.update. See the error case below. */
  let acked = false

  const state: SocketState = {
    connection: {
      pushEvent: (line) => {
        send(userItem(line))
        send({ type: 'response.create' })
      },
      pushUserText: (text, opts) => {
        send(userItem(text))
        if (opts?.respond !== false) send({ type: 'response.create' })
      },
      sendToolOutput: (callId, result) => {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            // MUST be a JSON string. An object here is silently ignored.
            output: JSON.stringify(result),
          },
        })
        // Omit this and the coach goes mute with no error event.
        send({ type: 'response.create' })
      },
      updateSession: (setup) => send(buildSessionPayload(setup)),
      setSpeed: (speed) => send(buildSpeedPatch(speed)),
      isResponding: () => responding,
      isOpen: () => ws.readyState === WebSocket.OPEN,
      close: () => {
        closedByUs = true
        try {
          ws.close(1000, 'client done')
        } catch {
          /* already gone */
        }
      },
    },
    send,
    attach: () => {
      ws.onmessage = onMessage
      ws.onerror = () =>
        state.onFatal(new CoachError('connect_failed', 'websocket error before or during the session'))
      ws.onclose = (event) => {
        const info = { code: event.code, reason: event.reason, wasClean: event.wasClean }
        responding = false
        if (!closedByUs) {
          state.onFatal(new CoachError(classifyClose(event.code), closeMessage(info), info))
        }
        cb.onClose(info)
      }
    },
    detach: () => {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
    },
    onReady: () => {},
    onFatal: (error) => cb.onError(error),
  }

  function send(payload: Record<string, unknown>): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      cb.onError(
        new CoachError('socket_closed', `dropped ${String(payload.type)}: socket is not open`, payload),
      )
      return false
    }
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch (cause) {
      cb.onError(new CoachError('socket_closed', `could not send ${String(payload.type)}`, cause))
      return false
    }
  }

  function onMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      cb.onError(new CoachError('protocol', 'ignored a non-text frame from the server'))
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch (cause) {
      cb.onError(new CoachError('protocol', 'server sent malformed JSON', cause))
      return
    }
    if (!isRecord(payload) || typeof payload.type !== 'string') {
      cb.onError(new CoachError('protocol', 'server event had no type', payload))
      return
    }
    dispatch(payload.type, payload)
  }

  function dispatch(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case 'session.created':
      case 'session.updated':
        acked = true
        state.onReady()
        return

      case 'response.created':
        responding = true
        cb.onResponseStart?.()
        return

      case 'response.output_audio.delta': {
        const delta = readString(payload, 'delta')
        if (delta) cb.onAudioDelta(delta)
        return
      }

      case 'response.output_audio_transcript.delta': {
        const delta = readString(payload, 'delta')
        if (delta) {
          transcript += delta
          cb.onTranscriptDelta(delta)
        }
        return
      }

      case 'response.output_audio_transcript.done': {
        // Prefer the server's full text; fall back to what we accumulated.
        const full = readString(payload, 'transcript') ?? readString(payload, 'text') ?? transcript
        transcript = ''
        if (full) cb.onTranscriptDone(full)
        return
      }

      case 'response.output_audio.done':
        cb.onAudioDone()
        return

      case 'response.function_call_arguments.done':
        emitToolCall(payload)
        return

      case 'response.done':
        responding = false
        // The same call is announced here too — dedupe keeps it single-fire.
        for (const item of readOutputItems(payload)) emitToolCall(item)
        cb.onResponseDone()
        return

      case 'error': {
        const error = new CoachError('server_error', readErrorMessage(payload), payload)
        // Before the ack, an error frame IS the outcome of the connect: the server
        // rejects session.update and terminates, so no session.created ever lands.
        // Measured live: voice validation intermittently answers HTTP 429 and the
        // server replies "Could not validate voice 'oliver'". Treating that as
        // non-fatal cost the caller the full connectTimeoutMs of dead air and threw
        // away the server's own wording, which is what shouldRetryWithFallbackVoice
        // matches on — so the fallback voice was never tried.
        if (!acked) state.onFatal(error)
        else cb.onError(error)
        return
      }

      case 'session.idle_timeout':
        cb.onError(
          new CoachError('idle_timeout', 'session closed: no user speech for five minutes', payload),
        )
        return

      case 'session.max_duration_reached': {
        const max = payload.max_duration_sec
        cb.onError(
          new CoachError(
            'max_duration',
            `session hit its max duration (max_duration_sec=${String(max)})`,
            payload,
          ),
        )
        return
      }

      default:
        cb.onServerEvent?.(type, payload)
    }
  }

  function emitToolCall(source: Record<string, unknown>): void {
    // call_id only — an item id is NOT interchangeable, and replying with the wrong
    // one leaves the model waiting forever while looking like a successful reply.
    const callId = readString(source, 'call_id')
    const name = readString(source, 'name')
    if (!callId || !name) return
    if (seenCallIds.has(callId)) return
    rememberCallId(seenCallIds, callId)

    const raw = readString(source, 'arguments') ?? '{}'
    try {
      cb.onToolCall({ callId, name, args: JSON.parse(raw) })
    } catch (cause) {
      cb.onToolCall({
        callId,
        name,
        args: {},
        parseError: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return state
}

function userItem(text: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }
}

function rememberCallId(seen: Set<string>, callId: string): void {
  seen.add(callId)
  if (seen.size <= HIGGS.seenCallIdCap) return
  // Sets iterate in insertion order, so this drops the oldest ids first.
  const excess = seen.size - HIGGS.seenCallIdCap
  let dropped = 0
  for (const id of seen) {
    if (dropped >= excess) break
    seen.delete(id)
    dropped += 1
  }
}

function readOutputItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const response = isRecord(payload.response) ? payload.response : payload
  const output = response.output
  if (!Array.isArray(output)) return []
  return output.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === 'function_call',
  )
}

function readErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : null
    const code = typeof error.code === 'string' ? error.code : null
    if (message && code) return `${code}: ${message}`
    if (message) return message
    if (code) return code
  }
  if (typeof payload.message === 'string') return payload.message
  return 'server reported an error with no message'
}

function closeMessage(info: { code: number; reason: string }): string {
  if (info.code === CLOSE_CODE.badToken) {
    return 'ephemeral token was rejected (3000) — mint a fresh one'
  }
  if (info.code === CLOSE_CODE.maxConcurrency) {
    return 'too many concurrent realtime sessions (1013) — retry shortly'
  }
  return `socket closed (${info.code})${info.reason ? `: ${info.reason}` : ''}`
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a wire tool name onto the contract's union. */
export function isToolName(name: string, registryKeys: readonly string[]): name is ToolName {
  return registryKeys.includes(name)
}
