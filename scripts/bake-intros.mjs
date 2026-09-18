#!/usr/bin/env node
/**
 * Bake the three persona intro videos with Higgs Avatar.
 *
 * Higgs Avatar renders in ~12 s; realtime voice answers in ~600 ms. So a live
 * lip-synced avatar is impossible and these are PRE-RENDERED: the avatar owns
 * the intro screen, realtime voice owns the workout. Run this on a laptop at
 * build time, commit nothing (the mp4s are gitignored), ship the files.
 *
 *   BOSON_API_KEY=... node scripts/bake-intros.mjs
 *   node scripts/bake-intros.mjs --only=mean        # re-render one persona
 *   node scripts/bake-intros.mjs --skip-existing    # only fill in gaps
 *   node scripts/bake-intros.mjs --no-tags          # strip TTS style tags
 *
 * THE SCRIPTS BELOW ARE THE PRODUCT. Writing beats prompting — edit INTRO_SCRIPTS
 * and re-run; each render is ~12 s and all three go concurrently.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// EDIT ME — the intro scripts. One per persona, ~15 s of speech (~45 words).
// TTS-3 tags like <|style:shouting|> and <|emotion:anger|> are PARSED AND
// CONSUMED, not read aloud (verified against the live API). Tags go in TAGS
// below so a bad tag is one edit away from being removed.
// ============================================================================

const INTRO_SCRIPTS = {
  mean:
    "I'm not here to be your friend. I'm your spotter. " +
    "You're going to give me twenty pushups, and I only count the ones that are real. " +
    'Chest down. Hips locked. Elbows in. ' +
    "Sag on me and you will hear about it. Now get on the floor.",

  nice:
    "Hey, you came back! Honestly, that's the hardest part and you already did it. " +
    "We're going to do twenty pushups together, nice and controlled, " +
    "and I'll be right here counting every single one of them. " +
    "You've got this. Start whenever you're ready.",

  sarcastic:
    "Oh good, you're back. And here I was telling everyone you'd given up. " +
    "Twenty pushups. I'll be watching, narrating, " +
    'and keeping a detailed record of what your hips get up to. ' +
    "Take your time. It's not like I have anywhere else to be.",
}

/**
 * Prepended to each script. Tags are parsed and consumed, not read aloud
 * (verified against the live API) — if an unverified tag ever gets READ ALOUD,
 * blank that persona's string (or run with --no-tags) and re-render.
 *
 * Vocabulary confirmed from the preset-voice sample inputs at
 * https://docs.boson.ai/models/higgs-tts/voices.md :
 *   emotion:  enthusiasm | elation | amusement | contentment | awe |
 *             contemplation | anger
 *   prosody:  pause | speed_slow
 *   sfx:      laughter
 *   style:    shouting
 * `enthusiasm` and `elation` are the high-energy ones and are what the docs'
 * own energetic samples use — prefer them over `happy`, which is not attested.
 */
const TAGS = {
  mean: '<|style:shouting|><|emotion:anger|>',
  nice: '<|emotion:enthusiasm|>',
  sarcastic: '<|emotion:amusement|>',
}

/**
 * ref_image must be a URL the BOSON BACKEND can fetch server-side, not just one
 * your browser can open: Wikimedia returns 403 to it. i.pravatar.cc works.
 * Different `img` values give different faces, which is what makes the three
 * personas look like three coaches.
 */
const REF_IMAGES = {
  mean: 'https://i.pravatar.cc/512?img=12',
  nice: 'https://i.pravatar.cc/512?img=47',
  sarcastic: 'https://i.pravatar.cc/512?img=33',
}

/**
 * Higgs TTS voice per persona. THE COMPLETE preset list is exactly these six —
 * confirmed from https://docs.boson.ai/models/higgs-tts/voices.md . Anything else
 * fails, and note HOW it fails for the avatar route: the POST succeeds, then the
 * render job later reports `status: "failed"` with `tts stream failed: 400 Unknown
 * voice`. So a bad voice is NOT caught by the POST-time retry — it costs a full
 * render cycle. (`GET /v1/audio/voices` lists only CLONED voices and returns an
 * empty array here; it is not the preset list.)
 *
 *   chloe    friendly, clear, engaging          — medium-high energy
 *   eleanor  calm, articulate, professional     — low energy
 *   jake     energetic, slightly dramatic       — HIGHEST energy
 *   marcus   enthusiastic, confident, professorial — high energy
 *   nora     calm, clear, narrative             — low energy
 *   oliver   calm, thoughtful, reflective, slow — LOWEST energy
 *
 * Energy is chosen deliberately here: the docs describe `nora` and `oliver` as
 * *calm*, which reads as flat for a workout coach no matter how the prompt is
 * written. Voice selection is half the energy problem; the prompt is the other half.
 */
const VOICES = {
  mean: 'jake',
  nice: 'chloe',
  sarcastic: 'marcus',
}

const VOICE_FALLBACK = 'jake'

// ============================================================================
// Below here is plumbing.
// ============================================================================

const PERSONA_IDS = ['mean', 'nice', 'sarcastic']

const API = {
  base: 'https://api.boson.ai/v1',
  /** 'higgs-avatar' is absent from /v1/models yet /v1/videos works — do not gate on a model list. */
  avatarModel: 'higgs-avatar',
  /** NOT 'higgs-tts-3', which some docs claim. */
  ttsModel: 'higgs-tts-v3',
  size: '640x640',
  keyEnvNames: ['BOSON_API_KEY', 'BOSONAI_API_KEY'],
}

const POLL = {
  intervalMs: 2_000,
  /** Renders measured at ~12 s. 3 min is a generous ceiling before we give up. */
  timeoutMs: 180_000,
  requestTimeoutMs: 30_000,
}

const OUT_DIR = resolve(fileURLToPath(new URL('../public/avatars', import.meta.url)))

const DONE_STATUSES = new Set(['completed', 'succeeded', 'success'])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'expired'])

// ---------------------------------------------------------------- cli + helpers

function parseArgs(argv) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.split('=')[1]
  if (only && !PERSONA_IDS.includes(only)) {
    throw new Error(`--only must be one of ${PERSONA_IDS.join(', ')} (got "${only}")`)
  }
  return {
    personas: only ? [only] : PERSONA_IDS,
    skipExisting: argv.includes('--skip-existing'),
    noTags: argv.includes('--no-tags'),
  }
}

function readApiKey() {
  for (const name of API.keyEnvNames) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  throw new Error(
    `No API key. Set ${API.keyEnvNames[0]} (see .env.example). ` +
      'If every call returns 429 insufficient_quota, the trial credit has not been CLAIMED — ' +
      'use the banner on the Boson API Keys page.',
  )
}

const log = (persona, ...parts) => process.stdout.write(`[${persona}] ${parts.join(' ')}\n`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function fileBytes(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function apiFetch(apiKey, path, init = {}) {
  return fetch(`${API.base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(POLL.requestTimeoutMs),
  })
}

function looksLikeVoiceError(text) {
  return /voice/i.test(text) && /(invalid|unknown|not\s+found|unsupported)/i.test(text)
}

// ---------------------------------------------------------------- render steps

async function startRender(apiKey, { persona, voice, text }) {
  const response = await apiFetch(apiKey, '/videos', {
    method: 'POST',
    body: JSON.stringify({
      model: API.avatarModel,
      ref_image: REF_IMAGES[persona],
      size: API.size,
      // Driving audio sets the output length and is capped at 60 s.
      input_tts: { model: API.ttsModel, input: text, voice },
    }),
  })

  const raw = await response.text()
  if (!response.ok) {
    const err = new Error(`POST /videos -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
    err.isVoiceError = looksLikeVoiceError(raw)
    throw err
  }

  const body = JSON.parse(raw)
  if (!body?.id) throw new Error(`POST /videos returned no id: ${raw.slice(0, 300)}`)
  return body
}

async function waitForRender(apiKey, id, persona) {
  const deadline = Date.now() + POLL.timeoutMs
  let lastStatus = ''

  while (Date.now() < deadline) {
    await sleep(POLL.intervalMs)
    const response = await apiFetch(apiKey, `/videos/${id}`)
    const raw = await response.text()

    if (!response.ok) {
      // A 404 while polling the job itself is a real error (unlike /content).
      throw new Error(`GET /videos/${id} -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
    }

    const body = JSON.parse(raw)
    const status = String(body?.status ?? 'unknown').toLowerCase()
    if (status !== lastStatus) {
      log(persona, `status: ${status}`)
      lastStatus = status
    }
    if (DONE_STATUSES.has(status)) return body
    if (FAILED_STATUSES.has(status)) {
      throw new Error(`render ${status}: ${raw.slice(0, 400)}`)
    }
  }
  throw new Error(`render did not finish within ${POLL.timeoutMs / 1000}s (id ${id})`)
}

/** A 404 on /content means not-finished-yet, not missing. Retry until it lands. */
async function downloadContent(apiKey, id, persona) {
  const deadline = Date.now() + POLL.timeoutMs
  let notReadyCount = 0

  while (Date.now() < deadline) {
    const response = await apiFetch(apiKey, `/videos/${id}/content`)
    if (response.status === 404) {
      notReadyCount += 1
      if (notReadyCount === 1) log(persona, 'content 404 (still finalising) — retrying')
      await sleep(POLL.intervalMs)
      continue
    }
    if (!response.ok) {
      const raw = await response.text()
      throw new Error(`GET /videos/${id}/content -> HTTP ${response.status}: ${raw.slice(0, 300)}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error(`GET /videos/${id}/content returned 0 bytes`)
    return bytes
  }
  throw new Error(`content never became available for ${id}`)
}

async function writeAtomic(destPath, bytes) {
  const tmpPath = `${destPath}.part`
  try {
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, destPath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

async function bakeOne(apiKey, persona, options) {
  const destPath = join(OUT_DIR, `${persona}-intro.mp4`)

  if (options.skipExisting) {
    const existing = await fileBytes(destPath)
    if (existing && existing > 0) {
      log(persona, `skip — ${destPath} already exists (${(existing / 1024).toFixed(0)} KB)`)
      return { persona, skipped: true, bytes: existing, path: destPath }
    }
  }

  const text = `${options.noTags ? '' : (TAGS[persona] ?? '')}${INTRO_SCRIPTS[persona]}`
  const startedAt = Date.now()

  let job
  let voice = VOICES[persona]
  try {
    job = await startRender(apiKey, { persona, voice, text })
  } catch (err) {
    if (!err.isVoiceError || voice === VOICE_FALLBACK) throw err
    log(persona, `! voice "${voice}" rejected — retrying with "${VOICE_FALLBACK}". Fix VOICES in this file.`)
    voice = VOICE_FALLBACK
    job = await startRender(apiKey, { persona, voice, text })
  }

  log(persona, `queued id=${job.id} voice=${voice} status=${job.status ?? 'unknown'}`)
  await waitForRender(apiKey, job.id, persona)
  const bytes = await downloadContent(apiKey, job.id, persona)
  await writeAtomic(destPath, bytes)

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(persona, `✓ ${destPath} — ${(bytes.byteLength / 1024).toFixed(0)} KB in ${seconds}s`)
  return { persona, skipped: false, bytes: bytes.byteLength, path: destPath, seconds }
}

// ---------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const apiKey = readApiKey()
  await mkdir(OUT_DIR, { recursive: true })

  process.stdout.write(
    `baking ${options.personas.join(', ')} -> ${OUT_DIR}` +
      `${options.noTags ? ' (tags stripped)' : ''}\n\n`,
  )

  // Concurrent: three ~12 s renders should take ~12 s, not ~36 s.
  const settled = await Promise.allSettled(
    options.personas.map((persona) => bakeOne(apiKey, persona, options)),
  )

  process.stdout.write('\n---- summary ----\n')
  let failures = 0
  settled.forEach((outcome, index) => {
    const persona = options.personas[index]
    if (outcome.status === 'fulfilled') {
      const { skipped, bytes, seconds } = outcome.value
      const detail = skipped ? 'skipped (already present)' : `${(bytes / 1024).toFixed(0)} KB in ${seconds}s`
      process.stdout.write(`  ✓ ${persona.padEnd(10)} ${detail}\n`)
    } else {
      failures += 1
      process.stdout.write(`  ✗ ${persona.padEnd(10)} ${outcome.reason?.message ?? outcome.reason}\n`)
    }
  })

  if (failures > 0) {
    process.stderr.write(`\n${failures} of ${settled.length} renders failed.\n`)
    process.exit(1)
  }
  process.stdout.write('\nAll intros baked. They are served from /avatars/<persona>-intro.mp4.\n')
}

main().catch((err) => {
  process.stderr.write(`\nFAILED: ${err?.message ?? err}\n`)
  process.exit(1)
})
