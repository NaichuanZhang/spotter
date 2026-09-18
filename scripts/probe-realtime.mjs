#!/usr/bin/env node
/**
 * Standalone latency + tool-call harness for Higgs Realtime.
 *
 * This is how we catch a latency regression. It exercises the exact inversion
 * the app depends on — the POSE ENGINE INITIATES, the model REACTS — by pushing
 * synthetic CoachEvent lines as user turns and timing how long until audio comes
 * back. Measured baseline: 596-619 ms from response.create to first audio delta.
 *
 *   BOSON_API_KEY=... node scripts/probe-realtime.mjs
 *   node scripts/probe-realtime.mjs --pushes=8 --verbose
 *   node scripts/probe-realtime.mjs --no-tool-assert
 *
 * Exit 0 only if the latency budget held AND a tool call round-tripped.
 *
 * Imports the frozen contract (src/types/*.ts) directly — Node >= 22.18 strips
 * the types — so the probe measures the real event format, not a copy of it.
 */

import { toEventLine } from '../src/types/events.ts'
import { TOOL_DEFS } from '../src/types/tools.ts'

// ---------------------------------------------------------------- tunables

const API = {
  clientSecretsUrl: 'https://api.boson.ai/v1/realtime/client_secrets',
  realtimeUrl: 'wss://api.boson.ai/v1/realtime',
  model: 'higgs-realtime',
  tokenTtlSeconds: 600,
  keyEnvNames: ['BOSON_API_KEY', 'BOSONAI_API_KEY'],
}

/** Regression gate. Baseline is ~600 ms; these leave headroom for venue wifi. */
const LATENCY_BUDGET = {
  p50Ms: 900,
  p95Ms: 1_400,
}

const TIMING = {
  /** A push is considered settled after this long with no inbound frames. */
  quietMs: 1_500,
  /** Hard ceiling per push, including any tool round trip. */
  pushTimeoutMs: 25_000,
  openTimeoutMs: 15_000,
  sessionAckMs: 2_000,
  httpTimeoutMs: 15_000,
  /** Small gap between turns so we are not measuring our own pipelining. */
  betweenPushesMs: 400,
}

const PROBE_INSTRUCTIONS =
  'You are SPOTTER, a blunt pushup coach. You receive [EVENT] lines from a pose engine; they are ' +
  'telemetry, not speech. React in character in ONE short sentence. When an [EVENT] reports a form ' +
  'fault, call show_reference for that fault before you speak.'

/** Event names differ between realtime API generations; accept either spelling. */
const AUDIO_DELTA_EVENTS = new Set(['response.output_audio.delta', 'response.audio.delta'])
const TRANSCRIPT_DELTA_EVENTS = new Set([
  'response.output_audio_transcript.delta',
  'response.audio_transcript.delta',
])

/**
 * Measured directly: the WS handshake ALWAYS succeeds — even with a garbage
 * ephemeral key, `ws.protocol` comes back "realtime". The rejection arrives
 * afterwards as close 3000 with no `error` frame at all. So "socket opened"
 * proves nothing about auth; only a close code or a first response does.
 */
const WS_CLOSE_HINTS = {
  3000: 'close 3000 = "Invalid ephemeral key". The token was rejected AFTER the handshake — mint a fresh one.',
  1013: 'close 1013 = undocumented concurrency limit. Close other tabs/probes and retry.',
  1008: 'close 1008 = policy violation, usually a bad or expired ephemeral token.',
  1011: 'close 1011 = server error.',
}

// ---------------------------------------------------------------- fixtures

/** Synthetic reps/faults rendered through the REAL toEventLine(). */
function buildEventLines(count) {
  const now = Date.now()
  const rep = (index, overrides = {}) => ({
    index,
    minElbowAngle: 78,
    maxElbowAngle: 168,
    depthPct: 88,
    hipDeviationDeg: 4,
    descentMs: 1_100,
    ascentMs: 800,
    partial: false,
    clean: true,
    ...overrides,
  })

  const script = [
    { kind: 'set_started', at: now, target: 20 },
    { kind: 'rep_completed', at: now, rep: rep(1), totalReps: 1, cleanReps: 1 },
    // Severe fault: this is the push that should provoke show_reference.
    { kind: 'form_fault', at: now, fault: 'sagging_hips', severity: 'severe', valueDeg: 26, heldFrames: 9 },
    {
      kind: 'rep_completed',
      at: now,
      rep: rep(2, { depthPct: 61, hipDeviationDeg: 26, clean: false }),
      totalReps: 2,
      cleanReps: 1,
    },
    { kind: 'form_fault', at: now, fault: 'partial_depth', severity: 'major', valueDeg: 112, heldFrames: 6 },
    { kind: 'rep_completed', at: now, rep: rep(3, { partial: true, depthPct: 54, clean: false }), totalReps: 3, cleanReps: 1 },
    { kind: 'idle', at: now, sinceMs: 7_400 },
    { kind: 'set_ended', at: now, totalReps: 3, cleanReps: 1, faults: ['sagging_hips', 'partial_depth'] },
  ]

  // Cycle if the caller asked for more pushes than the script has.
  return Array.from({ length: count }, (_, i) => toEventLine(script[i % script.length]))
}

/** Local stand-ins for the browser tool handlers. Never throw; return {error}. */
const PROBE_TOOL_RESULTS = {
  show_reference: (args) => ({
    shown: true,
    clip: `/clips/${args?.fault ?? 'good_rep'}-side.mp4`,
    description: 'Reference clip is now on screen.',
  }),
  set_persona: (args) => ({ persona: args?.persona ?? 'mean', ok: true }),
  get_workout_state: () => ({
    reps: 3,
    target: 20,
    cleanReps: 1,
    lastRepDepthPct: 54,
    activeFaults: ['sagging_hips'],
    setElapsedSec: 41,
    phase: 'top',
  }),
  get_heart_rate: () => ({ bpm: 138, zone: 'aerobic', trend: 'rising', simulated: true }),
  log_set: (args) => ({ logged: true, summary: `${args?.reps ?? 0} reps logged` }),
}

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const hit = argv.find((arg) => arg.startsWith(`${flag}=`))
    return hit ? hit.slice(flag.length + 1) : fallback
  }
  const pushes = Number.parseInt(value('--pushes', '5'), 10)
  if (!Number.isFinite(pushes) || pushes < 1) throw new Error('--pushes must be a positive integer')
  return {
    pushes,
    model: value('--model', API.model),
    verbose: argv.includes('--verbose'),
    assertTool: !argv.includes('--no-tool-assert'),
  }
}

function readApiKey() {
  for (const name of API.keyEnvNames) {
    const v = process.env[name]
    if (v && v.trim()) return v.trim()
  }
  throw new Error(
    `No API key. Set ${API.keyEnvNames[0]} (see .env.example). A 429 insufficient_quota means the ` +
      'trial credit was never CLAIMED — use the banner on the Boson API Keys page.',
  )
}

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

async function mintToken(apiKey) {
  const response = await fetch(API.clientSecretsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // Only expires_after is accepted (additionalProperties: false).
    body: JSON.stringify({ expires_after: { seconds: API.tokenTtlSeconds } }),
    signal: AbortSignal.timeout(TIMING.httpTimeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`client_secrets -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
  const body = JSON.parse(raw)
  const value = body?.value ?? body?.client_secret?.value
  if (!value) throw new Error(`client_secrets returned no value (keys: ${Object.keys(body).join(', ')})`)
  return value
}

function openSocket(url, ephemeralToken) {
  // Node's WebSocket cannot set headers either, which is exactly why the
  // ephemeral token rides in the subprotocol — same path the browser uses.
  const ws = new WebSocket(url, ['realtime', `bai-client-secret.${ephemeralToken}`])
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      ws.close()
      rejectPromise(new Error(`websocket did not open within ${TIMING.openTimeoutMs}ms`))
    }, TIMING.openTimeoutMs)

    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolvePromise(ws)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      rejectPromise(new Error('websocket error before open (bad token, or wrong subprotocol)'))
    })
  })
}

// ---------------------------------------------------------------- the probe

/**
 * Tracks one WebSocket: routes inbound frames, answers tool calls, and records
 * the time from response.create to the first audio delta.
 */
function createProbeState(ws, options) {
  const state = {
    latencies: [],
    toolCalls: [],
    audioBytes: 0,
    errors: [],
    lastFrameAt: 0,
    firstAudioAt: null,
    pushSentAt: null,
    transcript: '',
    seenCallIds: new Set(),
    sessionAcked: false,
    /** Set by the close listener; every wait loop bails the moment it appears. */
    closeInfo: null,
  }

  ws.addEventListener('close', (event) => {
    state.closeInfo = { code: event.code, reason: event.reason }
    if (event.code !== 1000) {
      log(`    ! socket closed: ${event.code} ${event.reason || '(no reason)'}`)
      const hint = WS_CLOSE_HINTS[event.code]
      if (hint) log(`      ${hint}`)
    }
  })

  const send = (payload) => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }

  const answerToolCall = (callId, name, rawArgs) => {
    if (state.seenCallIds.has(callId)) return // announced twice; dedupe on call_id
    state.seenCallIds.add(callId)

    let args = {}
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {}
    } catch (err) {
      state.errors.push(`tool ${name} args were not JSON: ${err.message}`)
    }
    const handler = PROBE_TOOL_RESULTS[name]
    const result = handler ? handler(args) : { error: `unknown tool ${name}` }
    state.toolCalls.push({ name, args, callId })
    log(`    ↩ tool ${name}(${JSON.stringify(args)}) -> ${JSON.stringify(result)}`)

    // output MUST be a JSON string, and response.create afterwards is MANDATORY
    // or the model goes silently mute with no error event.
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    })
    send({ type: 'response.create' })
  }

  const onFrame = (event) => {
    state.lastFrameAt = Date.now()
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      state.errors.push('inbound frame was not JSON')
      return
    }
    if (options.verbose) log(`    · ${msg.type}`)

    if (msg.type === 'session.updated' || msg.type === 'session.created') state.sessionAcked = true

    if (msg.type === 'error') {
      const detail = msg.error?.message ?? JSON.stringify(msg.error ?? msg)
      state.errors.push(detail)
      log(`    ! server error: ${detail}`)
      return
    }

    if (AUDIO_DELTA_EVENTS.has(msg.type)) {
      if (state.firstAudioAt === null && state.pushSentAt !== null) {
        state.firstAudioAt = Date.now()
      }
      state.audioBytes += typeof msg.delta === 'string' ? msg.delta.length : 0
      return
    }

    if (TRANSCRIPT_DELTA_EVENTS.has(msg.type) && typeof msg.delta === 'string') {
      state.transcript += msg.delta
      return
    }

    if (msg.type === 'response.function_call_arguments.done') {
      answerToolCall(msg.call_id, msg.name, msg.arguments)
      return
    }

    // The same call is also announced inside response.done.output — dedupe handles it.
    if (msg.type === 'response.done') {
      for (const item of msg.response?.output ?? []) {
        if (item?.type === 'function_call') answerToolCall(item.call_id, item.name, item.arguments)
      }
    }
  }

  ws.addEventListener('message', onFrame)
  return { state, send }
}

async function configureSession({ send, state }, options) {
  send({
    type: 'session.update',
    session: {
      instructions: PROBE_INSTRUCTIONS,
      tools: TOOL_DEFS,
      tool_choice: 'auto',
      // turn_detection off: there is no mic here, every turn is pushed by us.
      turn_detection: null,
    },
  })
  const deadline = Date.now() + TIMING.sessionAckMs
  while (Date.now() < deadline && !state.sessionAcked && !state.closeInfo) await sleep(50)
  if (!state.sessionAcked && options.verbose) {
    log('    (no session.updated ack — continuing; tools may still be registered)')
  }
}

/** Push one event line, then wait for first audio + a quiet period. */
async function pushEvent({ send, state }, line, index) {
  log(`  [${index}] ${line}`)
  state.firstAudioAt = null
  state.transcript = ''

  send({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] },
  })
  state.pushSentAt = Date.now()
  state.lastFrameAt = state.pushSentAt
  send({ type: 'response.create' })

  const deadline = state.pushSentAt + TIMING.pushTimeoutMs
  while (Date.now() < deadline) {
    await sleep(25)
    if (state.closeInfo) break
    const settled = state.firstAudioAt !== null && Date.now() - state.lastFrameAt > TIMING.quietMs
    if (settled) break
  }

  if (state.firstAudioAt === null) {
    log(state.closeInfo ? '    ✗ socket closed before any audio' : '    ✗ no audio within budget')
    return null
  }
  const ms = state.firstAudioAt - state.pushSentAt
  state.latencies.push(ms)
  if (state.transcript.trim()) log(`    "${state.transcript.trim()}"`)
  log(`    ✓ first audio in ${ms} ms`)
  return ms
}

function report(state, options) {
  const sorted = [...state.latencies].sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)

  log('')
  log('---- results ----')
  log(`  pushes           ${options.pushes}`)
  log(`  audio responses  ${sorted.length}`)
  log(`  samples (ms)     ${sorted.join(', ') || '(none)'}`)
  log(`  p50              ${Number.isNaN(p50) ? 'n/a' : `${p50} ms`}   (budget ${LATENCY_BUDGET.p50Ms} ms)`)
  log(`  p95              ${Number.isNaN(p95) ? 'n/a' : `${p95} ms`}   (budget ${LATENCY_BUDGET.p95Ms} ms)`)
  log(`  audio payload    ${(state.audioBytes / 1024).toFixed(1)} KB (base64)`)
  log(`  tool calls       ${state.toolCalls.length ? state.toolCalls.map((t) => t.name).join(', ') : '(none)'}`)
  if (state.errors.length) log(`  server errors    ${state.errors.length}: ${state.errors.slice(0, 3).join(' | ')}`)

  const failures = []
  if (state.closeInfo && state.closeInfo.code !== 1000) {
    failures.push(
      `socket closed early: ${state.closeInfo.code} ${state.closeInfo.reason || '(no reason)'}` +
        `${WS_CLOSE_HINTS[state.closeInfo.code] ? ` — ${WS_CLOSE_HINTS[state.closeInfo.code]}` : ''}`,
    )
  }
  if (sorted.length === 0) failures.push('no audio came back at all')
  if (sorted.length > 0 && p50 > LATENCY_BUDGET.p50Ms) failures.push(`p50 ${p50}ms over ${LATENCY_BUDGET.p50Ms}ms`)
  if (sorted.length > 0 && p95 > LATENCY_BUDGET.p95Ms) failures.push(`p95 ${p95}ms over ${LATENCY_BUDGET.p95Ms}ms`)
  if (options.assertTool && state.toolCalls.length === 0) {
    failures.push('no tool call round-tripped (show_reference never fired from a pushed event)')
  }

  log('')
  if (failures.length === 0) {
    log('PASS — latency within budget and the tool loop works.')
    return 0
  }
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`)
  return 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const apiKey = readApiKey()

  log(`probing ${API.realtimeUrl}?model=${options.model} with ${options.pushes} synthetic pushes`)
  const token = await mintToken(apiKey)
  log(`✓ minted ephemeral token (${token.slice(0, 12)}…)`)

  const ws = await openSocket(`${API.realtimeUrl}?model=${encodeURIComponent(options.model)}`, token)
  // NB: this line is NOT evidence the token is good — see WS_CLOSE_HINTS[3000].
  log(`✓ websocket open, negotiated subprotocol "${ws.protocol}"`)

  const probe = createProbeState(ws, options)
  await configureSession(probe, options)

  for (const [index, line] of buildEventLines(options.pushes).entries()) {
    if (probe.state.closeInfo) break
    await pushEvent(probe, line, index + 1)
    await sleep(TIMING.betweenPushesMs)
  }

  if (ws.readyState === WebSocket.OPEN) ws.close()
  process.exit(report(probe.state, options))
}

main().catch((err) => {
  process.stderr.write(`\nPROBE FAILED: ${err?.message ?? err}\n`)
  process.exit(1)
})
