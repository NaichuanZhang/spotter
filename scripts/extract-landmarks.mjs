#!/usr/bin/env node
/**
 * SPOTTER reference-motion extractor: real pushup pose landmarks out of a video,
 * using THE REPO'S OWN vendored MediaPipe model, so the reference motion is
 * measured by exactly the detector the app runs.
 *
 * WHY THIS EXISTS. `public/clips/manifest.json` promises 14 reference clips. We
 * are not allowed to ship the source video or any frame of it (standard YouTube
 * licence), so we ship DERIVED MOTION DATA only: landmark coordinates plus the
 * angles computed from them. The renderer draws our own skeleton from this file.
 * The source video lives in /tmp and is never copied into the repo — not by this
 * script, not by the server below, which serves it from its /tmp path.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN IT (two processes: node serves, a browser detects)
 * ---------------------------------------------------------------------------
 * MediaPipe tasks-vision is a browser library — it needs WebAssembly + a video
 * decoder, and there is no mediapipe wheel for the local python. So extraction
 * runs in a real browser page (`scripts/extract-page.html`) driven by Playwright,
 * and this script is (a) the static server that page needs and (b) the
 * post-processor that turns the raw dump into the deliverable.
 *
 *   1. node scripts/extract-landmarks.mjs serve          # keep running
 *   2. drive a browser to http://127.0.0.1:8137/ and wait for it to finish.
 *      The page starts on load, seeks frame by frame, and POSTs its raw result
 *      to /ingest (which writes RAW_DUMP under /tmp, never into the repo).
 *      Poll progress with:  window.__spotterExtraction.summary()
 *   3. node scripts/extract-landmarks.mjs analyze         # writes the deliverable
 *
 * `analyze` is a pure file->file step, so post-processing can be re-run and
 * re-tuned without touching the browser again.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT SCHEMA — public/clips/landmarks.json  (schemaVersion 1)
 * ---------------------------------------------------------------------------
 * Coordinates are MediaPipe normalized image space: x,y in 0..1 of the frame,
 * origin TOP-LEFT, so **y grows DOWNWARD**. Every sign convention below follows
 * from that. A hip BELOW the shoulder->ankle line is SAGGING and POSITIVE.
 *
 * {
 *   schemaVersion: 1,
 *   generatedAt:   ISO8601,
 *   licence:       { note }                  // why there is no imagery here
 *   source:        { basename, durationSec, width, height, fps, frameStep,
 *                    requestedFrames }
 *   extraction:    { model, wasmBase, delegate, runningMode, library,
 *                    detectedFrames, usableFrames, rejectedFrames,
 *                    elapsedMs, userAgent }
 *   tunables:      { ... }                   // the thresholds actually used,
 *                                            // mirrored from src/pose/*.ts
 *   landmarkNames: string[33]                // BlazePose index -> name
 *   frames: [{                               // ONLY usable frames, time-ordered
 *     i, t, tMs,                             // i = source frame index, t = seconds
 *     side: 'left'|'right',                  // limb chain the angles were measured on
 *     angles: { elbow, bodyLine, hipDeviation, neck|null, flare|null },   // raw
 *     smoothed: { elbow, bodyLine, hipDeviation },                        // median-5
 *     lm: [[x, y, z, visibility] x 33]       // compact; index = BlazePose index
 *   }]
 *   segments: [{ index, startFrame, endFrame, frameCount, startT, endT }]
 *                                            // contiguous runs of usable frames.
 *                                            // The rep machine RESETS between
 *                                            // segments so a talking-head gap can
 *                                            // never bridge two halves of a rep.
 *   reps: [{ index, segment, startFrame, bottomFrame, endFrame,
 *            startT, bottomT, endT,
 *            minElbowAngle, maxElbowAngle, depthPct, hipDeviationDeg,
 *            worstSag, worstPike, descentMs, ascentMs, frameCount,
 *            partial, clean }]               // same fields the app's RepMetrics has
 *   good_rep: null | {                       // THE exemplar: deepest + straightest
 *     repIndex, score, frameCount, durationMs, stats: <the rep above>,
 *     normalisation: { anchorX, anchorY, scale, flippedX, description },
 *     frames: [{ phase, tMs, i,
 *                angles: { elbow, bodyLine, hipDeviation, neck|null, flare|null },
 *                lm: [[x, y, visibility] x 33] }]   // NORMALISED, see below
 *   }
 * }
 *
 * good_rep normalisation (one similarity transform for the whole rep, never
 * per-frame — a per-frame fit would cancel the very motion we are capturing):
 *   - translate so the rep-median ground contact (wrist/ankle midpoint) is (0,0)
 *   - scale so the rep-median shoulder->ankle distance is 1
 *   - mirror x when needed so the head always points -x (feet at +x)
 *   - y still grows DOWNWARD, so sag is still +y. Do not "fix" this.
 * A renderer maps that to pixels with: px = cx + x*S, py = cy + y*S.
 *
 * HONESTY RULE: frames with no pose, or with a pushup-relevant joint below the
 * app's own visibility gate, are DROPPED — never interpolated, never zero-filled.
 * If the video turns out to be mostly a talking head, `reps` is short or empty
 * and that is the real answer. Nothing here fabricates landmarks.
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyseExtraction, LANDMARK_NAMES } from './landmark-analysis.mjs'

// ---------------------------------------------------------------- tunables

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const PATHS = {
  page: join(REPO_ROOT, 'scripts', 'extract-page.html'),
  vendorDir: join(REPO_ROOT, 'public', 'vendor'),
  libDir: join(REPO_ROOT, 'node_modules', '@mediapipe', 'tasks-vision'),
  /** Source video. In /tmp ON PURPOSE. Never copy it into the repo. */
  sourceVideo: process.env.SPOTTER_SOURCE_VIDEO ?? '/tmp/spotter-refs/src.mp4',
  /** Raw browser dump. Also /tmp: it is an intermediate, not an artifact. */
  rawDump: process.env.SPOTTER_RAW_DUMP ?? '/tmp/spotter-refs/landmarks-raw.json',
  output: process.env.SPOTTER_LANDMARKS_OUT ?? join(REPO_ROOT, 'public', 'clips', 'landmarks.json'),
}

const SERVER = {
  host: '127.0.0.1',
  port: Number.parseInt(process.env.SPOTTER_EXTRACT_PORT ?? '', 10) || 8137,
  /** The raw dump is ~1 MB of numbers; 64 MB is slack, not an invitation. */
  ingestLimitBytes: 64 * 1024 * 1024,
}

/**
 * Where the page finds the model. These MUST match ENGINE_CONFIG.assets in
 * src/pose/poseEngine.ts — same model, same wasm, or the landmarks are no longer
 * "what the app would have seen", which is the whole point of this exercise.
 */
const ASSETS = {
  wasmBase: '/vendor/wasm',
  modelPath: '/vendor/pose_landmarker_full.task',
  /** Byte length of the vendored model, checked before serving anything. */
  modelBytes: 9_398_198,
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // The two that make FilesetResolver fail SILENTLY when guessed wrong:
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
}

const DEFAULT_MIME = 'application/octet-stream'

/**
 * Tunables mirrored out of the TypeScript sources at run time. Hardcoding copies
 * of these would drift the moment someone recalibrates the app, and the whole
 * value of this file is that it was segmented with the SAME numbers the live rep
 * counter uses. So we read them out of the source and fail loudly if a name is
 * gone. `path` is relative to the repo root; `keys` are the literal field names.
 */
const MIRRORED_TUNABLES = [
  { group: 'rep', path: 'src/pose/repMachine.ts', keys: [
    'downEnterDeg', 'upEnterDeg', 'descentStartDeg', 'descentNoiseDeg',
    'partialAboveDeg', 'depthZeroDeg', 'depthFullDeg', 'cleanHipDeviationDeg',
  ] },
  { group: 'visibility', path: 'src/pose/landmarks.ts', keys: ['joint', 'sidePick'] },
  { group: 'geometry', path: 'src/pose/angles.ts', keys: [
    'degenerateAngleDeg', 'coincidentEps', 'minBodySpanX',
  ] },
  { group: 'smoothing', path: 'src/pose/smoothing.ts', keys: ['windowSize'] },
  { group: 'landmarker', path: 'src/pose/poseEngine.ts', keys: [
    'numPoses', 'minPoseDetectionConfidence', 'minPosePresenceConfidence', 'minTrackingConfidence',
  ] },
]

/** Local to this script: how the offline pass differs from the live engine. */
const EXTRACTION = {
  /**
   * Largest gap (in source frames) that still counts as one continuous run of
   * motion. 6 frames = 200 ms at 30 fps: long enough to ride out a couple of
   * dropped detections mid-rep, short enough that a talking-head cutaway starts
   * a new segment instead of welding two unrelated halves into a phantom rep.
   */
  maxFrameGap: 6,
  /** A run shorter than this cannot contain a rep and is not worth reporting. */
  minSegmentFrames: 8,
  /** Rounding for the committed JSON. Enough precision to draw from; not 17 digits. */
  decimals: { xy: 5, z: 4, visibility: 3, angle: 2, time: 4 },
}

// ---------------------------------------------------------------- helpers

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)
const logError = (...parts) => process.stderr.write(`ERROR ${parts.join(' ')}\n`)

function fail(message) {
  logError(message)
  process.exit(1)
}

async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** Read one `key: <number>` out of a TypeScript constant block. Throws if absent. */
function readNumericConstant(source, key, where) {
  const match = new RegExp(`\\b${key}\\s*:\\s*(-?[0-9][0-9_]*(?:\\.[0-9_]+)?(?:e[-+]?[0-9]+)?)`, 'i')
    .exec(source)
  if (!match) {
    throw new Error(
      `${where}: no numeric constant named "${key}". It was renamed or removed — ` +
      'update MIRRORED_TUNABLES rather than hardcoding a guess.',
    )
  }
  const value = Number(match[1].replaceAll('_', ''))
  if (!Number.isFinite(value)) {
    throw new Error(`${where}: "${key}" parsed to a non-finite value (${match[1]})`)
  }
  return value
}

/** Every mirrored tunable, grouped. One bad read aborts the whole run. */
async function loadTunables() {
  const groups = await Promise.all(
    MIRRORED_TUNABLES.map(async ({ group, path, keys }) => {
      const absolute = join(REPO_ROOT, path)
      let source
      try {
        source = await readFile(absolute, 'utf8')
      } catch (err) {
        throw new Error(`cannot read ${path}: ${err.message ?? err}`)
      }
      const values = Object.fromEntries(
        keys.map((key) => [key, readNumericConstant(source, key, path)]),
      )
      return [group, Object.freeze(values)]
    }),
  )
  return Object.freeze({ ...Object.fromEntries(groups), extraction: EXTRACTION })
}

// ---------------------------------------------------------------- ffprobe

/** Video geometry straight from the file. Guessing fps would desync every seek. */
async function probeVideo(path) {
  const args = [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,codec_name:format=duration',
    '-select_streams', 'v:0', path,
  ]
  const raw = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (e) => rejectPromise(new Error(`ffprobe not runnable: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) return rejectPromise(new Error(`ffprobe exited ${code}: ${Buffer.concat(err)}`))
      resolvePromise(Buffer.concat(out).toString('utf8'))
    })
  })

  const parsed = JSON.parse(raw)
  const stream = parsed?.streams?.[0]
  if (!stream) throw new Error(`ffprobe found no video stream in ${path}`)

  const ratio = (text) => {
    const [num, den] = String(text ?? '').split('/')
    const value = Number(num) / (Number(den) || 1)
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const fps = ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate)
  const durationSec = Number(parsed?.format?.duration)
  if (!fps) throw new Error(`ffprobe gave no usable frame rate for ${path}`)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe gave no usable duration for ${path}`)
  }
  return {
    basename: path.split('/').pop(),
    codec: stream.codec_name ?? 'unknown',
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
    durationSec,
  }
}

// ---------------------------------------------------------------- static serving

/** Resolve `rest` inside `dir`, refusing anything that escapes it. */
async function resolveInside(dir, rest) {
  const candidate = resolve(join(dir, normalize(decodeURIComponent(rest))))
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null
  const size = await sizeOf(candidate)
  return size === null ? null : { path: candidate, size }
}

/** Single `bytes=a-b` range. <video> seeking does not work without this. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  const start = rawStart === ''
    ? Math.max(0, size - Number.parseInt(rawEnd, 10))
    : Number.parseInt(rawStart, 10)
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

function sendFile(req, res, target) {
  const headers = {
    'Content-Type': MIME_TYPES[extname(target.path).toLowerCase()] ?? DEFAULT_MIME,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  const range = req.method === 'HEAD' ? null : parseRange(req.headers.range, target.size)
  const start = range ? range.start : 0
  const end = range ? range.end : target.size - 1
  const length = target.size === 0 ? 0 : end - start + 1
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${target.size}`
  headers['Content-Length'] = String(length)

  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD' || length === 0) return res.end()

  const stream = createReadStream(target.path, { start, end })
  stream.on('error', (err) => {
    logError(`stream ${target.path}: ${err.message}`)
    res.destroy()
  })
  stream.pipe(res)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------- POST /ingest

async function handleIngest(req, res, state) {
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > SERVER.ingestLimitBytes) {
        throw new Error(`payload exceeded ${SERVER.ingestLimitBytes} bytes`)
      }
      chunks.push(chunk)
    }
  } catch (err) {
    logError(`ingest aborted: ${err.message ?? err}`)
    return sendJson(res, 413, { error: 'payload_too_large', message: String(err.message ?? err) })
  }

  const body = Buffer.concat(chunks)
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch (err) {
    logError(`ingest was not JSON: ${err.message}`)
    return sendJson(res, 400, { error: 'not_json', message: String(err.message) })
  }
  if (!Array.isArray(parsed?.frames)) {
    return sendJson(res, 400, { error: 'no_frames', message: 'expected { meta, frames: [...] }' })
  }

  await mkdir(dirname(PATHS.rawDump), { recursive: true })
  await writeFile(PATHS.rawDump, body)
  const ingested = {
    at: new Date().toISOString(),
    bytes: body.byteLength,
    frames: parsed.frames.length,
    path: PATHS.rawDump,
  }
  state.note(ingested)
  log(`ingested ${ingested.frames} detected frames (${(body.byteLength / 1e6).toFixed(2)} MB) -> ${PATHS.rawDump}`)
  return sendJson(res, 200, { ok: true, ...ingested })
}

// ---------------------------------------------------------------- serve

async function serve() {
  const modelSize = await sizeOf(join(PATHS.vendorDir, 'pose_landmarker_full.task'))
  if (modelSize !== ASSETS.modelBytes) {
    fail(
      `vendored model is ${modelSize ?? 'missing'} bytes, expected ${ASSETS.modelBytes}. ` +
      'Run `npm run vendor:mediapipe` — a truncated .task fails deep inside wasm with no useful error.',
    )
  }
  const videoSize = await sizeOf(PATHS.sourceVideo)
  if (videoSize === null) fail(`no source video at ${PATHS.sourceVideo} (set SPOTTER_SOURCE_VIDEO)`)

  let probe
  let tunables
  try {
    probe = await probeVideo(PATHS.sourceVideo)
    tunables = await loadTunables()
  } catch (err) {
    return fail(String(err.message ?? err))
  }

  const frameStep = 1 / probe.fps
  const requestedFrames = Math.floor(probe.durationSec * probe.fps)
  const config = {
    videoUrl: '/source-video.mp4',
    ingestUrl: '/ingest',
    source: { ...probe, frameStep, requestedFrames },
    assets: { wasmBase: ASSETS.wasmBase, modelPath: ASSETS.modelPath, modelBytes: ASSETS.modelBytes },
    landmarker: tunables.landmarker,
  }

  // Mutable only here, at the process boundary: the last ingest wins.
  let lastIngest = null
  const state = { note: (record) => { lastIngest = record; return true } }

  const server = createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
    const done = (status) => log(`${req.method} ${urlPath} -> ${status}`)

    const handle = async () => {
      if (urlPath === '/ingest') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'post_only' })
        await handleIngest(req, res, state)
        return done(res.statusCode)
      }
      if (urlPath === '/config') {
        sendJson(res, 200, config)
        return done(200)
      }
      if (urlPath === '/status') {
        sendJson(res, 200, { ok: true, lastIngest })
        return done(200)
      }
      if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/extract-page.html') {
        const size = await sizeOf(PATHS.page)
        if (size === null) { sendJson(res, 404, { error: 'page_missing', path: PATHS.page }); return done(404) }
        sendFile(req, res, { path: PATHS.page, size })
        return done(res.statusCode)
      }
      if (urlPath === config.videoUrl) {
        sendFile(req, res, { path: PATHS.sourceVideo, size: videoSize })
        return done(res.statusCode)
      }
      for (const [prefix, dir] of [['/vendor/', PATHS.vendorDir], ['/lib/', PATHS.libDir]]) {
        if (!urlPath.startsWith(prefix)) continue
        const target = await resolveInside(dir, urlPath.slice(prefix.length))
        if (!target) { sendJson(res, 404, { error: 'not_found', path: urlPath }); return done(404) }
        sendFile(req, res, target)
        return done(res.statusCode)
      }
      sendJson(res, 404, { error: 'no_such_route', path: urlPath })
      return done(404)
    }

    handle().catch((err) => {
      logError(`${req.method} ${urlPath}: ${err?.stack ?? err}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      else res.destroy()
    })
  })

  server.on('error', (err) => fail(`server: ${err.message}`))
  server.listen(SERVER.port, SERVER.host, () => {
    log(`extract server on http://${SERVER.host}:${SERVER.port}/`)
    log(`  page   ${PATHS.page}`)
    log(`  model  ${ASSETS.modelPath} (${modelSize} bytes)`)
    log(`  video  ${PATHS.sourceVideo} -> ${config.videoUrl} (${probe.codec} ${probe.width}x${probe.height} @ ${probe.fps}fps, ${probe.durationSec.toFixed(2)}s)`)
    log(`  frames ${requestedFrames} at step ${frameStep.toFixed(5)}s`)
    log(`  raw    POST /ingest -> ${PATHS.rawDump}`)
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log(`${signal}: closing`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    })
  }
}

// ---------------------------------------------------------------- analyze

function round(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function formatRepLine(rep) {
  const flags = [rep.partial ? 'PARTIAL' : 'full', rep.clean ? 'clean' : 'not-clean'].join('/')
  const bend = rep.hipDeviationDeg >= 0 ? 'sag' : 'pike'
  return (
    `  rep ${String(rep.index).padStart(2)}  frames ${rep.startFrame}-${rep.endFrame}` +
    ` (${rep.frameCount})  t ${rep.startT.toFixed(2)}-${rep.endT.toFixed(2)}s` +
    `  elbow ${rep.minElbowAngle.toFixed(1)}->${rep.maxElbowAngle.toFixed(1)}deg` +
    `  depth ${rep.depthPct.toFixed(0)}%` +
    `  hip ${rep.hipDeviationDeg >= 0 ? '+' : ''}${rep.hipDeviationDeg.toFixed(1)}deg (${bend})` +
    `  ${rep.descentMs}ms down / ${rep.ascentMs}ms up  ${flags}`
  )
}

async function analyze() {
  let raw
  try {
    raw = JSON.parse(await readFile(PATHS.rawDump, 'utf8'))
  } catch (err) {
    return fail(
      `cannot read raw dump ${PATHS.rawDump}: ${err.message ?? err}\n` +
      'Run `serve`, drive the browser page, and let it POST /ingest first.',
    )
  }

  let tunables
  try {
    tunables = await loadTunables()
  } catch (err) {
    return fail(String(err.message ?? err))
  }

  const result = analyseExtraction(raw, tunables, EXTRACTION, round)
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    licence: {
      note:
        'Derived motion data only. No frame, image, audio or copy of the source video ' +
        'is stored here or anywhere in this repository; the source stayed in /tmp.',
    },
    ...result,
    landmarkNames: LANDMARK_NAMES,
  }

  await mkdir(dirname(PATHS.output), { recursive: true })
  await writeFile(PATHS.output, `${JSON.stringify(payload)}\n`, 'utf8')
  const bytes = await sizeOf(PATHS.output)

  log(`wrote ${PATHS.output} (${((bytes ?? 0) / 1e6).toFixed(2)} MB)`)
  log('')
  log('EXTRACTION')
  log(`  detected frames : ${result.extraction.detectedFrames} / ${result.source.requestedFrames} requested`)
  log(`  usable frames   : ${result.extraction.usableFrames} (dropped ${result.extraction.rejectedFrames}: no pose or a core joint under the visibility gate)`)
  log(`  usable segments : ${result.segments.length}`)
  for (const segment of result.segments) {
    log(`    segment ${segment.index}: frames ${segment.startFrame}-${segment.endFrame} (${segment.frameCount}), t ${segment.startT.toFixed(2)}-${segment.endT.toFixed(2)}s`)
  }
  log('')
  log(`REPS FOUND: ${result.reps.length}`)
  for (const rep of result.reps) log(formatRepLine(rep))
  if (result.reps.length === 0) {
    log('  none. The hysteresis gate (elbow below ' +
      `${tunables.rep.downEnterDeg}deg then back above ${tunables.rep.upEnterDeg}deg) never completed.`)
  }
  log('')
  if (result.good_rep) {
    const stats = result.good_rep.stats
    log(`GOOD REP EXEMPLAR: rep ${stats.index} — ${result.good_rep.frameCount} frames, ` +
      `${result.good_rep.durationMs}ms, depth ${stats.depthPct.toFixed(0)}%, ` +
      `min elbow ${stats.minElbowAngle.toFixed(1)}deg, hip ${stats.hipDeviationDeg >= 0 ? '+' : ''}${stats.hipDeviationDeg.toFixed(1)}deg`)
  } else {
    log('GOOD REP EXEMPLAR: none — no rep cleared the exemplar requirements. ' +
      'Nothing was invented to fill the gap.')
  }
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage:
  node scripts/extract-landmarks.mjs serve     # static server for scripts/extract-page.html
  node scripts/extract-landmarks.mjs analyze   # ${PATHS.rawDump} -> ${PATHS.output}
  node scripts/extract-landmarks.mjs probe     # ffprobe the source video and exit

Env: SPOTTER_SOURCE_VIDEO, SPOTTER_RAW_DUMP, SPOTTER_LANDMARKS_OUT, SPOTTER_EXTRACT_PORT
`

async function main() {
  const command = process.argv[2] ?? 'help'
  if (command === 'serve') return serve()
  if (command === 'analyze' || command === 'analyse') return analyze()
  if (command === 'probe') {
    const probe = await probeVideo(PATHS.sourceVideo).catch((err) => fail(String(err.message ?? err)))
    return log(JSON.stringify(probe, null, 2))
  }
  if (command === 'help' || command === '--help' || command === '-h') return log(USAGE)
  logError(`unknown command "${command}"`)
  log(USAGE)
  process.exit(1)
}

main().catch((err) => fail(err?.stack ?? String(err)))
