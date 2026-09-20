/**
 * BlazePose 33-point landmark indices and visibility helpers.
 *
 * This file is the only place that knows raw index numbers. Everything downstream
 * asks for a joint by name, which is what keeps `angleAt(a, b, c)` from silently
 * measuring the wrong corner of the body.
 *
 * Coordinate space: MediaPipe `NormalizedLandmark` — x/y in 0..1 of the frame,
 * origin TOP-LEFT, so **y grows downward**. Every sign convention in this package
 * derives from that one fact. `z` is metric-ish depth relative to the hip centre
 * and is far noisier than x/y, so nothing here uses it.
 *
 * TUNABLES LIVE IN: `VISIBILITY` (this file). Other tunable groups are
 * `SMOOTHING` (smoothing.ts), `REP_THRESHOLDS` (repMachine.ts),
 * `FAULT_THRESHOLDS` / `GATE_CONFIG` (faults.ts), `ENGINE_CONFIG` (poseEngine.ts).
 */

/** Structurally compatible with MediaPipe's `NormalizedLandmark`. */
export interface Landmark {
  x: number
  y: number
  z: number
  visibility: number
}

/** Minimal shape the geometry functions need. Lets tests pass bare points. */
export interface Point2 {
  x: number
  y: number
}

// ------------------------------------------------------------ BlazePose indices

export const NOSE = 0
export const LEFT_EAR = 7
export const RIGHT_EAR = 8
export const LEFT_SHOULDER = 11
export const RIGHT_SHOULDER = 12
export const LEFT_ELBOW = 13
export const RIGHT_ELBOW = 14
export const LEFT_WRIST = 15
export const RIGHT_WRIST = 16
export const LEFT_HIP = 23
export const RIGHT_HIP = 24
export const LEFT_KNEE = 25
export const RIGHT_KNEE = 26
export const LEFT_ANKLE = 27
export const RIGHT_ANKLE = 28

/** Full BlazePose landmark count. A result array shorter than this is malformed. */
export const LANDMARK_COUNT = 33

// ------------------------------------------------------------------- side model

export type Side = 'left' | 'right'

/** The joints a pushup measurement can name. */
export type JointName = 'ear' | 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle'

export type SideJoints = Readonly<Record<JointName, number>>

export const LEFT_JOINTS: SideJoints = {
  ear: LEFT_EAR,
  shoulder: LEFT_SHOULDER,
  elbow: LEFT_ELBOW,
  wrist: LEFT_WRIST,
  hip: LEFT_HIP,
  knee: LEFT_KNEE,
  ankle: LEFT_ANKLE,
}

export const RIGHT_JOINTS: SideJoints = {
  ear: RIGHT_EAR,
  shoulder: RIGHT_SHOULDER,
  elbow: RIGHT_ELBOW,
  wrist: RIGHT_WRIST,
  hip: RIGHT_HIP,
  knee: RIGHT_KNEE,
  ankle: RIGHT_ANKLE,
}

export const SIDE_JOINTS: Readonly<Record<Side, SideJoints>> = {
  left: LEFT_JOINTS,
  right: RIGHT_JOINTS,
}

/**
 * Visibility gates. Recalibrate these first if the engine looks jumpy on real
 * hardware — MediaPipe's visibility is optimistic on a horizontal body.
 */
export const VISIBILITY = {
  /** A joint below this is treated as not seen at all. */
  joint: 0.5,
  /**
   * `pickSide` refuses to name a side when even the better side's mean visibility
   * is below this. Lower than `joint` on purpose: a side view legitimately has one
   * half-occluded limb, and we would rather measure a 0.4-confidence near arm than
   * report nothing.
   */
  sidePick: 0.35,
} as const

// ---------------------------------------------------------------------- helpers

function isUsableArray(landmarks: readonly Landmark[] | null | undefined): landmarks is readonly Landmark[] {
  return Array.isArray(landmarks) && landmarks.length >= LANDMARK_COUNT
}

/** Visibility of one index, or 0 when the index is absent or malformed. */
export function visibilityOf(landmarks: readonly Landmark[], index: number): number {
  const lm = landmarks[index]
  if (!lm || !Number.isFinite(lm.visibility)) return 0
  return lm.visibility
}

export interface SidePick {
  side: Side
  joints: SideJoints
  /** Summed visibility across the involved joints. Higher wins. */
  score: number
  /** score / involved.length — what `VISIBILITY.sidePick` is compared against. */
  meanVisibility: number
}

/**
 * Choose the left or right limb chain to measure, by SUMMED visibility of exactly
 * the joints the caller needs.
 *
 * Why not average the two sides: in a side view one arm is behind the other. The
 * occluded arm's landmarks are hallucinated at low confidence, and averaging them
 * in produces a limb that is not there — an elbow angle halfway between the real
 * arm and a guess, which is the worst of both. Picking a side tracks a real limb.
 *
 * Summed (not per-joint minimum) because a single briefly-occluded wrist should not
 * throw away an otherwise well-tracked side.
 *
 * Returns null when neither side clears `VISIBILITY.sidePick` — callers must treat
 * that as "no measurement this frame", never as a zero.
 */
export function pickSide(
  landmarks: readonly Landmark[] | null | undefined,
  involved: readonly JointName[],
): SidePick | null {
  if (!isUsableArray(landmarks) || involved.length === 0) return null

  const score = (joints: SideJoints): number =>
    involved.reduce((sum, name) => sum + visibilityOf(landmarks, joints[name]), 0)

  const left = score(LEFT_JOINTS)
  const right = score(RIGHT_JOINTS)
  // Ties go left so the chosen side does not flicker frame to frame on symmetry.
  const side: Side = left >= right ? 'left' : 'right'
  const best = Math.max(left, right)
  const meanVisibility = best / involved.length

  if (meanVisibility < VISIBILITY.sidePick) return null
  return { side, joints: SIDE_JOINTS[side], score: best, meanVisibility }
}

// ------------------------------------------------------------- in-frame checking

export interface LandmarkRequirement {
  /** Human-readable name. Goes straight into the `out_of_frame` event's `missing`. */
  name: string
  /** Satisfied when ANY of these is visible — one occluded side is fine. */
  indices: readonly number[]
}

/**
 * TWO TIERS, AND THE DIFFERENCE MATTERS.
 *
 * `countingLandmarks` are the joints without which there is no rep to count — lose one and
 * the product is off. `bodyLineLandmarks` are the extra joints the body line needs; lose one
 * of THOSE and reps keep counting while form judgement stops. Conflating the two is what
 * made a cropped pair of feet turn the whole engine off (see the amendment log in angles.ts),
 * and the joint most likely to be cropped is the ankle: a phone propped on the floor in
 * portrait or a laptop close to the user cuts the feet off routinely.
 *
 * Each entry is satisfied by either side, because a side view always half-occludes one.
 */
export const countingLandmarks: readonly LandmarkRequirement[] = [
  { name: 'shoulder', indices: [LEFT_SHOULDER, RIGHT_SHOULDER] },
  { name: 'elbow', indices: [LEFT_ELBOW, RIGHT_ELBOW] },
  { name: 'wrist', indices: [LEFT_WRIST, RIGHT_WRIST] },
]

export const bodyLineLandmarks: readonly LandmarkRequirement[] = [
  { name: 'hip', indices: [LEFT_HIP, RIGHT_HIP] },
  { name: 'ankle', indices: [LEFT_ANKLE, RIGHT_ANKLE] },
]

/**
 * Everything needed for FULL coaching: counting plus body line. Still the default for
 * `inFrame`, so `WorkoutState.inFrame` keeps meaning "I can see all of you" — but it is no
 * longer what decides whether a frame is usable.
 */
export const requiredLandmarks: readonly LandmarkRequirement[] = [
  ...countingLandmarks,
  ...bodyLineLandmarks,
]

export interface InFrameResult {
  inFrame: boolean
  /** Names of unsatisfied requirements, in requirement order. */
  missing: string[]
}

/**
 * Which of the named joints in `requirements` are missing. An empty landmark array (no pose
 * detected at all) reports every requirement missing rather than pretending the user is in
 * frame.
 */
export function inFrameFor(
  landmarks: readonly Landmark[] | null | undefined,
  requirements: readonly LandmarkRequirement[],
  threshold: number = VISIBILITY.joint,
): InFrameResult {
  if (!isUsableArray(landmarks)) {
    return { inFrame: false, missing: requirements.map((r) => r.name) }
  }
  const missing = requirements
    .filter((req) => !req.indices.some((i) => visibilityOf(landmarks, i) >= threshold))
    .map((req) => req.name)

  return { inFrame: missing.length === 0, missing }
}

/** The full-coaching set: every joint, body line included. */
export function inFrame(
  landmarks: readonly Landmark[] | null | undefined,
  threshold: number = VISIBILITY.joint,
): InFrameResult {
  return inFrameFor(landmarks, requiredLandmarks, threshold)
}

/** Just enough of the user to count reps. This is the one that gates the engine. */
export function countingInFrame(
  landmarks: readonly Landmark[] | null | undefined,
  threshold: number = VISIBILITY.joint,
): InFrameResult {
  return inFrameFor(landmarks, countingLandmarks, threshold)
}

/**
 * The extra joints the body line needs. Note this is the EITHER-SIDE check, used to explain
 * to the user which joints are off camera; the measurement itself is stricter and requires
 * hip and ankle on the one side it measures (`bodyLineVisible` in angles.ts).
 */
export function bodyLineInFrame(
  landmarks: readonly Landmark[] | null | undefined,
  threshold: number = VISIBILITY.joint,
): InFrameResult {
  return inFrameFor(landmarks, bodyLineLandmarks, threshold)
}
