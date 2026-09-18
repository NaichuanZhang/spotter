#!/usr/bin/env node
/**
 * Renders the 14 reference clips that public/clips/manifest.json promises.
 *
 *   node scripts/render-refs.mjs            # render all 14, then ffprobe every one
 *   node scripts/render-refs.mjs --only good_rep-side piked_hips-front
 *   node scripts/render-refs.mjs --verify-only
 *
 * WHY IT IS BUILT THIS WAY: there is no rasteriser on this machine (no rsvg-convert, no
 * ImageMagick, no Inkscape, no cairosvg, no Chrome), so SVG and PNG are both dead ends.
 * Frames are drawn by hand into a packed RGB24 buffer (ref-raster.mjs) and piped to
 * ffmpeg's rawvideo demuxer. Zero dependencies beyond ffmpeg itself.
 *
 * WHERE THE MOTION COMES FROM: public/clips/landmarks.json — real pose landmarks pulled
 * out of the source video with this repo's own vendored detector. The arc shape, the
 * shoulder's lean over the planted hand and the neutral neck angle are all measured from
 * it. The legs are not: the source crops the feet (ankle visibility 0.14 median), so they
 * are anthropometric. See the header of ref-pose.mjs, which spells out every borrowed and
 * every invented number.
 *
 * LICENCE POSITION: no frame, and no pixel, of the source video is in this repo or in
 * these outputs. What was taken is joint coordinates; what ships is our own drawing.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCanvas } from './ref-raster.mjs'
import { loadExemplar } from './ref-exemplar.mjs'
import { angleAt, buildPose, measureProjected } from './ref-pose.mjs'
import { BEAT, buildTimeline, claimsFor, FAULT_NAMES, FRAME } from './ref-clips.mjs'
import { drawFrame, fitLayout, posePoints } from './ref-draw.mjs'
import { readAppThresholds } from './ref-thresholds.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATHS = {
  manifest: resolve(ROOT, 'public/clips/manifest.json'),
  landmarks: resolve(ROOT, 'public/clips/landmarks.json'),
  outDir: resolve(ROOT, 'public/clips'),
}

const ENCODER = {
  crf: '26',
  preset: 'slow',
  codec: 'libx264',
  pixelFormat: 'yuv420p',
}

/** Tolerances for the self-check that runs before anything is encoded. */
const CHECK = {
  /**
   * How far the CONSTRUCTED elbow may differ from the angle it was asked for, in degrees.
   * Effectively zero, because the arm is built as an isosceles triangle whose base length
   * is 2*LIMB*sin(elbow/2) — so this guards the construction, not the artwork.
   *
   * The PROJECTED angle is deliberately not asserted. It legitimately differs: a tucked
   * elbow is swung partly out of the sagittal plane, so a side camera sees less bend than
   * there is, which is the same projection effect `elbowFlare` in src/pose/angles.ts is
   * documented as suffering from. Both numbers are reported instead.
   */
  elbowToleranceDeg: 0.05,
  /**
   * Biggest allowed movement of any drawn joint between CONSECUTIVE frames, as a fraction
   * of body length. The last-to-first pair is included, which is what actually tests the
   * loop: a seamless loop is not one whose last frame EQUALS its first — that would be a
   * duplicated frame and a visible hitch — it is one where the wrap costs exactly as much
   * motion as any other frame boundary.
   *
   * For scale, the extraction reports the real exemplar's worst per-frame core-joint jump
   * as 0.038 body-lengths, so this sits about 3x above honest human motion at 30fps.
   */
  maxJointJumpUnits: 0.12,
}

const EXPECTED_VIEWS = ['side', 'front']

function parseArgs(argv) {
  const only = []
  let verifyOnly = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--verify-only') verifyOnly = true
    else if (argv[i] === '--only') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) only.push(argv[++i])
    } else throw new Error(`render-refs: unknown argument "${argv[i]}"`)
  }
  return { only, verifyOnly }
}

/**
 * The manifest is the contract: it names the files and it carries the sentences the coach
 * says out loud. Reading the clip list back out of it rather than hardcoding 14 names is
 * what guarantees the renderer and the app cannot disagree about which files exist.
 */
function readClipPlan() {
  const manifest = JSON.parse(readFileSync(PATHS.manifest, 'utf8'))
  const faults = Object.keys(manifest.clips ?? {})
  const missing = FAULT_NAMES.filter((name) => !faults.includes(name))
  const extra = faults.filter((name) => !FAULT_NAMES.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `render-refs: manifest faults do not match the choreography in ref-clips.mjs ` +
        `(missing ${JSON.stringify(missing)}, unplanned ${JSON.stringify(extra)})`,
    )
  }

  return faults.flatMap((fault) =>
    EXPECTED_VIEWS.map((view) => {
      const entry = manifest.clips[fault][view]
      if (!entry?.file || !entry?.description) {
        throw new Error(`render-refs: manifest.clips.${fault}.${view} needs both file and description`)
      }
      const expected = `/clips/${fault}-${view}.mp4`
      if (entry.file !== expected) {
        throw new Error(`render-refs: manifest says ${entry.file} for ${fault}/${view}, expected ${expected}`)
      }
      return { fault, view, id: `${fault}-${view}`, file: entry.file, outPath: resolve(PATHS.outDir, `${fault}-${view}.mp4`) }
    }),
  )
}

/** Builds every pose of a clip once, so the fit, the checks and the render all agree. */
function buildClip(exemplar, clip) {
  const timeline = buildTimeline(exemplar, clip.fault, clip.view)
  const frames = timeline.map((frame) => ({
    ...frame,
    live: buildPose(exemplar, frame.live),
    ghost: frame.ghost ? buildPose(exemplar, frame.ghost) : null,
  }))
  return { ...clip, frames, layout: fitLayout(frames, clip.view, FRAME) }
}

/**
 * Refuses to encode geometry that does not measure back. Silently shipping a clip whose
 * "full depth" is actually a half rep would be the worst possible failure here, because
 * the coach describes each clip out loud and nobody re-watches 14 tiny videos.
 */
function checkClip(built, thresholds) {
  const { frames, view, id, fault } = built

  for (const frame of frames) {
    const arm = frame.live.arms.near
    const built3d = angleAt(arm.shoulder, arm.elbow, arm.wrist)
    const offBy = Math.abs(built3d - frame.live.spec.elbowDeg)
    if (offBy > CHECK.elbowToleranceDeg) {
      throw new Error(
        `${id}: asked for a ${frame.live.spec.elbowDeg.toFixed(2)} deg elbow, built ` +
          `${built3d.toFixed(2)} deg — the arm construction is wrong, not just projected`,
      )
    }
  }

  const points = frames.map((frame) => posePoints(frame.live, view))
  const jumpBetween = (a, b) => Math.max(...a.map((p, j) => Math.hypot(p.x - b[j].x, p.y - b[j].y)))
  const jumps = points.map((_, i) => jumpBetween(points[i], points[(i + 1) % points.length]))
  const loopJump = jumps[jumps.length - 1]
  const worstJump = Math.max(...jumps)
  if (worstJump > CHECK.maxJointJumpUnits) {
    const at = jumps.indexOf(worstJump)
    throw new Error(
      `${id}: a joint moves ${worstJump.toFixed(3)} body-lengths between frames ${at} and ` +
        `${(at + 1) % frames.length} (limit ${CHECK.maxJointJumpUnits}) — the motion is not smooth` +
        (at === jumps.length - 1 ? ', and that pair IS the loop point' : ''),
    )
  }

  const halves = {
    wrong: summarise(frames.filter((f) => f.beat === BEAT.wrongRep), view),
    correct: summarise(frames.filter((f) => f.beat === BEAT.correctRep), view),
  }
  const claims = claimsFor(fault, view, thresholds).map((claim) => evaluateClaim(id, claim, halves))
  const failed = claims.filter((claim) => !claim.ok)
  if (failed.length > 0) {
    throw new Error(
      `${id}: the clip does not show what its manifest description claims —\n` +
        failed.map((c) => `    ${c.text}`).join('\n'),
    )
  }

  return {
    frames: frames.length,
    durationMs: Math.round((frames.length / FRAME.fps) * 1000),
    loopJumpUnits: loopJump,
    worstJumpUnits: worstJump,
    claims,
    ...halves,
  }
}

const OPS = { '<=': (a, b) => a <= b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '>': (a, b) => a > b }

/** One claim, against one half's measured span. Unknown metrics and ops throw. */
function evaluateClaim(id, claim, halves) {
  const summary = halves[claim.half]
  if (!summary) throw new Error(`${id}: claim "${claim.what}" needs a ${claim.half} half, which this clip has none of`)
  const span = summary[claim.metric]
  if (!span) throw new Error(`${id}: claim "${claim.what}" names unknown metric "${claim.metric}"`)
  const actual = span[claim.bound]
  if (typeof actual !== 'number') throw new Error(`${id}: claim "${claim.what}" names unknown bound "${claim.bound}"`)
  const op = OPS[claim.op]
  if (!op) throw new Error(`${id}: claim "${claim.what}" names unknown operator "${claim.op}"`)
  const ok = op(actual, claim.value)
  return {
    ok,
    text: `${claim.half} ${claim.what}: ${claim.metric}.${claim.bound} ${actual.toFixed(1)} ${claim.op} ${claim.value}` +
      ` ${ok ? 'OK' : 'FAILED'}`,
  }
}

function summarise(frames, view) {
  if (frames.length === 0) return null
  const rows = frames.map((frame) => {
    const arm = frame.live.arms.near
    return {
      ...measureProjected(frame.live, view),
      // The depicted body's real elbow angle, before any camera gets hold of it.
      elbow3d: angleAt(arm.shoulder, arm.elbow, arm.wrist),
      // How far the elbow LEADS the arm, in body lengths: the signed sagittal offset of the
      // elbow from the shoulder->wrist midpoint, positive toward the head. Not an app metric
      // — it is the one number that captures what a SIDE camera can see of elbow flare,
      // which is whether the elbow winged forward or travelled back along the ribs.
      elbowLead: -(arm.elbow.x - (arm.shoulder.x + arm.wrist.x) / 2),
    }
  })
  const span = (key) => {
    const values = rows.map((row) => row[key]).filter((value) => value !== null)
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      absMax: Math.max(...values.map((value) => Math.abs(value))),
    }
  }
  return {
    elbow: span('elbow'),
    elbow3d: span('elbow3d'),
    elbowLead: span('elbowLead'),
    hipDeviation: span('hipDeviation'),
    neck: span('neck'),
    flare: span('flare'),
  }
}

async function encodeClip(built) {
  const canvas = createCanvas(FRAME.width, FRAME.height)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${FRAME.width}x${FRAME.height}`, '-r', String(FRAME.fps),
    '-i', '-',
    '-an',
    '-c:v', ENCODER.codec, '-preset', ENCODER.preset, '-crf', ENCODER.crf,
    '-pix_fmt', ENCODER.pixelFormat,
    '-movflags', '+faststart',
    built.outPath,
  ]

  const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] })
  const stderr = []
  ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk))

  const done = new Promise((resolveDone, rejectDone) => {
    ffmpeg.on('error', (error) => rejectDone(new Error(`${built.id}: could not start ffmpeg — ${error.message}`)))
    ffmpeg.on('close', (code) => {
      if (code === 0) resolveDone()
      else rejectDone(new Error(`${built.id}: ffmpeg exited ${code}\n${Buffer.concat(stderr).toString()}`))
    })
  })

  try {
    for (const frame of built.frames) {
      drawFrame(canvas, built.layout, frame, { view: built.view })
      if (!ffmpeg.stdin.write(Buffer.from(canvas.data))) {
        await new Promise((r) => ffmpeg.stdin.once('drain', r))
      }
    }
    ffmpeg.stdin.end()
  } catch (error) {
    ffmpeg.kill('SIGKILL')
    throw error
  }
  await done
}

function probe(built, expectedFrames) {
  if (!existsSync(built.outPath)) throw new Error(`${built.id}: ${built.outPath} was not written`)
  const bytes = statSync(built.outPath).size
  if (bytes === 0) throw new Error(`${built.id}: wrote a zero-byte file`)

  const result = spawnSyncJson([
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,pix_fmt,width,height,nb_frames',
    '-show_entries', 'format=duration',
    '-of', 'json', built.outPath,
  ])
  const streams = result.streams ?? []
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const video = streams.filter((s) => s.codec_type === 'video')
  const duration = Number(result.format?.duration)
  const failures = []
  if (audio.length > 0) failures.push(`has ${audio.length} audio stream(s); the coach talks over these`)
  if (video.length !== 1) failures.push(`has ${video.length} video streams`)
  else {
    if (video[0].codec_name !== 'h264') failures.push(`codec is ${video[0].codec_name}, not h264`)
    if (video[0].pix_fmt !== ENCODER.pixelFormat) failures.push(`pix_fmt is ${video[0].pix_fmt}, not ${ENCODER.pixelFormat}`)
    if (Number(video[0].nb_frames) !== expectedFrames) {
      failures.push(`holds ${video[0].nb_frames} frames, piped ${expectedFrames}`)
    }
  }
  if (!(duration > 0)) failures.push(`duration is ${result.format?.duration}`)
  if (failures.length > 0) throw new Error(`${built.id}: ${failures.join('; ')}`)

  return {
    bytes,
    duration,
    codec: video[0].codec_name,
    pixelFormat: video[0].pix_fmt,
    size: `${video[0].width}x${video[0].height}`,
    frames: Number(video[0].nb_frames),
    audioStreams: audio.length,
  }
}

function spawnSyncJson(args) {
  const run = spawnSync('ffprobe', args, { encoding: 'utf8' })
  if (run.error) throw new Error(`ffprobe could not be started: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`ffprobe exited ${run.status}: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

function formatTable(rows) {
  const headers = ['clip', 'frames', 'dur', 'codec', 'pix_fmt', 'size', 'audio', 'kB', 'loop jump', 'elbow wrong', 'elbow right']
  const body = rows.map((row) => [
    row.id,
    row.probe ? String(row.probe.frames) : String(row.check.frames),
    row.probe ? `${row.probe.duration.toFixed(2)}s` : `${(row.check.durationMs / 1000).toFixed(2)}s*`,
    row.probe?.codec ?? 'not encoded',
    row.probe?.pixelFormat ?? '-',
    row.probe?.size ?? '-',
    row.probe ? (row.probe.audioStreams === 0 ? 'none' : String(row.probe.audioStreams)) : '-',
    row.probe ? (row.probe.bytes / 1024).toFixed(0) : '-',
    row.check.loopJumpUnits.toFixed(3),
    row.check.wrong ? `${row.check.wrong.elbow3d.min.toFixed(0)}-${row.check.wrong.elbow3d.max.toFixed(0)}` : '-',
    `${row.check.correct.elbow3d.min.toFixed(0)}-${row.check.correct.elbow3d.max.toFixed(0)}`,
  ])
  const widths = headers.map((header, i) => Math.max(header.length, ...body.map((line) => line[i].length)))
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n')
}

async function main() {
  const { only, verifyOnly } = parseArgs(process.argv.slice(2))
  const plan = readClipPlan()
  const selected = only.length > 0 ? plan.filter((clip) => only.includes(clip.id)) : plan
  if (selected.length === 0) throw new Error(`render-refs: --only matched nothing of ${plan.map((c) => c.id).join(', ')}`)

  const thresholds = readAppThresholds(ROOT)
  const exemplar = loadExemplar(PATHS.landmarks)
  process.stdout.write(
    `motion source: landmarks.json good_rep (rep ${exemplar.source.repIndex}, ${exemplar.source.frameCount} frames, ` +
      `${exemplar.source.durationMs}ms, ${exemplar.source.topDeg.toFixed(1)} -> ${exemplar.source.bottomDeg.toFixed(1)} deg, ` +
      `descent ${exemplar.source.descentFrames}f / ascent ${exemplar.source.ascentFrames}f)\n` +
      `app thresholds read from src/pose at run time: ${JSON.stringify(thresholds)}\n` +
      `${selected.length} clip(s) at ${FRAME.width}x${FRAME.height} ${FRAME.fps}fps\n\n`,
  )

  const rows = []
  for (const clip of selected) {
    const built = buildClip(exemplar, clip)
    const check = checkClip(built, thresholds)
    if (!verifyOnly) await encodeClip(built)
    rows.push({ id: clip.id, check, probe: verifyOnly ? null : probe(built, check.frames) })
    process.stdout.write(`  ${verifyOnly ? 'verified' : 'rendered'} ${clip.id}\n`)
  }

  process.stdout.write(`\n${formatTable(rows)}\n\n`)
  for (const row of rows) {
    const parts = [`${row.id}: ${row.check.durationMs}ms`, `worst joint jump ${row.check.worstJumpUnits.toFixed(4)} body-lengths, loop-point jump ${row.check.loopJumpUnits.toFixed(4)}`]
    for (const [label, summary] of [['wrong', row.check.wrong], ['right', row.check.correct]]) {
      if (!summary) continue
      parts.push(
        `${label} elbow3d ${summary.elbow3d.min.toFixed(1)}..${summary.elbow3d.max.toFixed(1)}` +
          ` projected ${summary.elbow.min.toFixed(1)}..${summary.elbow.max.toFixed(1)}` +
          ` hipDev ${summary.hipDeviation.min.toFixed(1)}..${summary.hipDeviation.max.toFixed(1)}` +
          ` neck ${summary.neck.min.toFixed(1)}..${summary.neck.max.toFixed(1)}` +
          ` flare ${summary.flare.min.toFixed(1)}..${summary.flare.max.toFixed(1)}` +
          ` elbowLead ${summary.elbowLead.min.toFixed(3)}..${summary.elbowLead.max.toFixed(3)}`,
      )
    }
    process.stdout.write(`${parts.join('\n    ')}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`\nrender-refs FAILED: ${error.message}\n`)
  process.exitCode = 1
})
