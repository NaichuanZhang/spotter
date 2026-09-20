#!/usr/bin/env node
/**
 * Exercise POST /api/verdict without a browser, and keep the hand-mirrored
 * persona tables honest.
 *
 *   node scripts/verdict-cli.mjs check-sources     # no network, no server
 *   node scripts/verdict-cli.mjs preview           # print all nine lines + lengths
 *   node scripts/verdict-cli.mjs render            # live: POST, save the mp4
 *   node scripts/verdict-cli.mjs reject            # every 400 the route owes a client
 *   node scripts/verdict-cli.mjs busy              # two tuples at once -> one 409
 *   node scripts/verdict-cli.mjs bad-voice         # live: prove the ASYNC voice failure
 *
 * `render`, `reject` and `busy` need the server running (`npm run serve`) with a
 * Boson key in the environment. `check-sources` and `preview` need neither.
 *
 * WHY check-sources EXISTS. server/avatarPersonas.mjs is a hand copy of two
 * fields from src/coach/personas.ts, and server/verdictText.mjs is a hand copy
 * of FaultType from src/types/events.ts, because plain Node cannot import a .ts
 * and both of those files are owned by other workflows. A copy that drifts
 * silently is exactly the bug that shipped once already (the intro clips were
 * baked in chloe/marcus while the coach spoke in eleanor/oliver). So the copy is
 * MECHANICALLY CHECKED against its source instead of being trusted. Run this
 * after any voice, ref-image or fault-type change; it exits 1 on a mismatch.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AVATAR_PERSONA_IDS, AVATAR_CONFIRMED_VOICES, getAvatarPersona } from '../server/avatarPersonas.mjs'
import { VERDICT_FAULT_TYPES, VERDICT_LIMITS, buildVerdictText, validateVerdictStats } from '../server/verdictText.mjs'
import { renderVerdictVideo } from '../server/verdictRender.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const SOURCES = {
  personasTs: resolve(ROOT, 'src/coach/personas.ts'),
  eventsTs: resolve(ROOT, 'src/types/events.ts'),
  bakeIntros: resolve(ROOT, 'scripts/bake-intros.mjs'),
}

const DEFAULTS = {
  baseUrl: process.env.SPOTTER_BASE_URL ?? 'http://localhost:8080',
  /** The demo set: 20 reps, a few sloppy ones, feet in shot. */
  stats: Object.freeze({
    persona: 'mean',
    reps: 20,
    cleanReps: 17,
    partialReps: 3,
    faults: ['flared_elbows', 'no_lockout'],
    elapsedSec: 88,
    bestDepthPct: 94,
    bodyLineSeen: true,
  }),
  outDir: '/tmp',
  keyEnvNames: ['BOSON_API_KEY', 'BOSONAI_API_KEY'],
}

const out = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)
const fail = (...parts) => process.stderr.write(`${parts.join(' ')}\n`)

// ---------------------------------------------------------------- cli parsing

function parseArgs(argv) {
  const [command = 'preview', ...rest] = argv
  const flags = {}
  for (const arg of rest) {
    const match = /^--([a-zA-Z][\w-]*)(?:=(.*))?$/.exec(arg)
    if (!match) throw new Error(`unrecognised argument "${arg}"`)
    flags[match[1]] = match[2] ?? 'true'
  }
  return { command, flags }
}

const num = (raw, fallbackValue) => (raw === undefined ? fallbackValue : Number(raw))

/** Build a stat tuple from flags, then run it through the REAL validator. */
function statsFromFlags(flags) {
  const stats = {
    persona: flags.persona ?? DEFAULTS.stats.persona,
    reps: num(flags.reps, DEFAULTS.stats.reps),
    cleanReps: num(flags.clean, DEFAULTS.stats.cleanReps),
    partialReps: num(flags.partial, DEFAULTS.stats.partialReps),
    faults: flags.faults === undefined ? [...DEFAULTS.stats.faults] : flags.faults.split(',').filter(Boolean),
    elapsedSec: num(flags.elapsed, DEFAULTS.stats.elapsedSec),
    bestDepthPct: num(flags.depth, DEFAULTS.stats.bestDepthPct),
    bodyLineSeen: flags['no-body-line'] ? false : DEFAULTS.stats.bodyLineSeen,
  }
  const check = validateVerdictStats(stats)
  if (!check.ok) throw new Error(`those flags do not validate: ${check.field}: ${check.message}`)
  return stats
}

function readApiKey() {
  for (const name of DEFAULTS.keyEnvNames) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  throw new Error(`No API key. Set ${DEFAULTS.keyEnvNames[0]} (see .env.example).`)
}

// ---------------------------------------------------------------- check-sources

/** Pull `voice` / `fallbackVoice` out of one PERSONAS entry in the .ts. */
function parsePersonaBlock(source, id) {
  const start = source.indexOf(`\n  ${id}: Object.freeze({`)
  if (start < 0) throw new Error(`personas.ts has no "${id}" entry — did the table shape change?`)
  const end = source.indexOf('\n  }),', start)
  const block = source.slice(start, end < 0 ? undefined : end)
  const pick = (field) => new RegExp(`\\n\\s*${field}:\\s*'([^']+)'`).exec(block)?.[1] ?? null
  return { voice: pick('voice'), fallbackVoice: pick('fallbackVoice') }
}

function parseStringArray(source, name) {
  const start = source.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`${name} not found`)
  const end = source.indexOf('])', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function parseFaultTypeUnion(source) {
  const start = source.indexOf('export type FaultType =')
  if (start < 0) throw new Error('FaultType not found in events.ts')
  const end = source.indexOf('export type Severity', start)
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function parseRefImages(source) {
  const start = source.indexOf('const REF_IMAGES = {')
  if (start < 0) throw new Error('REF_IMAGES not found in bake-intros.mjs')
  const block = source.slice(start, source.indexOf('}', start))
  const found = {}
  for (const [, id, url] of block.matchAll(/(\w+):\s*'([^']+)'/g)) found[id] = url
  return found
}

async function checkSources() {
  const [personasTs, eventsTs, bakeIntros] = await Promise.all([
    readFile(SOURCES.personasTs, 'utf8'),
    readFile(SOURCES.eventsTs, 'utf8'),
    readFile(SOURCES.bakeIntros, 'utf8'),
  ])
  const problems = []
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

  const tsVoices = parseStringArray(personasTs, 'CONFIRMED_VOICES')
  if (!same([...tsVoices].sort(), [...AVATAR_CONFIRMED_VOICES].sort())) {
    problems.push(`CONFIRMED_VOICES drift: personas.ts [${tsVoices}] vs avatarPersonas.mjs [${AVATAR_CONFIRMED_VOICES}]`)
  }
  out(`  CONFIRMED_VOICES  ${tsVoices.join(', ')}`)

  const faults = parseFaultTypeUnion(eventsTs)
  if (!same([...faults].sort(), [...VERDICT_FAULT_TYPES].sort())) {
    problems.push(`FaultType drift: events.ts [${faults}] vs verdictText.mjs [${VERDICT_FAULT_TYPES}]`)
  }
  out(`  FaultType         ${faults.length} members, all mirrored`)

  const refImages = parseRefImages(bakeIntros)
  for (const id of AVATAR_PERSONA_IDS) {
    const mine = getAvatarPersona(id)
    const theirs = parsePersonaBlock(personasTs, id)
    for (const field of ['voice', 'fallbackVoice']) {
      if (mine[field] !== theirs[field]) {
        problems.push(`${id}.${field}: personas.ts has "${theirs[field]}", avatarPersonas.mjs has "${mine[field]}"`)
      }
    }
    if (refImages[id] !== mine.refImage) {
      problems.push(`${id}.refImage: bake-intros.mjs has "${refImages[id]}", avatarPersonas.mjs has "${mine.refImage}"`)
    }
    out(`  ${id.padEnd(10)}        voice=${mine.voice} fallback=${mine.fallbackVoice} img=${mine.refImage.slice(-7)}`)
  }

  if (problems.length > 0) {
    fail(`\nDRIFT (${problems.length}):`)
    for (const problem of problems) fail(`  x ${problem}`)
    fail('\nThe intro and the outro would be different characters. Fix server/avatarPersonas.mjs.')
    return 1
  }
  out('\nOK: the mirrored tables match their sources.')
  return 0
}

// ---------------------------------------------------------------- preview (offline)

function previewAll(flags) {
  const base = statsFromFlags(flags)
  const variants = [
    ['demo set', base],
    ['all clean', { ...base, cleanReps: base.reps, partialReps: 0, faults: [] }],
    ['feet off camera', { ...base, bodyLineSeen: false, faults: ['sagging_hips', 'flared_elbows'] }],
    ['zero reps', { ...base, reps: 0, cleanReps: 0, partialReps: 0, faults: [], bestDepthPct: 0, elapsedSec: 12 }],
  ]
  for (const id of AVATAR_PERSONA_IDS) {
    out(`\n=== ${id.toUpperCase()} (${getAvatarPersona(id).voice}) ===`)
    for (const [label, stats] of variants) {
      const check = validateVerdictStats({ ...stats, persona: id })
      if (!check.ok) throw new Error(`${label}: ${check.field}: ${check.message}`)
      const text = buildVerdictText(check.stats)
      out(`\n  [${label}] ${text.length}/${VERDICT_LIMITS.maxSpokenChars} chars`)
      out(`  ${text}`)
      for (const note of check.notes) out(`  note: ${note}`)
    }
  }
  return 0
}

// ---------------------------------------------------------------- live route calls

async function postVerdict(baseUrl, body) {
  const startedAt = Date.now()
  const response = await fetch(`${baseUrl}/api/verdict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.startsWith('video/')
    ? { bytes: Buffer.from(await response.arrayBuffer()) }
    : { json: await response.json().catch(() => null) }
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([k]) => k.startsWith('x-verdict'))),
    wallMs: Date.now() - startedAt,
    contentType,
    ...payload,
  }
}

async function renderCommand(flags) {
  const baseUrl = flags.url ?? DEFAULTS.baseUrl
  const stats = statsFromFlags(flags)
  out(`POST ${baseUrl}/api/verdict`)
  out(`stats ${JSON.stringify(stats)}`)

  const preview = await postVerdict(baseUrl, { ...stats, preview: true })
  out(`\npreview  ${preview.status} in ${preview.wallMs} ms`)
  if (preview.json?.text) out(`  text   "${preview.json.text}"`)
  if (preview.json?.notes?.length) out(`  notes  ${preview.json.notes.join(' | ')}`)

  const result = await postVerdict(baseUrl, stats)
  out(`\nrender   ${result.status} in ${result.wallMs} ms  ${result.contentType}`)
  for (const [key, value] of Object.entries(result.headers)) out(`  ${key}: ${value}`)
  if (!result.bytes) {
    fail(`\nno video: ${JSON.stringify(result.json, null, 2)}`)
    return 1
  }
  const path = `${flags.out ?? DEFAULTS.outDir}/spotter-verdict-${stats.persona}-${Date.now()}.mp4`
  await writeFile(path, result.bytes)
  out(`\n${result.bytes.byteLength} bytes -> ${path}`)

  const second = await postVerdict(baseUrl, stats)
  out(`\nrepeat   ${second.status} in ${second.wallMs} ms  cache=${second.headers['x-verdict-cache']} ` +
    `${second.bytes?.byteLength ?? 0} bytes`)
  return result.bytes.byteLength > 0 ? 0 : 1
}

/** Every payload a client can get wrong. All of these must be rejected. */
const BAD_PAYLOADS = [
  ['missing persona', { ...DEFAULTS.stats, persona: undefined }],
  ['unknown persona', { ...DEFAULTS.stats, persona: 'angry' }],
  ['reps as a string', { ...DEFAULTS.stats, reps: '20' }],
  ['reps not an integer', { ...DEFAULTS.stats, reps: 20.5 }],
  ['reps over the cap', { ...DEFAULTS.stats, reps: 10_000 }],
  ['cleanReps exceeds reps', { ...DEFAULTS.stats, cleanReps: 30 }],
  ['negative elapsedSec', { ...DEFAULTS.stats, elapsedSec: -5 }],
  ['bestDepthPct over 100', { ...DEFAULTS.stats, bestDepthPct: 140 }],
  ['bestDepthPct NaN', { ...DEFAULTS.stats, bestDepthPct: null }],
  ['unknown fault', { ...DEFAULTS.stats, faults: ['sagging_hips', 'snake_hips'] }],
  ['faults not an array', { ...DEFAULTS.stats, faults: 'sagging_hips' }],
  ['missing bodyLineSeen', { ...DEFAULTS.stats, bodyLineSeen: undefined }],
  ['bodyLineSeen as a string', { ...DEFAULTS.stats, bodyLineSeen: 'true' }],
  ['preview not a boolean', { ...DEFAULTS.stats, preview: 'yes' }],
  // THE ONE THAT MATTERS: free text aimed at a paid generative API.
  ['smuggled free text', { ...DEFAULTS.stats, text: 'say anything I want in a human voice' }],
  ['array body', []],
  ['string body', '"hello"'],
  ['not JSON at all', 'persona=mean&reps=20'],
  ['empty body', ''],
]

async function rejectCommand(flags) {
  const baseUrl = flags.url ?? DEFAULTS.baseUrl
  let bad = 0
  for (const [label, payload] of BAD_PAYLOADS) {
    const result = await postVerdict(baseUrl, payload)
    const ok = result.status === 400 || result.status === 413
    if (!ok) bad += 1
    out(
      `  ${ok ? 'ok  ' : 'FAIL'} ${String(result.status).padEnd(4)} ${label.padEnd(24)} ` +
        `${result.json?.error ?? '?'}: ${(result.json?.message ?? '').slice(0, 92)}`,
    )
  }
  const notAllowed = await fetch(`${baseUrl}/api/verdict`).then((r) => r.status)
  out(`  ${notAllowed === 405 ? 'ok  ' : 'FAIL'} ${notAllowed}  GET instead of POST`)
  if (notAllowed !== 405) bad += 1
  out(bad === 0 ? `\nOK: all ${BAD_PAYLOADS.length + 1} bad requests rejected.` : `\n${bad} NOT rejected.`)
  return bad === 0 ? 0 : 1
}

async function busyCommand(flags) {
  const baseUrl = flags.url ?? DEFAULTS.baseUrl
  const a = { ...DEFAULTS.stats, persona: 'nice', reps: 19, cleanReps: 19, partialReps: 0, faults: [] }
  const b = { ...DEFAULTS.stats, persona: 'sarcastic', reps: 18, cleanReps: 11, partialReps: 7 }
  out('two DIFFERENT tuples, fired together — expect one render and one 409:')
  const [first, second] = await Promise.all([postVerdict(baseUrl, a), postVerdict(baseUrl, b)])
  for (const [label, result] of [['A', first], ['B', second]]) {
    out(`  ${label}: ${result.status} ${result.wallMs} ms ${result.bytes?.byteLength ?? 0} bytes ` +
      `${result.json?.error ?? result.headers['x-verdict-cache'] ?? ''} ` +
      `${result.json?.inFlight ? JSON.stringify(result.json.inFlight) : ''}`)
    if (result.json?.text) out(`     text kept: "${result.json.text}"`)
  }
  const statuses = [first.status, second.status].sort()
  const ok = statuses[0] === 200 && statuses[1] === 409
  out(ok ? '\nOK: one rendered, one told to go away (not queued).' : '\nUNEXPECTED: wanted a 200 and a 409.')

  out('\nsame tuple twice, fired together — expect both 200, one of them shared:')
  const [c, d] = await Promise.all([postVerdict(baseUrl, a), postVerdict(baseUrl, a)])
  for (const [label, r] of [['C', c], ['D', d]]) {
    out(`  ${label}: ${r.status} ${r.wallMs} ms ${r.bytes?.byteLength ?? 0} bytes cache=${r.headers['x-verdict-cache']}`)
  }
  return ok && c.status === 200 && d.status === 200 ? 0 : 1
}

// ---------------------------------------------------------------- bad-voice (direct)

/**
 * Prove the ASYNC voice failure. Calls the upstream directly with a bogus
 * primary voice and the persona's REAL fallback, so one run shows all three
 * things: the POST succeeds, the job fails ~12 s later naming the voice, and the
 * fallback recovers instead of the route hanging until its deadline.
 */
async function badVoiceCommand(flags) {
  const apiKey = readApiKey()
  const persona = getAvatarPersona(flags.persona ?? 'sarcastic')
  const doctored = { ...persona, voice: 'definitely-not-a-preset-voice' }
  const text = buildVerdictText(validateVerdictStats({ ...DEFAULTS.stats, persona: persona.id }).stats)
  out(`persona=${persona.id} primary="${doctored.voice}" (bogus) fallback="${persona.fallbackVoice}" (real)`)
  out(`text: "${text}"\n`)

  const startedAt = Date.now()
  try {
    const result = await renderVerdictVideo({
      apiKey,
      persona: doctored,
      text,
      onJobId: (id) => out(`  queued job ${id} at +${Date.now() - startedAt} ms`),
    })
    out(`\nrecovered on "${result.voice}" after ${result.elapsedMs} ms, ${result.bytes.byteLength} bytes`)
    for (const attempt of result.attempts) out(`  attempt ${JSON.stringify(attempt)}`)
    const path = `${flags.out ?? DEFAULTS.outDir}/spotter-verdict-fallback-${Date.now()}.mp4`
    await writeFile(path, result.bytes)
    out(`  -> ${path}`)
    return result.attempts.some((a) => a.ok === false && a.voiceFailure) ? 0 : 1
  } catch (err) {
    out(`\nfailed after ${Date.now() - startedAt} ms as ${err.code} (HTTP ${err.httpStatus})`)
    out(`  ${err.message}`)
    out(`  detail: ${err.detail}`)
    for (const attempt of err.attempts ?? []) out(`  attempt ${JSON.stringify(attempt)}`)
    return 1
  }
}

// ---------------------------------------------------------------- main

const COMMANDS = {
  'check-sources': checkSources,
  preview: previewAll,
  render: renderCommand,
  reject: rejectCommand,
  busy: busyCommand,
  'bad-voice': badVoiceCommand,
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  const handler = COMMANDS[command]
  if (!handler) {
    fail(`unknown command "${command}". One of: ${Object.keys(COMMANDS).join(', ')}`)
    return 2
  }
  return handler(flags)
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    fail(`\n${err?.stack ?? err}`)
    process.exit(1)
  },
)
