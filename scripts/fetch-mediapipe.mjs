#!/usr/bin/env node
/**
 * Vendor MediaPipe locally so a dead venue wifi cannot kill the demo.
 *
 * Pulls pose_landmarker_full.task into public/vendor/ and copies the
 * tasks-vision wasm fileset into public/vendor/wasm/. The app loads both from
 * its own origin — never from a CDN, never from storage.googleapis.com at
 * runtime.
 *
 *   node scripts/fetch-mediapipe.mjs            # idempotent, skips correct files
 *   node scripts/fetch-mediapipe.mjs --force    # re-download / re-copy everything
 *
 * Exits non-zero on any problem. A silent partial vendor is worse than a crash.
 */

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------- tunables

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const PATHS = {
  vendorDir: join(REPO_ROOT, 'public', 'vendor'),
  wasmOutDir: join(REPO_ROOT, 'public', 'vendor', 'wasm'),
  wasmSrcDir: join(REPO_ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
}

/**
 * float16/1 is the pinned revision. If this URL ever 404s, the model moved —
 * do NOT swap in "latest", pin the new revision and update expectedBytes.
 */
const MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  fileName: 'pose_landmarker_full.task',
  /** Verified byte length. A truncated download otherwise fails at runtime, inside wasm. */
  expectedBytes: 9_398_198,
}

const DOWNLOAD = {
  timeoutMs: 120_000,
  retries: 3,
  retryDelayMs: 1_500,
}

const FORCE = process.argv.includes('--force')

// ---------------------------------------------------------------- helpers

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function downloadOnce(url, destPath, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) throw new Error(`GET ${url} -> empty body`)

  const tmpPath = `${destPath}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath))
  return tmpPath
}

/** Download to a .part file, verify the byte length, then rename atomically. */
async function downloadVerified({ url, destPath, expectedBytes }) {
  let lastError
  for (let attempt = 1; attempt <= DOWNLOAD.retries; attempt += 1) {
    let tmpPath
    try {
      log(`  downloading (attempt ${attempt}/${DOWNLOAD.retries})…`)
      tmpPath = await downloadOnce(url, destPath, DOWNLOAD.timeoutMs)
      const got = await sizeOf(tmpPath)
      if (got !== expectedBytes) {
        throw new Error(
          `byte-length mismatch: expected ${expectedBytes} (${mb(expectedBytes)}), got ${got} (${mb(got ?? 0)}). ` +
            `Either the download truncated, or upstream republished the model — verify by hand before changing expectedBytes.`,
        )
      }
      await rename(tmpPath, destPath)
      return got
    } catch (err) {
      lastError = err
      if (tmpPath) await rm(tmpPath, { force: true })
      log(`  ! ${err.message}`)
      if (attempt < DOWNLOAD.retries) await sleep(DOWNLOAD.retryDelayMs * attempt)
    }
  }
  throw lastError
}

// ---------------------------------------------------------------- steps

async function vendorModel() {
  const destPath = join(PATHS.vendorDir, MODEL.fileName)
  const existing = await sizeOf(destPath)

  if (!FORCE && existing === MODEL.expectedBytes) {
    log(`✓ ${MODEL.fileName} already vendored (${mb(existing)})`)
    return existing
  }
  if (existing !== null && existing !== MODEL.expectedBytes) {
    log(`! ${MODEL.fileName} is ${mb(existing)}, expected ${mb(MODEL.expectedBytes)} — re-downloading`)
  }

  log(`→ ${MODEL.fileName}`)
  const bytes = await downloadVerified({
    url: MODEL.url,
    destPath,
    expectedBytes: MODEL.expectedBytes,
  })
  log(`✓ ${MODEL.fileName} ${mb(bytes)} verified`)
  return bytes
}

async function vendorWasm() {
  let entries
  try {
    entries = await readdir(PATHS.wasmSrcDir, { withFileTypes: true })
  } catch {
    throw new Error(
      `Cannot read ${PATHS.wasmSrcDir}. Run \`npm install\` first — the wasm fileset ships inside ` +
        `@mediapipe/tasks-vision and is not downloadable separately.`,
    )
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  if (files.length === 0) throw new Error(`${PATHS.wasmSrcDir} contains no files`)

  let total = 0
  let copied = 0
  for (const name of files) {
    const from = join(PATHS.wasmSrcDir, name)
    const to = join(PATHS.wasmOutDir, name)
    const srcBytes = await sizeOf(from)
    const destBytes = await sizeOf(to)

    if (!FORCE && destBytes === srcBytes) {
      total += srcBytes
      continue
    }
    await copyFile(from, to)
    const written = await sizeOf(to)
    if (written !== srcBytes) {
      throw new Error(`copy of ${name} is ${written} bytes, source is ${srcBytes}`)
    }
    total += written
    copied += 1
  }

  log(`✓ wasm fileset: ${files.length} files, ${mb(total)} (${copied} copied, ${files.length - copied} already current)`)
  return total
}

// ---------------------------------------------------------------- main

async function main() {
  log(`vendoring MediaPipe into ${PATHS.vendorDir}${FORCE ? ' (--force)' : ''}`)
  await mkdir(PATHS.wasmOutDir, { recursive: true })
  await mkdir(dirname(join(PATHS.vendorDir, MODEL.fileName)), { recursive: true })

  const modelBytes = await vendorModel()
  const wasmBytes = await vendorWasm()

  log('')
  log(`TOTAL VENDORED: ${mb(modelBytes + wasmBytes)}`)
  log(`  model: ${mb(modelBytes)}   wasm: ${mb(wasmBytes)}`)
  log('')
  log('In the app, point FilesetResolver at the local copy:')
  log("  FilesetResolver.forVisionTasks('/vendor/wasm')")
  log("  modelAssetPath: '/vendor/pose_landmarker_full.task'")
}

main().catch((err) => {
  process.stderr.write(`\nFAILED to vendor MediaPipe: ${err?.message ?? err}\n`)
  process.exit(1)
})
