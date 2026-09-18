/**
 * Post-processing for the reference-motion extractor: raw per-frame landmarks in,
 * segmented reps and one normalised exemplar out. Pure functions only — no fs, no
 * network, no clock. `scripts/extract-landmarks.mjs` owns all I/O and documents the
 * output schema.
 *
 * EVERY THRESHOLD IS INJECTED, none is invented here. The caller reads them out of
 * `src/pose/*.ts` at run time and passes them in, so this file segments the reference
 * video with exactly the numbers the live rep counter uses. The geometry below is a
 * faithful port of `src/pose/angles.ts` and the hysteresis is a faithful port of
 * `src/pose/repMachine.ts`; when those change, the mirrored constants change with
 * them and this file keeps agreeing.
 *
 * COORDINATES: MediaPipe normalized image space, origin TOP-LEFT, **y grows DOWNWARD**.
 * Therefore a hip BELOW the shoulder->ankle line has the LARGER y and is a SAG, which
 * is POSITIVE. That sign is the single easiest thing in this codebase to invert.
 *
 * TUNABLES LIVE IN: the caller (mirrored from src/pose) plus `EXEMPLAR` (this file).
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

/**
 * Joints without which no pushup measurement is possible; each is satisfied by
 * EITHER side, because a side view always half-occludes one of them. Mirrors
 * `requiredLandmarks` in src/pose/landmarks.ts.
 */
const REQUIRED_JOINTS = Object.freeze(['shoulder', 'elbow', 'wrist', 'hip', 'ankle'])

/** Compact landmark tuple layout: [x, y, z, visibility]. */
const X = 0
const Y = 1
const Z = 2
const V = 3

const RAD_TO_DEG = 180 / Math.PI

/**
 * Exemplar selection. The score trades depth against a straight body line, which
 * is exactly the wording of the requirement ("deepest, straightest"), with a small
 * bonus for a real lockout so a rep that never straightens loses to one that does.
 */
export const EXEMPLAR = Object.freeze({
  /** Per depth percent. Depth is the headline property of a good rep. */
  depthWeight: 1,
  /** Per degree of |hip deviation|. 4x depth so 10deg of sag cannot be bought with depth. */
  hipPenaltyPerDeg: 4,
  /** Per degree of top-of-rep elbow extension above `upEnterDeg`. */
  lockoutWeightPerDeg: 0.5,
  /** A rep shorter than this is a twitch, not a demonstrable movement. ~0.33s at 30fps. */
  minFrames: 10,
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

function triple(lm, joints, names) {
  const points = names.map((name) => pointAt(lm, joints[name]))
  return points.every(Boolean) ? points : null
}

function angleOfTriple(lm, joints, names, geometry) {
  const points = triple(lm, joints, names)
  return points ? angleAt(points[0], points[1], points[2], geometry) : null
}

/**
 * SIGNED hip deviation. POSITIVE = SAGGING (hip below the shoulder->ankle line),
 * NEGATIVE = PIKED. Magnitude is `180 - bodyLineAngle`. Port of `hipDeviation`.
 */
function hipDeviation(lm, joints, geometry) {
  const points = triple(lm, joints, ['shoulder', 'hip', 'ankle'])
  if (!points) return null
  const [shoulder, hip, ankle] = points
  const lineY = lineYAt(shoulder, ankle, hip[X], geometry)
  if (lineY === null) return null
  const magnitude = 180 - angleAt(shoulder, hip, ankle, geometry)
  const dy = hip[Y] - lineY
  if (dy === 0) return 0
  return dy > 0 ? magnitude : -magnitude
}

/**
 * Elbow abduction from the torso, worst (largest) of the two arms when both clear
 * the visibility gate. Port of `elbowFlare`'s un-sided branch.
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

/** Port of `measureAngles`. Returns null for an unmeasurable frame — never zeros. */
function measureAngles(lm, visibility, geometry) {
  const pick = pickSide(lm, ['shoulder', 'elbow', 'wrist', 'hip', 'ankle'], visibility)
  if (!pick) return null
  const elbow = angleOfTriple(lm, pick.joints, ['shoulder', 'elbow', 'wrist'], geometry)
  const bodyLine = angleOfTriple(lm, pick.joints, ['shoulder', 'hip', 'ankle'], geometry)
  const deviation = hipDeviation(lm, pick.joints, geometry)
  if (elbow === null || bodyLine === null || deviation === null) return null
  return {
    side: pick.side,
    joints: pick.joints,
    elbow,
    bodyLine,
    hipDeviation: deviation,
    neck: angleOfTriple(lm, pick.joints, ['ear', 'shoulder', 'hip'], geometry),
    flare: elbowFlare(lm, pick.joints, visibility, geometry),
  }
}

/** Port of `inFrame`: which pushup-critical joints no side can see. */
function missingJoints(lm, visibility) {
  return REQUIRED_JOINTS.filter(
    (name) => !SIDES.some((side) => visibilityOf(lm, SIDE_JOINTS[side][name]) >= visibility.joint),
  )
}

// ------------------------------------------------------------------ smoothing

/**
 * Rolling median, port of src/pose/smoothing.ts including its warmup behaviour:
 * for an even count it returns the LOWER middle rather than averaging, because an
 * averaged value was never observed.
 */
function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return sorted[n % 2 === 1 ? (n - 1) / 2 : n / 2 - 1] ?? null
}

function pushWindow(window, value, size) {
  if (!Number.isFinite(value)) return window
  const next = [...window, value]
  return next.length > size ? next.slice(next.length - size) : next
}

// ----------------------------------------------------------- frame preparation

function validateTuple(tuple) {
  return Array.isArray(tuple) && tuple.length >= 4 &&
    Number.isFinite(tuple[X]) && Number.isFinite(tuple[Y]) &&
    Number.isFinite(tuple[Z]) && Number.isFinite(tuple[V])
}

/**
 * Raw dump frame -> usable frame with angles, or a rejection with a reason.
 * Rejections are counted, never patched: a talking-head frame must not become
 * reference motion.
 */
function prepareFrame(frame, visibility, geometry) {
  const { i, t, lm } = frame
  if (!Number.isInteger(i) || !Number.isFinite(t)) return { ok: false, reason: 'malformed_frame' }
  if (!Array.isArray(lm) || lm.length !== LANDMARK_COUNT || !lm.every(validateTuple)) {
    return { ok: false, reason: 'malformed_landmarks' }
  }
  const missing = missingJoints(lm, visibility)
  if (missing.length > 0) return { ok: false, reason: `low_visibility:${missing.join('+')}` }
  const angles = measureAngles(lm, visibility, geometry)
  if (!angles) return { ok: false, reason: 'not_measurable' }
  return { ok: true, frame: { i, t, tMs: t * 1000, lm, angles } }
}

/**
 * Split usable frames into contiguous runs. A gap larger than `maxFrameGap` source
 * frames starts a new run, and the rep machine is reset per run — otherwise a
 * talking-head cutaway between a descent and an ascent would be welded into one
 * phantom rep.
 */
function splitSegments(frames, extraction) {
  const runs = frames.reduce((acc, frame) => {
    const current = acc[acc.length - 1]
    if (current && frame.i - current[current.length - 1].i <= extraction.maxFrameGap) {
      return [...acc.slice(0, -1), [...current, frame]]
    }
    return [...acc, [frame]]
  }, [])
  return runs.filter((run) => run.length >= extraction.minSegmentFrames)
}

// ---------------------------------------------------------------- rep machine

function emptyRepState() {
  return {
    phase: 'top',
    armed: false,
    lastElbow: null,
    lastT: null,
    lastPos: null,
    descentStartedAt: null,
    descentStartPos: null,
    topMaxElbow: null,
    current: null,
  }
}

/** Port of `trackDescent`: below the threshold AND measurably falling. */
function trackDescent(state, elbow, t, pos, rep) {
  if (state.lastElbow === null) return { at: null, pos: null }
  const falling = elbow < state.lastElbow - rep.descentNoiseDeg
  if (falling && elbow < rep.descentStartDeg) {
    return {
      at: state.descentStartedAt ?? state.lastT ?? t,
      pos: state.descentStartPos ?? state.lastPos ?? pos,
    }
  }
  return falling
    ? { at: state.descentStartedAt, pos: state.descentStartPos }
    : { at: null, pos: null }
}

function openAccumulator(state, sample, rep) {
  return {
    startedAt: state.descentStartedAt ?? state.lastT ?? sample.t,
    startPos: state.descentStartPos ?? state.lastPos ?? sample.pos,
    minElbow: sample.elbow,
    minElbowAt: sample.t,
    minElbowPos: sample.pos,
    maxElbow: Math.max(state.topMaxElbow ?? sample.elbow, sample.elbow),
    worstSag: Math.max(0, sample.hipDeviation),
    worstPike: Math.min(0, sample.hipDeviation),
    frames: 1,
  }
}

function accumulate(acc, sample) {
  const deeper = sample.elbow < acc.minElbow
  return {
    ...acc,
    minElbow: deeper ? sample.elbow : acc.minElbow,
    minElbowAt: deeper ? sample.t : acc.minElbowAt,
    minElbowPos: deeper ? sample.pos : acc.minElbowPos,
    maxElbow: Math.max(acc.maxElbow, sample.elbow),
    worstSag: Math.max(acc.worstSag, sample.hipDeviation),
    worstPike: Math.min(acc.worstPike, sample.hipDeviation),
    frames: acc.frames + 1,
  }
}

/** Ports `depthPct` and `worstDeviation` plus the `partial`/`clean` rules. */
function toRepMetrics(acc, endSample, rep) {
  const deviation = Math.abs(acc.worstSag) >= Math.abs(acc.worstPike) ? acc.worstSag : acc.worstPike
  const pct = ((rep.depthZeroDeg - acc.minElbow) / (rep.depthZeroDeg - rep.depthFullDeg)) * 100
  const partial = acc.minElbow > rep.partialAboveDeg
  return {
    startPos: acc.startPos,
    bottomPos: acc.minElbowPos,
    endPos: endSample.pos,
    startT: acc.startedAt,
    bottomT: acc.minElbowAt,
    endT: endSample.t,
    minElbowAngle: acc.minElbow,
    maxElbowAngle: acc.maxElbow,
    depthPct: pct < 0 ? 0 : pct > 100 ? 100 : pct,
    hipDeviationDeg: deviation,
    worstSag: acc.worstSag,
    worstPike: acc.worstPike,
    descentMs: Math.max(0, (acc.minElbowAt - acc.startedAt) * 1000),
    ascentMs: Math.max(0, (endSample.t - acc.minElbowAt) * 1000),
    frameCount: acc.frames,
    partial,
    clean: !partial && Math.abs(deviation) < rep.cleanHipDeviationDeg,
  }
}

/** One frame through the two-state hysteresis. Port of `step` in repMachine.ts. */
function stepRep(state, sample, rep) {
  if (state.phase === 'top') {
    const armed = state.armed || sample.elbow >= rep.upEnterDeg
    const descent = trackDescent(state, sample.elbow, sample.t, sample.pos, rep)
    const tracked = {
      ...state,
      armed,
      topMaxElbow: Math.max(state.topMaxElbow ?? sample.elbow, sample.elbow),
      descentStartedAt: descent.at,
      descentStartPos: descent.pos,
    }
    const tail = { lastElbow: sample.elbow, lastT: sample.t, lastPos: sample.pos }
    if (armed && sample.elbow < rep.downEnterDeg) {
      return {
        state: {
          ...tracked, ...tail,
          phase: 'bottom',
          current: openAccumulator(tracked, sample, rep),
          descentStartedAt: null,
          descentStartPos: null,
        },
        rep: null,
      }
    }
    return { state: { ...tracked, ...tail }, rep: null }
  }

  const acc = accumulate(state.current ?? openAccumulator(state, sample, rep), sample)
  const tail = { lastElbow: sample.elbow, lastT: sample.t, lastPos: sample.pos }
  if (sample.elbow <= rep.upEnterDeg) {
    return { state: { ...state, ...tail, current: acc }, rep: null }
  }
  return {
    state: {
      ...state, ...tail,
      phase: 'top',
      current: null,
      topMaxElbow: sample.elbow,
      descentStartedAt: null,
      descentStartPos: null,
    },
    rep: toRepMetrics(acc, sample, rep),
  }
}

/**
 * Smooth one segment and run the hysteresis over it. Smoothing windows and machine
 * state are local to the segment, mirroring a fresh engine start.
 */
function processSegment(segment, tunables) {
  const size = tunables.smoothing.windowSize
  const initial = {
    windows: { elbow: [], bodyLine: [], hipDeviation: [], neck: [], flare: [] },
    machine: emptyRepState(),
    smoothed: [],
    reps: [],
  }
  return segment.reduce((acc, frame, pos) => {
    const a = frame.angles
    const windows = {
      elbow: pushWindow(acc.windows.elbow, a.elbow, size),
      bodyLine: pushWindow(acc.windows.bodyLine, a.bodyLine, size),
      hipDeviation: pushWindow(acc.windows.hipDeviation, a.hipDeviation, size),
      neck: a.neck === null ? acc.windows.neck : pushWindow(acc.windows.neck, a.neck, size),
      flare: a.flare === null ? acc.windows.flare : pushWindow(acc.windows.flare, a.flare, size),
    }
    const smoothed = {
      elbow: medianOf(windows.elbow),
      bodyLine: medianOf(windows.bodyLine),
      hipDeviation: medianOf(windows.hipDeviation),
    }
    if (smoothed.elbow === null || smoothed.bodyLine === null || smoothed.hipDeviation === null) {
      return { ...acc, windows, smoothed: [...acc.smoothed, null] }
    }
    const sample = { ...smoothed, t: frame.t, pos }
    const stepped = stepRep(acc.machine, sample, tunables.rep)
    return {
      windows,
      machine: stepped.state,
      smoothed: [...acc.smoothed, smoothed],
      reps: stepped.rep ? [...acc.reps, stepped.rep] : acc.reps,
    }
  }, initial)
}

// ------------------------------------------------------------------- exemplar

function exemplarScore(rep, tunables) {
  return (
    rep.depthPct * EXEMPLAR.depthWeight -
    Math.abs(rep.hipDeviationDeg) * EXEMPLAR.hipPenaltyPerDeg +
    Math.max(0, rep.maxElbowAngle - tunables.rep.upEnterDeg) * EXEMPLAR.lockoutWeightPerDeg
  )
}

/**
 * Best rep, plus an explicit list of requirements that had to be relaxed to find
 * one. Preference order: clean and long enough -> merely not-partial -> anything.
 * Returns null only when there are no reps at all; it never invents a rep.
 */
function pickExemplar(reps, tunables) {
  const best = (candidates) => candidates.reduce(
    (top, rep) => (top === null || exemplarScore(rep, tunables) > exemplarScore(top, tunables) ? rep : top),
    null,
  )
  const longEnough = reps.filter((rep) => rep.frameCount >= EXEMPLAR.minFrames)
  const tiers = [
    { compromises: [], pool: longEnough.filter((rep) => rep.clean) },
    { compromises: ['not_clean'], pool: longEnough.filter((rep) => !rep.partial) },
    { compromises: ['not_clean', 'partial_depth'], pool: longEnough },
    { compromises: ['not_clean', 'partial_depth', `under_${EXEMPLAR.minFrames}_frames`], pool: reps },
  ]
  for (const tier of tiers) {
    const winner = best(tier.pool)
    if (winner) return { rep: winner, compromises: tier.compromises }
  }
  return null
}

// -------------------------------------------------------------- normalisation

/**
 * One similarity transform for the WHOLE rep — never per-frame, which would cancel
 * the vertical travel that is the pushup. Anchor is the rep-median ground contact
 * (wrist/ankle midpoint, the two things that do not move); scale is the rep-median
 * shoulder->ankle distance; x is mirrored when needed so the head always points -x.
 * y still grows DOWNWARD afterwards, so sag is still +y.
 */
function fitNormalisation(frames) {
  const joints = frames[0].angles.joints
  const at = (frame, name) => frame.lm[joints[name]]
  const anchorX = medianOf(frames.map((f) => (at(f, 'wrist')[X] + at(f, 'ankle')[X]) / 2))
  const anchorY = medianOf(frames.map((f) => (at(f, 'wrist')[Y] + at(f, 'ankle')[Y]) / 2))
  const scale = medianOf(frames.map((f) => Math.hypot(
    at(f, 'ankle')[X] - at(f, 'shoulder')[X],
    at(f, 'ankle')[Y] - at(f, 'shoulder')[Y],
  )))
  const facing = medianOf(frames.map((f) => at(f, 'ankle')[X] - at(f, 'shoulder')[X]))
  if (anchorX === null || anchorY === null || scale === null || !(scale > 0)) return null
  return {
    anchorX,
    anchorY,
    scale,
    flippedX: facing < 0,
    side: frames[0].angles.side,
    description:
      'x = sign*(x_img - anchorX)/scale, y = (y_img - anchorY)/scale; sign = -1 when ' +
      'flippedX. Origin is the rep-median wrist/ankle midpoint, 1.0 unit is the ' +
      'rep-median shoulder->ankle distance, head points -x, y still grows DOWNWARD.',
  }
}

function normaliseFrames(frames, fit, rep, round, decimals) {
  const sign = fit.flippedX ? -1 : 1
  const span = Math.max(1e-9, rep.endT - rep.startT)
  return frames.map((frame) => ({
    phase: round((frame.t - rep.startT) / span, 4),
    tMs: round((frame.t - rep.startT) * 1000, 1),
    i: frame.i,
    angles: {
      elbow: round(frame.angles.elbow, decimals.angle),
      bodyLine: round(frame.angles.bodyLine, decimals.angle),
      hipDeviation: round(frame.angles.hipDeviation, decimals.angle),
      neck: round(frame.angles.neck, decimals.angle),
      flare: round(frame.angles.flare, decimals.angle),
    },
    lm: frame.lm.map((point) => [
      round((sign * (point[X] - fit.anchorX)) / fit.scale, decimals.xy),
      round((point[Y] - fit.anchorY) / fit.scale, decimals.xy),
      round(point[V], decimals.visibility),
    ]),
  }))
}

// ---------------------------------------------------------------- entry point

function serialiseFrame(frame, smoothed, round, decimals) {
  return {
    i: frame.i,
    t: round(frame.t, decimals.time),
    tMs: round(frame.tMs, 1),
    side: frame.angles.side,
    angles: {
      elbow: round(frame.angles.elbow, decimals.angle),
      bodyLine: round(frame.angles.bodyLine, decimals.angle),
      hipDeviation: round(frame.angles.hipDeviation, decimals.angle),
      neck: round(frame.angles.neck, decimals.angle),
      flare: round(frame.angles.flare, decimals.angle),
    },
    smoothed: smoothed && {
      elbow: round(smoothed.elbow, decimals.angle),
      bodyLine: round(smoothed.bodyLine, decimals.angle),
      hipDeviation: round(smoothed.hipDeviation, decimals.angle),
    },
    lm: frame.lm.map((point) => [
      round(point[X], decimals.xy),
      round(point[Y], decimals.xy),
      round(point[Z], decimals.z),
      round(point[V], decimals.visibility),
    ]),
  }
}

function serialiseRep(rep, index, segmentIndex, segment, round, decimals) {
  const frameOf = (pos) => segment[Math.min(Math.max(pos, 0), segment.length - 1)].i
  return {
    index,
    segment: segmentIndex,
    startFrame: frameOf(rep.startPos),
    bottomFrame: frameOf(rep.bottomPos),
    endFrame: frameOf(rep.endPos),
    startT: round(rep.startT, decimals.time),
    bottomT: round(rep.bottomT, decimals.time),
    endT: round(rep.endT, decimals.time),
    minElbowAngle: round(rep.minElbowAngle, decimals.angle),
    maxElbowAngle: round(rep.maxElbowAngle, decimals.angle),
    depthPct: round(rep.depthPct, 1),
    hipDeviationDeg: round(rep.hipDeviationDeg, decimals.angle),
    worstSag: round(rep.worstSag, decimals.angle),
    worstPike: round(rep.worstPike, decimals.angle),
    descentMs: Math.round(rep.descentMs),
    ascentMs: Math.round(rep.ascentMs),
    frameCount: rep.frameCount,
    partial: rep.partial,
    clean: rep.clean,
  }
}

function buildGoodRep(chosen, round, decimals, tunables) {
  const { rep, compromises, segment, serialised } = chosen
  const frames = segment.slice(rep.startPos, rep.endPos + 1)
  const fit = fitNormalisation(frames)
  if (!fit) return null
  return {
    repIndex: serialised.index,
    score: round(exemplarScore(rep, tunables), 2),
    compromises,
    frameCount: frames.length,
    durationMs: Math.round((rep.endT - rep.startT) * 1000),
    stats: serialised,
    normalisation: {
      anchorX: round(fit.anchorX, 5),
      anchorY: round(fit.anchorY, 5),
      scale: round(fit.scale, 5),
      flippedX: fit.flippedX,
      measuredSide: fit.side,
      description: fit.description,
    },
    frames: normaliseFrames(frames, fit, rep, round, decimals),
  }
}

/**
 * Raw browser dump -> the committed payload's data sections. `round` is injected so
 * the I/O layer owns output precision.
 *
 * Throws on a structurally unusable dump; returns empty `reps` (and a null
 * `good_rep`) when the video simply contains no completed pushup, which is a
 * legitimate answer and must not be papered over.
 */
export function analyseExtraction(raw, tunables, extraction, round) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    throw new Error('raw dump has no frames array')
  }
  const meta = raw.meta ?? {}
  const decimals = extraction.decimals
  const ordered = [...raw.frames].sort((a, b) => a.i - b.i)
  const prepared = ordered.map((frame) => prepareFrame(frame, tunables.visibility, tunables.geometry))
  const usable = prepared.filter((entry) => entry.ok).map((entry) => entry.frame)
  const rejections = prepared.filter((entry) => !entry.ok)
    .reduce((acc, entry) => ({ ...acc, [entry.reason]: (acc[entry.reason] ?? 0) + 1 }), {})

  const segments = splitSegments(usable, extraction)
  const processed = segments.map((segment) => processSegment(segment, tunables))

  const repsWithContext = processed.flatMap((result, segmentIndex) =>
    result.reps.map((rep) => ({ rep, segmentIndex, segment: segments[segmentIndex] })))
  const reps = repsWithContext.map((entry, position) =>
    serialiseRep(entry.rep, position + 1, entry.segmentIndex, entry.segment, round, decimals))

  const chosenRep = pickExemplar(repsWithContext.map((entry) => entry.rep), tunables)
  const chosenIndex = chosenRep ? repsWithContext.findIndex((entry) => entry.rep === chosenRep.rep) : -1
  const good_rep = chosenIndex < 0 ? null : buildGoodRep({
    rep: chosenRep.rep,
    compromises: chosenRep.compromises,
    segment: repsWithContext[chosenIndex].segment,
    serialised: reps[chosenIndex],
  }, round, decimals, tunables)

  return {
    source: meta.source ?? {},
    extraction: {
      model: meta.assets?.modelPath ?? null,
      wasmBase: meta.assets?.wasmBase ?? null,
      delegate: meta.delegate ?? null,
      runningMode: meta.runningMode ?? null,
      library: meta.library ?? null,
      userAgent: meta.userAgent ?? null,
      elapsedMs: meta.elapsedMs ?? null,
      requestedFrames: meta.requestedFrames ?? ordered.length,
      detectedFrames: ordered.length,
      usableFrames: usable.length,
      rejectedFrames: ordered.length - usable.length,
      rejections,
      seekFailures: meta.seekFailures ?? null,
    },
    tunables,
    frames: segments.flatMap((segment, segmentIndex) =>
      segment.map((frame, pos) => serialiseFrame(frame, processed[segmentIndex].smoothed[pos], round, decimals))),
    segments: segments.map((segment, index) => ({
      index,
      startFrame: segment[0].i,
      endFrame: segment[segment.length - 1].i,
      frameCount: segment.length,
      startT: round(segment[0].t, decimals.time),
      endT: round(segment[segment.length - 1].t, decimals.time),
      reps: processed[index].reps.length,
    })),
    reps,
    good_rep,
  }
}
