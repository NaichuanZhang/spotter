/**
 * Pushup geometry over raw MediaPipe landmarks: a faithful port of src/pose/angles.ts,
 * src/pose/landmarks.ts and src/pose/smoothing.ts to plain JS, for the offline
 * reference-motion extractor. Pure functions — no fs, no network, no clock.
 *
 * NO APP THRESHOLD IS RE-TYPED HERE. Visibility gates, the degenerate-angle answer and
 * the smoothing window all arrive as arguments; `scripts/extract-landmarks.mjs` reads
 * them out of the TypeScript sources at run time, so this code cannot drift from the
 * live rep counter.
 *
 * COORDINATES: MediaPipe normalized image space, origin TOP-LEFT, **y grows DOWNWARD**.
 * Therefore a hip BELOW the shoulder->ankle line has the LARGER y and is a SAG, which
 * is POSITIVE. That sign is the single easiest thing in this codebase to invert.
 *
 * ONE DELIBERATE DIFFERENCE from the live engine: the ankle is not required (see
 * `GATE`). The app's `requiredLandmarks` needs one, because without it `hipDeviation`
 * is undefined. In a cropped portrait video the feet are outside the frame and the
 * model extrapolates them at ~0.1 visibility, so requiring an ankle would discard the
 * entire demonstration. A frame is therefore usable on the four joints that ARE
 * observed, and its body-line angles come out NULL — never as a number derived from an
 * off-frame guess. `bodyLineMeasurable` records which happened.
 *
 * TUNABLES LIVE IN: the caller (mirrored from src/pose) plus `GATE` (this file).
 */

// ------------------------------------------------------- BlazePose index model

/** Index -> name, so the committed JSON is readable without this source file. */
export const LANDMARK_NAMES = Object.freeze([
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye',
  'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index',
])

export const LANDMARK_COUNT = 33

/** Mirrors SIDE_JOINTS in src/pose/landmarks.ts. */
const SIDE_JOINTS = Object.freeze({
  left: Object.freeze({ ear: 7, shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 }),
  right: Object.freeze({ ear: 8, shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 }),
})

const SIDES = Object.freeze(['left', 'right'])

/** Compact landmark tuple layout as it arrives from the page: [x, y, z, visibility]. */
export const X = 0
export const Y = 1
export const V = 3

const RAD_TO_DEG = 180 / Math.PI
// ------------------------------------------------------------------- tunables

// ------------------------------------------------------------------- tunables

export const GATE = Object.freeze({
  /**
   * Joints a frame must show (either side, at the app's own visibility threshold)
   * before it is treated as pushup motion at all. This is the app's
   * `requiredLandmarks` MINUS the ankle — see the header for why.
   */
  coreJoints: Object.freeze(['shoulder', 'elbow', 'wrist', 'hip']),
  /** Needed for the body line only. Its absence nulls those angles, nothing else. */
  bodyLineJoints: Object.freeze(['shoulder', 'hip', 'ankle']),
  /** Reported per frame so a renderer knows which limbs are extrapolation, not data. */
  watchedJoints: Object.freeze(['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']),
})
// ------------------------------------------------------------------- geometry

/** Interior angle at `b` of a->b->c, degrees, [0,180]. Port of `angleAt`. */
function angleAt(a, b, c, geometry) {
  const bax = a[X] - b[X]
  const bay = a[Y] - b[Y]
  const bcx = c[X] - b[X]
  const bcy = c[Y] - b[Y]
  const magBA = Math.hypot(bax, bay)
  const magBC = Math.hypot(bcx, bcy)
  if (magBA < geometry.coincidentEps || magBC < geometry.coincidentEps) {
    return geometry.degenerateAngleDeg
  }
  const cos = (bax * bcx + bay * bcy) / (magBA * magBC)
  return Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos) * RAD_TO_DEG
}

/** y on segment a->b at horizontal `x`, or null when the segment is too vertical. */
function lineYAt(a, b, x, geometry) {
  const span = b[X] - a[X]
  if (Math.abs(span) < geometry.minBodySpanX) return null
  return a[Y] + ((x - a[X]) / span) * (b[Y] - a[Y])
}

function visibilityOf(lm, index) {
  const point = lm[index]
  return point && Number.isFinite(point[V]) ? point[V] : 0
}

function pointAt(lm, index) {
  const point = lm[index]
  if (!point || !Number.isFinite(point[X]) || !Number.isFinite(point[Y])) return null
  return point
}

/** Port of `pickSide`: summed visibility over the involved joints, ties go left. */
function pickSide(lm, involved, visibility) {
  const score = (joints) => involved.reduce((sum, name) => sum + visibilityOf(lm, joints[name]), 0)
  const left = score(SIDE_JOINTS.left)
  const right = score(SIDE_JOINTS.right)
  const side = left >= right ? 'left' : 'right'
  const mean = Math.max(left, right) / involved.length
  if (mean < visibility.sidePick) return null
  return { side, joints: SIDE_JOINTS[side], meanVisibility: mean }
}

function angleOfTriple(lm, joints, names, geometry) {
  const points = names.map((name) => pointAt(lm, joints[name]))
  return points.every(Boolean) ? angleAt(points[0], points[1], points[2], geometry) : null
}

/**
 * SIGNED hip deviation. POSITIVE = SAGGING (hip below the shoulder->ankle line),
 * NEGATIVE = PIKED. Magnitude is `180 - bodyLineAngle`. Port of `hipDeviation`.
 */
function hipDeviation(lm, joints, geometry) {
  const points = ['shoulder', 'hip', 'ankle'].map((name) => pointAt(lm, joints[name]))
  if (!points.every(Boolean)) return null
  const [shoulder, hip, ankle] = points
  const lineY = lineYAt(shoulder, ankle, hip[X], geometry)
  if (lineY === null) return null
  const magnitude = 180 - angleAt(shoulder, hip, ankle, geometry)
  const dy = hip[Y] - lineY
  if (dy === 0) return 0
  return dy > 0 ? magnitude : -magnitude
}

/**
 * Elbow abduction from the torso, worst (largest) of the two arms when both clear the
 * visibility gate. Port of `elbowFlare`'s un-sided branch.
 */
function elbowFlare(lm, fallbackJoints, visibility, geometry) {
  const names = ['elbow', 'shoulder', 'hip']
  const perSide = SIDES
    .filter((side) => names.every((n) => visibilityOf(lm, SIDE_JOINTS[side][n]) >= visibility.joint))
    .map((side) => angleOfTriple(lm, SIDE_JOINTS[side], names, geometry))
    .filter((value) => value !== null)
  if (perSide.length > 0) return Math.max(...perSide)
  return angleOfTriple(lm, fallbackJoints, names, geometry)
}

// -------------------------------------------------------------- frame gating

/** Named joints no side can see at the app's threshold. */
function weakJoints(lm, names, visibility) {
  return names.filter(
    (name) => !SIDES.some((side) => visibilityOf(lm, SIDE_JOINTS[side][name]) >= visibility.joint),
  )
}

function validateTuple(tuple) {
  return Array.isArray(tuple) && tuple.length >= 4 &&
    tuple.every((value) => Number.isFinite(value))
}

/**
 * Raw dump frame -> a usable frame with angles, or a rejection with a reason.
 * Rejections are COUNTED, never patched: a talking-head frame must not become
 * reference motion, and an off-frame ankle must not become a hip deviation.
 */
export function prepareFrame(frame, visibility, geometry) {
  const { i, t, lm } = frame
  if (!Number.isInteger(i) || !Number.isFinite(t)) return { ok: false, reason: 'malformed_frame' }
  if (!Array.isArray(lm) || lm.length !== LANDMARK_COUNT || !lm.every(validateTuple)) {
    return { ok: false, reason: 'malformed_landmarks' }
  }
  const missingCore = weakJoints(lm, GATE.coreJoints, visibility)
  if (missingCore.length > 0) return { ok: false, reason: `low_visibility:${missingCore.join('+')}` }

  const pick = pickSide(lm, GATE.coreJoints, visibility)
  if (!pick) return { ok: false, reason: 'no_side_clears_visibility' }

  const elbow = angleOfTriple(lm, pick.joints, ['shoulder', 'elbow', 'wrist'], geometry)
  if (elbow === null) return { ok: false, reason: 'elbow_not_measurable' }

  // The body line needs the MEASURED side's ankle. A hallucinated one is worse than none.
  const ankleSeen = visibilityOf(lm, pick.joints.ankle) >= visibility.joint
  const deviation = ankleSeen ? hipDeviation(lm, pick.joints, geometry) : null
  const bodyLine = ankleSeen ? angleOfTriple(lm, pick.joints, ['shoulder', 'hip', 'ankle'], geometry) : null

  return {
    ok: true,
    frame: {
      i,
      t,
      lm,
      side: pick.side,
      joints: pick.joints,
      bodyLineMeasurable: deviation !== null,
      weak: weakJoints(lm, GATE.watchedJoints, visibility),
      angles: {
        elbow,
        bodyLine: deviation === null ? null : bodyLine,
        hipDeviation: deviation,
        neck: angleOfTriple(lm, pick.joints, ['ear', 'shoulder', 'hip'], geometry),
        flare: elbowFlare(lm, pick.joints, visibility, geometry),
      },
    },
  }
}

// ------------------------------------------------------------------ smoothing

/**
 * Rolling median, port of src/pose/smoothing.ts including its warmup behaviour: for
 * an even count it returns the LOWER middle rather than averaging, because an
 * averaged value was never observed.
 */
export function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return sorted[n % 2 === 1 ? (n - 1) / 2 : n / 2 - 1] ?? null
}

function pushWindow(window, value, size) {
  if (value === null || !Number.isFinite(value)) return window
  const next = [...window, value]
  return next.length > size ? next.slice(next.length - size) : next
}

/** Median-filtered angle series for one segment, mirroring the engine's warmup. */
export function smoothSegment(segment, size) {
  const seed = { windows: { elbow: [], hip: [], bodyLine: [] }, out: [] }
  return segment.reduce((acc, frame) => {
    const windows = {
      elbow: pushWindow(acc.windows.elbow, frame.angles.elbow, size),
      hip: pushWindow(acc.windows.hip, frame.angles.hipDeviation, size),
      bodyLine: pushWindow(acc.windows.bodyLine, frame.angles.bodyLine, size),
    }
    return {
      windows,
      out: [...acc.out, {
        elbow: medianOf(windows.elbow),
        hipDeviation: frame.bodyLineMeasurable ? medianOf(windows.hip) : null,
        bodyLine: frame.bodyLineMeasurable ? medianOf(windows.bodyLine) : null,
      }],
    }
  }, seed).out
}

