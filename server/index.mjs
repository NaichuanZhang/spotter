#!/usr/bin/env node
/**
 * SPOTTER backend. Deliberately tiny: zero dependencies, node: builtins only.
 *
 * Two jobs and nothing else:
 *   1. POST /api/session  — mint a short-lived Boson ephemeral client secret.
 *                           The real BOSON_API_KEY never leaves this process.
 *   2. GET  /healthz      — liveness for Instacloud.
 * Plus static hosting of the built SPA in ./dist (the browser does all the work,
 * so there is no other route: no audio proxy, no pose endpoint, no database).
 *
 * Instacloud gives us exactly ONE http port and no raw TCP, which is why the
 * realtime WebSocket goes browser -> Boson directly and never through here.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
