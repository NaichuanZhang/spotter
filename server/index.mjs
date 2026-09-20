#!/usr/bin/env node
/**
 * SPOTTER backend. Deliberately tiny: zero dependencies, node: builtins only.
 *
 * Three jobs and nothing else:
 *   1. POST /api/session  — mint a short-lived Boson ephemeral client secret.
 *                           The real BOSON_API_KEY never leaves this process.
 *   2. POST /api/verdict  — render the closing-screen avatar verdict from the
 *                           user's STATS. Proxied for one reason: the ephemeral
 *                           realtime token does NOT grant /v1/videos, so the
 *                           only credential that can render is the one the
 *                           browser must never see.
 *   3. GET  /healthz      — liveness for Instacloud.
 * Plus static hosting of the built SPA in ./dist (the browser does everything
 * else: no audio proxy, no pose endpoint, no database).
 *
 * Instacloud gives us exactly ONE http port and no raw TCP, which is why the
 * realtime WebSocket goes browser -> Boson directly and never through here.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAvatarPersona } from './avatarPersonas.mjs'
import { buildVerdictText, validateVerdictStats, verdictCacheKey } from './verdictText.mjs'
import {
  VerdictBusyError,
  readVerdictCache,
  verdictCacheStats,
  withVerdictSingleFlight,
  writeVerdictCache,
} from './verdictCache.mjs'
import { VerdictRenderError, renderVerdictVideo } from './verdictRender.mjs'

// ---------------------------------------------------------------- tunables
// Everything environment- or API-shaped lives here so redeploy tweaks are a
// one-block edit.

const SERVER = {
  host: '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '', 10) || 8080,
  /** Built SPA. Resolved relative to this file so it works in the container too. */
  distDir: process.env.DIST_DIR
    ? resolve(process.env.DIST_DIR)
    : resolve(fileURLToPath(new URL('../dist', import.meta.url))),
}

const BOSON = {
  clientSecretsUrl: 'https://api.boson.ai/v1/realtime/client_secrets',
  /** Ephemeral token lifetime. API accepts 10..7200; a set plus intro fits in 10 min. */
  tokenTtlSeconds: 600,
  upstreamTimeoutMs: 10_000,
  /**
   * BOSON_API_KEY is the documented name. BOSONAI_API_KEY is accepted because
   * that is what the Boson dashboard exports into a shell, and a key that is
   * present-but-under-the-other-name is the dumbest possible way to lose an hour.
   */
  keyEnvNames: ['BOSON_API_KEY', 'BOSONAI_API_KEY'],
}

const LIMITS = {
  /** We ignore the client body entirely; this only stops a silly upload. */
  requestBodyBytes: 4096,
  /** Upstream error text is forwarded (it says things like insufficient_quota). */
  upstreamErrorChars: 400,
}

/**
 * POST /api/verdict. The mp4 is the response BODY, so everything the UI needs
 * to be honest about what it is playing travels in headers — and a header value
 * is latin1, hence headerSafe() below and the ASCII assertion in verdictText.
 */
const VERDICT = {
  /** Nine scalar stats. 4 KB is already absurd for that. */
  bodyBytes: 4096,
  headerTextChars: 400,
  headerNotesChars: 600,
  /**
   * Without this, a cross-origin fetch() can read NONE of the X-Verdict-*
   * headers and the UI has an mp4 it cannot label. Production is same-origin
   * and dev proxies /api, so this is belt-and-braces — but the failure it
   * prevents looks like "the server is not sending the job id".
   */
  exposedHeaders: [
    'X-Verdict-Cache',
    'X-Verdict-Job-Id',
    'X-Verdict-Voice',
    'X-Verdict-Persona',
    'X-Verdict-Text',
    'X-Verdict-Notes',
    'X-Verdict-Elapsed-Ms',
    'X-Verdict-Render-Ms',
    'X-Verdict-Polls',
  ].join(', '),
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // The two that break MediaPipe when guessed wrong:
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
}

const DEFAULT_MIME = 'application/octet-stream'

/** Content-addressed or hand-vendored assets: safe to cache hard. */
const IMMUTABLE_PREFIXES = ['/assets/', '/vendor/', '/avatars/', '/clips/']

const CORS_HEADERS = {
  // Dev serves the SPA from :5173 while this process holds the key on :8080, and
  // Instacloud's CORS behaviour is undocumented, so be explicit rather than lucky.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

// ---------------------------------------------------------------- helpers

function log(...parts) {
  process.stdout.write(`[spotter] ${new Date().toISOString()} ${parts.join(' ')}\n`)
}

function logError(...parts) {
  process.stderr.write(`[spotter] ${new Date().toISOString()} ERROR ${parts.join(' ')}\n`)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  })
  res.end(body)
  return body.byteLength
}

function cacheControlFor(urlPath) {
  if (IMMUTABLE_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-cache'
}

function readApiKey() {
  for (const name of BOSON.keyEnvNames) {
    const value = process.env[name]
    if (value && value.trim()) return { key: value.trim(), source: name }
  }
  return null
}

async function drainBody(req, limitBytes) {
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    // Stop reading but do NOT destroy the request: we still want the 413 JSON to
    // reach the client rather than showing up as a bare connection reset.
    if (total > limitBytes) throw new Error(`request body exceeded ${limitBytes} bytes`)
  }
}

/**
 * Read a JSON body. Distinguishes too-large from unparseable so the client is
 * told which of the two it did, rather than a generic 400.
 */
async function readJsonBody(req, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) {
      const err = new Error(`request body exceeded ${limitBytes} bytes`)
      err.tooLarge = true
      throw err
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch (parseErr) {
    const err = new Error(
      raw.trim() === ''
        ? 'empty body: POST the workout stats as JSON'
        : `body is not valid JSON: ${parseErr.message}`,
    )
    err.badJson = true
    throw err
  }
}

/**
 * Header values are latin1 and a stray byte is silent mojibake in the browser,
 * so anything outside printable ASCII is replaced rather than sent. Truncation
 * is marked, because a quietly clipped verdict line reads as a template bug.
 */
function headerSafe(value, maxChars) {
  const ascii = String(value ?? '').replace(/[^\x20-\x7E]/g, '?')
  return ascii.length <= maxChars ? ascii : `${ascii.slice(0, maxChars - 3)}...`
}

/**
 * Boson has returned the secret at the top level in testing, but OpenAI-shaped
 * APIs also nest it under client_secret. Accept both, refuse to guess further.
 */
function extractSecret(payload) {
  const candidates = [payload, payload?.client_secret, payload?.session?.client_secret]
  for (const candidate of candidates) {
    if (candidate && typeof candidate.value === 'string' && candidate.value.length > 0) {
      const expiresAt = Number(candidate.expires_at ?? payload?.expires_at)
      return {
        value: candidate.value,
        expires_at: Number.isFinite(expiresAt)
          ? expiresAt
          : Math.floor(Date.now() / 1000) + BOSON.tokenTtlSeconds,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- POST /api/session

async function mintEphemeralToken(apiKey) {
  const response = await fetch(BOSON.clientSecretsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // The schema is additionalProperties:false and accepts ONLY expires_after.
    // Instructions / tools / voice are rejected here; they live in browser JS.
    body: JSON.stringify({ expires_after: { seconds: BOSON.tokenTtlSeconds } }),
    signal: AbortSignal.timeout(BOSON.upstreamTimeoutMs),
  })

  const raw = await response.text()
  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 429 ? 429 : 502,
      error: `boson_client_secrets_failed`,
      detail: raw.slice(0, LIMITS.upstreamErrorChars),
      upstreamStatus: response.status,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, status: 502, error: 'boson_returned_non_json', detail: raw.slice(0, LIMITS.upstreamErrorChars) }
  }

  const secret = extractSecret(parsed)
  if (!secret) {
    return {
      ok: false,
      status: 502,
      error: 'boson_response_missing_value',
      detail: `keys: ${Object.keys(parsed ?? {}).join(', ')}`,
    }
  }
  return { ok: true, secret }
}

async function handleSession(req, res) {
  const apiKey = readApiKey()
  if (!apiKey) {
    logError(`no API key in env (looked for ${BOSON.keyEnvNames.join(', ')})`)
    return sendJson(res, 500, {
      error: 'missing_api_key',
      message:
        `Server is missing a Boson API key. Set ${BOSON.keyEnvNames[0]} in the environment ` +
        `(see .env.example) and restart. Refusing to return a token.`,
    })
  }

  try {
    await drainBody(req, LIMITS.requestBodyBytes)
  } catch (err) {
    return sendJson(res, 413, { error: 'body_too_large', message: String(err.message ?? err) })
  }

  let result
  try {
    result = await mintEphemeralToken(apiKey.key)
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    logError(`client_secrets request failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}`)
    return sendJson(res, isTimeout ? 504 : 502, {
      error: isTimeout ? 'boson_timeout' : 'boson_unreachable',
      message: `Could not reach ${BOSON.clientSecretsUrl}: ${err?.message ?? err}`,
    })
  }

  if (!result.ok) {
    logError(`client_secrets ${result.error} upstream=${result.upstreamStatus ?? '-'} detail=${result.detail}`)
    return sendJson(res, result.status, {
      error: result.error,
      message:
        result.status === 429
          ? 'Boson returned 429. If this says insufficient_quota, the trial credit has not been ' +
            'CLAIMED yet — do it from the banner on the API Keys page.'
          : 'Boson rejected the token request.',
      detail: result.detail,
    })
  }

  // ONLY these two fields. Never echo the request, never echo the real key.
  log(`minted ephemeral token from ${apiKey.source}, expires_at=${result.secret.expires_at}`)
  return sendJson(res, 200, {
    value: result.secret.value,
    expires_at: result.secret.expires_at,
  })
}

// ---------------------------------------------------------------- POST /api/verdict

/**
 * The mp4, with its provenance in headers.
 *
 * `cache` is 'miss' (this request paid for the render), 'hit' (served from a
 * previous one) or 'shared' (joined a render already in flight). The UI can say
 * "rendered in 13 s" honestly, or say nothing, but it is never guessing.
 */
function sendVerdictVideo(res, meta) {
  const headers = {
    ...CORS_HEADERS,
    'Access-Control-Expose-Headers': VERDICT.exposedHeaders,
    'Content-Type': meta.contentType,
    'Content-Length': String(meta.bytes.byteLength),
    // Never cached by the browser: the bytes are personal to one set, and the
    // server's own bounded cache is the only place a repeat should be served from.
    'Cache-Control': 'no-store',
    'X-Verdict-Cache': meta.cache,
    'X-Verdict-Job-Id': headerSafe(meta.jobId ?? 'none', 120),
    'X-Verdict-Voice': headerSafe(meta.voice, 40),
    'X-Verdict-Persona': headerSafe(meta.persona, 40),
    'X-Verdict-Text': headerSafe(meta.text, VERDICT.headerTextChars),
    'X-Verdict-Elapsed-Ms': String(meta.elapsedMs),
    'X-Verdict-Render-Ms': String(meta.renderMs),
    'X-Verdict-Polls': String(meta.polls),
  }
  if (meta.notes.length > 0) {
    headers['X-Verdict-Notes'] = headerSafe(meta.notes.join(' | '), VERDICT.headerNotesChars)
  }
  res.writeHead(200, headers)
  res.end(meta.bytes)
  return meta.bytes.byteLength
}

/**
 * Every non-200 answer. ALWAYS carries `text` once the template succeeded: the
 * ending screen is supposed to be complete without the video, so a client that
 * gets a 504 still has the coach's actual closing words to show and speak.
 */
function sendVerdictError(res, status, payload) {
  return sendJson(res, status, { ...payload, video: false })
}

/** Runs the render under the one-at-a-time rule and caches the bytes. */
async function renderAndCache({ apiKey, stats, text, cacheKey }) {
  const persona = getAvatarPersona(stats.persona)
  const single = await withVerdictSingleFlight(cacheKey, async ({ onJobId }) => {
    const startedAt = Date.now()
    const outcome = await renderVerdictVideo({ apiKey, persona, text, onJobId })
    return writeVerdictCache(cacheKey, {
      bytes: outcome.bytes,
      contentType: outcome.contentType,
      text,
      voice: outcome.voice,
      jobId: outcome.jobId,
      renderMs: Date.now() - startedAt,
      polls: outcome.statuses.length,
      attempts: outcome.attempts,
    })
  })
  log(
    `verdict render ${single.shared ? 'shared' : 'done'} persona=${stats.persona} ` +
      `job=${single.result.jobId} voice=${single.result.voice} ${single.result.renderMs}ms ` +
      `${single.result.bytes.byteLength}b polls=${single.result.polls} ` +
      `cache=${JSON.stringify(verdictCacheStats())}`,
  )
  return single
}

function verdictErrorBody(err, { stats, text }) {
  if (err instanceof VerdictBusyError) {
    return {
      status: 409,
      body: {
        error: 'render_busy',
        message:
          'Another verdict render is already in flight and this one was NOT queued — ' +
          'the ending screen is complete without the video, so retry only if you want the clip.',
        // Job id and age only. NOT err.info.key — that is another request's
        // stat tuple, and one caller's rep count is not this caller's business.
        inFlight: { jobId: err.info.jobId, elapsedMs: err.info.elapsedMs },
        retryable: true,
        text,
        persona: stats.persona,
      },
    }
  }
  if (err instanceof VerdictRenderError) {
    return {
      status: err.httpStatus,
      body: {
        error: err.code,
        message: err.message,
        detail: err.detail,
        jobId: err.jobId,
        attempts: err.attempts,
        elapsedMs: err.elapsedMs ?? null,
        // A rate limit or a timeout may well succeed later; a failed render of
        // the same text on both voices will not.
        retryable: err.code === 'render_rate_limited' || err.code === 'render_timeout',
        text,
        persona: stats.persona,
      },
    }
  }
  return null
}

async function handleVerdict(req, res) {
  const startedAt = Date.now()
  const apiKey = readApiKey()
  if (!apiKey) {
    logError(`no API key in env (looked for ${BOSON.keyEnvNames.join(', ')})`)
    return sendVerdictError(res, 500, {
      error: 'missing_api_key',
      message:
        `Server is missing a Boson API key. Set ${BOSON.keyEnvNames[0]} in the environment ` +
        '(see .env.example) and restart. No render is possible without it.',
    })
  }

  let body
  try {
    body = await readJsonBody(req, VERDICT.bodyBytes)
  } catch (err) {
    return sendVerdictError(res, err.tooLarge ? 413 : 400, {
      error: err.tooLarge ? 'body_too_large' : 'invalid_json',
      message: String(err.message ?? err),
    })
  }

  const validation = validateVerdictStats(body)
  if (!validation.ok) {
    return sendVerdictError(res, 400, {
      error: 'invalid_stats',
      field: validation.field,
      message: validation.message,
    })
  }
  // `.key` — readApiKey returns { key, source }, and passing the wrapper here
  // sends `Bearer [object Object]`, which the upstream answers with a 401 that
  // reads exactly like a revoked key.
  return renderValidated(res, { apiKey: apiKey.key, validation, startedAt })
}

/**
 * Words only: no render, no credits, ~50 ms measured. This is what lets the UI
 * show and SPEAK the coach's real closing line long before any video exists —
 * the ending screen is supposed to be complete without the clip, and this is
 * the route that makes that cheap instead of a duplicated template in the SPA.
 */
function sendVerdictPreview(res, { stats, notes, text, cacheKey }) {
  return sendJson(res, 200, {
    text,
    persona: stats.persona,
    voice: getAvatarPersona(stats.persona).voice,
    notes,
    cacheKey,
    cached: readVerdictCache(cacheKey) !== null,
    preview: true,
    video: false,
  })
}

/** Second half of handleVerdict: everything downstream of a valid stat tuple. */
async function renderValidated(res, { apiKey, validation, startedAt }) {
  const { stats, notes, preview } = validation
  const cacheKey = verdictCacheKey(stats)

  let text
  try {
    text = buildVerdictText(stats)
  } catch (err) {
    // A template that overflows or emits non-ASCII is OUR bug, not the client's.
    logError(`verdict template failed for ${cacheKey}: ${err?.message ?? err}`)
    return sendVerdictError(res, 500, {
      error: 'verdict_template_failed',
      message: 'The server could not build the closing line for those stats.',
      detail: String(err?.message ?? err),
    })
  }

  if (preview) return sendVerdictPreview(res, { stats, notes, text, cacheKey })

  const cached = readVerdictCache(cacheKey)
  if (cached) {
    return sendVerdictVideo(res, {
      ...cached,
      cache: 'hit',
      persona: stats.persona,
      notes,
      elapsedMs: Date.now() - startedAt,
    })
  }

  try {
    const single = await renderAndCache({ apiKey, stats, text, cacheKey })
    return sendVerdictVideo(res, {
      ...single.result,
      cache: single.shared ? 'shared' : 'miss',
      persona: stats.persona,
      notes,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (err) {
    const mapped = verdictErrorBody(err, { stats, text })
    if (!mapped) throw err
    // A 409 is the documented refusal, not a fault — logging it as ERROR would
    // teach whoever reads these logs to ignore the line that means something.
    const note = `verdict ${mapped.body.error} persona=${stats.persona} ${err.message}`
    if (mapped.status === 409) log(note)
    else logError(`${note} detail=${mapped.body.detail ?? '-'}`)
    return sendVerdictError(res, mapped.status, { ...mapped.body, elapsedMs: Date.now() - startedAt })
  }
}

// ---------------------------------------------------------------- static files

/** Resolve a URL path inside distDir, or null if it escapes or is not a file. */
async function resolveStaticTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const candidate = resolve(join(SERVER.distDir, normalize(decoded)))
  if (candidate !== SERVER.distDir && !candidate.startsWith(SERVER.distDir + sep)) {
    return null
  }
  try {
    const info = await stat(candidate)
    if (info.isDirectory()) return null
    return { path: candidate, size: info.size, mtime: info.mtime }
  } catch {
    return null
  }
}

/** Single `bytes=a-b` range. Enough for <video>; Safari refuses to play without it. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

function sendFile(req, res, target, urlPath, onDone) {
  const headers = {
    // Static assets are same-origin in production, but the dev split (Vite :5173
    // serving the app, this process on :8080) makes a cross-origin asset fetch
    // easy to trip over. Cheaper to allow it than to debug it at hour seven.
    ...CORS_HEADERS,
    'Content-Type': MIME_TYPES[extname(target.path).toLowerCase()] ?? DEFAULT_MIME,
    'Cache-Control': cacheControlFor(urlPath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': target.mtime.toUTCString(),
  }

  const range = req.method === 'HEAD' ? null : parseRange(req.headers.range, target.size)
  if (req.headers.range && !range && target.size > 0) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${target.size}` })
    res.end()
    return onDone(416, 0)
  }

  const start = range ? range.start : 0
  const end = range ? range.end : target.size - 1
  const length = target.size === 0 ? 0 : end - start + 1

  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${target.size}`
  headers['Content-Length'] = String(length)

  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return onDone(range ? 206 : 200, 0)
  }

  const stream = createReadStream(target.path, { start, end })
  stream.on('error', (err) => {
    logError(`stream ${target.path}: ${err.message}`)
    res.destroy()
    onDone(500, 0)
  })
  stream.on('end', () => onDone(range ? 206 : 200, length))
  stream.pipe(res)
}

async function handleStatic(req, res, urlPath, onDone) {
  const direct = await resolveStaticTarget(urlPath === '/' ? '/index.html' : urlPath)
  if (direct) return sendFile(req, res, direct, urlPath, onDone)

  // A missing asset must 404, not silently return HTML — a 200 text/html answer
  // to a missing .task or .wasm is the single most confusing failure mode here.
  if (extname(urlPath)) {
    return onDone(404, sendJson(res, 404, { error: 'not_found', path: urlPath }))
  }

  const fallback = await resolveStaticTarget('/index.html')
  if (fallback) return sendFile(req, res, fallback, '/index.html', onDone)

  return onDone(404, sendJson(res, 404, {
    error: 'no_build',
    message: `No ${SERVER.distDir}/index.html. Run \`npm run build\` (in dev, Vite serves the app on :5173 and proxies /api here).`,
  }))
}

// ---------------------------------------------------------------- router

function route(req, res, urlPath, onDone) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' })
    res.end()
    return onDone(204, 0)
  }

  if (urlPath === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return onDone(405, sendJson(res, 405, { error: 'method_not_allowed' }))
    }
    return onDone(200, sendJson(res, 200, { ok: true }))
  }

  if (urlPath === '/api/session') {
    if (req.method !== 'POST') {
      return onDone(405, sendJson(res, 405, { error: 'method_not_allowed', message: 'POST /api/session' }))
    }
    return handleSession(req, res).then((bytes) => onDone(res.statusCode, bytes ?? 0))
  }

  if (urlPath === '/api/verdict') {
    if (req.method !== 'POST') {
      return onDone(405, sendJson(res, 405, {
        error: 'method_not_allowed',
        message: 'POST /api/verdict with the workout stats as JSON',
      }))
    }
    return handleVerdict(req, res).then((bytes) => onDone(res.statusCode, bytes ?? 0))
  }

  if (urlPath.startsWith('/api/')) {
    return onDone(404, sendJson(res, 404, { error: 'no_such_route', path: urlPath }))
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return onDone(405, sendJson(res, 405, { error: 'method_not_allowed' }))
  }

  return handleStatic(req, res, urlPath, onDone)
}

const server = createServer((req, res) => {
  const startedAt = process.hrtime.bigint()
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
  let settled = false

  const onDone = (status, bytes) => {
    if (settled) return
    settled = true
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    log(`${req.method} ${urlPath} ${status} ${bytes}b ${ms.toFixed(1)}ms`)
  }

  try {
    const pending = route(req, res, urlPath, onDone)
    if (pending?.catch) {
      pending.catch((err) => {
        logError(`unhandled ${req.method} ${urlPath}: ${err?.stack ?? err}`)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
        else res.destroy()
        onDone(500, 0)
      })
    }
  } catch (err) {
    logError(`sync throw ${req.method} ${urlPath}: ${err?.stack ?? err}`)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
    onDone(500, 0)
  }
})

server.on('clientError', (err, socket) => {
  logError(`clientError ${err.code ?? err.message}`)
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(SERVER.port, SERVER.host, () => {
  const key = readApiKey()
  log(`listening on http://${SERVER.host}:${SERVER.port}`)
  log(`serving ${SERVER.distDir}`)
  if (key) log(`Boson key loaded from ${key.source}`)
  else logError(`no Boson key: POST /api/session will 500 until ${BOSON.keyEnvNames[0]} is set`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received, closing`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
