/**
 * THE ONE FIXTURE THAT IS NOT SYNTHETIC.
 *
 * `fixtures.ts` generates every pose from geometry on purpose, and that is still the
 * right default: a recorded clip freezes one body at one camera height and stops being
 * a regression test the moment the thresholds move. But it also means nothing in this
 * repo has ever run the pipeline on a REAL horizontal human, which is the project's
 * single biggest unvalidated assumption — BlazePose is trained on upright, hip-centred
 * bodies, and a pushup is none of those things.
 *
 * This module supplies that missing input. `public/clips/landmarks.json` holds 578
 * frames of pose landmarks pulled out of a real pushup instructional video by
 * `scripts/extract-landmarks.mjs`, using THIS repo's own vendored detector
 * (`public/vendor/pose_landmarker_full.task`, GPU delegate, runningMode VIDEO) — the
 * same model `poseEngine.ts` loads at runtime. The landmarks are the detector's actual
 * output in its actual coordinate space: MediaPipe normalized image coords, 0..1,
 * y downward. They can therefore be fed to `measureAngles` unchanged.
 *
 * NO SOURCE PIXELS ARE INVOLVED. What is stored is joint coordinates; the video itself
 * never entered the repository. See the `licence` field in the JSON.
 *
 * WHAT TO USE:
 *   `loadRealMotion()`   every emitted frame in order (ready for `runPipeline`), the
 *                        source-video frame number each one came from, the six pushup
 *                        cycles the extraction found, and the counts it recorded — so a
 *                        disagreement between the file and the live code is a test failure
 *                        rather than a silent drift.
 *   `MEASURED`           what the live `src/pose` code produces on that input today.
 *
 * `good_rep.frames` in the same file is deliberately NOT used: those landmarks have been
 * put through a similarity transform (origin at the rep-median wrist, 1.0 = shoulder->hip)
 * for the renderer's benefit, so they are no longer in the app's coordinate space. The
 * exemplar is replayed from the raw `frames` array instead, sliced by its own recorded
 * frame range.
 */

import { readFileSync } from 'node:fs'
import type { Landmark } from '../landmarks'
import { LANDMARK_COUNT } from '../landmarks'
import type { Frame } from './fixtures'

/** Where the extraction writes its output. Relative to this file. */
const FIXTURE_URL = new URL('../../../public/clips/landmarks.json', import.meta.url)

/** The only schema this loader knows how to read. A bump must be handled, not guessed at. */
const SUPPORTED_SCHEMA_VERSION = 1

/** Index into a stored landmark triple. The file stores [x, y, visibility] — no z. */
const TRIPLE = { x: 0, y: 1, visibility: 2, length: 3 } as const

/** Seconds -> milliseconds. `frames[].t` is in seconds; the rep machine wants ms. */
const MS_PER_SECOND = 1000

interface StoredCycle {
  readonly index: number
  readonly startFrame: number
  readonly endFrame: number
  readonly minElbowAngle: number
  readonly maxElbowAngle: number
  readonly amplitudeDeg: number
  readonly meetsAppLockout: boolean
}

export interface RealMotionFixture {
  /** Every emitted frame, oldest first, in `runPipeline`'s shape. */
  readonly frames: readonly Frame[]
  /**
   * `frames[n]`'s frame number in the SOURCE VIDEO. Not an index — the extraction drops
   * frames the detector found nothing in, so the two run apart. Recorded ranges must be
   * resolved through this, never by slicing `frames`.
   */
  readonly sourceFrames: readonly number[]
  /** What SPOTTER's own thresholds scored during extraction. */
  readonly repsScoredByAppThresholds: number
  /** ...and what a lowered lockout scored, which is where `cycles` comes from. */
  readonly repsScoredByRelaxedThresholds: number
  readonly relaxedUpEnterDeg: number
  readonly minAmplitudeDeg: number
  /** The pushup cycles the relaxed pass found, in frame order. */
  readonly cycles: readonly StoredCycle[]
  /** Frame range of the chosen exemplar rep, for slicing `frames`. */
  readonly exemplar: { readonly startFrame: number; readonly endFrame: number; readonly minElbowAngle: number }
}

// ------------------------------------------------------------------- validation

function fail(what: string): never {
  throw new Error(
    `realMotion: public/clips/landmarks.json ${what}. ` +
      'Regenerate it with `node scripts/extract-landmarks.mjs serve` + `analyze`, ' +
      'or update this loader — do not silently accept a different shape.',
  )
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`has a non-object ${what}`)
  return value as Record<string, unknown>
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`has a non-finite ${what}`)
  return value
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) fail(`has an empty or non-array ${what}`)
  return value
}

/**
 * One stored triple -> a `Landmark`. `z` is set to 0 rather than omitted: the extraction
 * does not store it because nothing in `src/pose` reads it (see the header of angles.ts),
 * and a missing field would make the object structurally incompatible with MediaPipe's.
 */
function toLandmark(triple: readonly number[], frameIndex: number, joint: number): Landmark {
  if (triple.length !== TRIPLE.length) {
    fail(`stores ${triple.length} numbers for joint ${joint} of frame ${frameIndex}, expected ${TRIPLE.length}`)
  }
  return {
    x: asNumber(triple[TRIPLE.x], `x for joint ${joint} of frame ${frameIndex}`),
    y: asNumber(triple[TRIPLE.y], `y for joint ${joint} of frame ${frameIndex}`),
    z: 0,
    visibility: asNumber(triple[TRIPLE.visibility], `visibility for joint ${joint} of frame ${frameIndex}`),
  }
}

interface ParsedFrame {
  readonly frame: Frame
  readonly sourceFrame: number
}

function toFrame(value: unknown): ParsedFrame {
  const stored = asRecord(value, 'entry in `frames`')
  const sourceFrame = asNumber(stored.i, 'frame index `i`')
  const landmarks = asArray(stored.lm, `\`lm\` for frame ${sourceFrame}`)
  if (landmarks.length !== LANDMARK_COUNT) {
    fail(`stores ${landmarks.length} landmarks for frame ${sourceFrame}, expected ${LANDMARK_COUNT}`)
  }
  return {
    sourceFrame,
    frame: {
      landmarks: landmarks.map((triple, joint) =>
        toLandmark(asArray(triple, `landmark ${joint} of frame ${sourceFrame}`) as number[], sourceFrame, joint),
      ),
      t: asNumber(stored.t, `timestamp for frame ${sourceFrame}`) * MS_PER_SECOND,
    },
  }
}

function toCycle(value: unknown): StoredCycle {
  const rep = asRecord(value, 'entry in `reps`')
  return {
    index: asNumber(rep.index, 'rep index'),
    startFrame: asNumber(rep.startFrame, 'rep startFrame'),
    endFrame: asNumber(rep.endFrame, 'rep endFrame'),
    minElbowAngle: asNumber(rep.minElbowAngle, 'rep minElbowAngle'),
    maxElbowAngle: asNumber(rep.maxElbowAngle, 'rep maxElbowAngle'),
    amplitudeDeg: asNumber(rep.amplitudeDeg, 'rep amplitudeDeg'),
    meetsAppLockout: rep.meetsAppLockout === true,
  }
}

// ----------------------------------------------------------------------- loading

let cached: RealMotionFixture | null = null

/** Parsed once per process: 578 frames x 33 landmarks is not free, and it never changes. */
export function loadRealMotion(): RealMotionFixture {
  if (cached) return cached

  let text: string
  try {
    text = readFileSync(FIXTURE_URL, 'utf8')
  } catch (cause) {
    throw new Error(
      'realMotion: could not read public/clips/landmarks.json. It is the only real-motion ' +
        'fixture in the repo; regenerate it with `node scripts/extract-landmarks.mjs`.',
      { cause },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error('realMotion: public/clips/landmarks.json is not valid JSON.', { cause })
  }

  const root = asRecord(parsed, 'root')
  if (root.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(`declares schemaVersion ${String(root.schemaVersion)}, but this loader reads ${SUPPORTED_SCHEMA_VERSION}`)
  }

  const detection = asRecord(root.repDetection, '`repDetection`')
  const appPass = asRecord(detection.appThresholds, '`repDetection.appThresholds`')
  const usedPass = asRecord(detection.used, '`repDetection.used`')
  const exemplar = asRecord(root.good_rep, '`good_rep`')
  const exemplarStats = asRecord(exemplar.stats, '`good_rep.stats`')

  const parsedFrames = asArray(root.frames, '`frames`').map(toFrame)

  cached = {
    frames: parsedFrames.map((entry) => entry.frame),
    sourceFrames: parsedFrames.map((entry) => entry.sourceFrame),
    repsScoredByAppThresholds: asNumber(appPass.repsScored, '`appThresholds.repsScored`'),
    repsScoredByRelaxedThresholds: asNumber(usedPass.repsScored, '`used.repsScored`'),
    relaxedUpEnterDeg: asNumber(usedPass.upEnterDeg, '`used.upEnterDeg`'),
    minAmplitudeDeg: asNumber(usedPass.minAmplitudeDeg, '`used.minAmplitudeDeg`'),
    cycles: asArray(root.reps, '`reps`').map(toCycle),
    exemplar: {
      startFrame: asNumber(exemplarStats.startFrame, '`good_rep.stats.startFrame`'),
      endFrame: asNumber(exemplarStats.endFrame, '`good_rep.stats.endFrame`'),
      minElbowAngle: asNumber(exemplarStats.minElbowAngle, '`good_rep.stats.minElbowAngle`'),
    },
  }
  return cached
}

/**
 * MEASURED BY THIS TEST SUITE, not by the extraction — the numbers the live `src/pose`
 * code produces when it replays the fixture. They are written down so that a change in
 * the pipeline shows up as a diff here instead of quietly moving.
 *
 * WHY THEY LOOK LIKE A FAILURE: they are one. The demonstrator in the source video holds
 * tension and never straightens their arms, so the app's `upEnterDeg` of 155 is never
 * reached and NOT ONE of their six real pushups is counted. See the test for the full
 * argument and for what would have to change.
 */
export const MEASURED = {
  /** Every emitted frame is measurable — `measureAngles` returns non-null for all of them. */
  frameCount: 578,
  unmeasurableFrames: 0,
  /**
   * Frames satisfying `requiredLandmarks` (which includes an ankle). The source is a
   * portrait crop that cuts the feet off, so this is 8% of the clip.
   */
  inFrameFrames: 45,
  /** Reps the real rep machine scores. Zero, and that is the finding. */
  repsScored: 0,
  /** Highest smoothed elbow angle at the top of any of the six cycles. */
  highestCycleTopDeg: 151.0,
  /** Deepest smoothed elbow angle across the clip. */
  deepestElbowDeg: 10.7,
  /** Tolerance for comparing a replayed angle against a recorded one, in degrees. */
  angleToleranceDeg: 1.0,
} as const
