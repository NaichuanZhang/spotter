/**
 * The pushup skeleton the reference clips are drawn from: a 3D stick figure whose
 * proportions and whose elbow-angle arc are MEASURED from the real extraction in
 * public/clips/landmarks.json, and whose joints are then placed by forward kinematics.
 *
 * WHAT IS REAL AND WHAT IS NOT — the whole point of this file, so read it before
 * changing a number:
 *
 *   REAL (read out of landmarks.json at run time, never transcribed):
 *     - the elbow-angle arc SHAPE of good_rep (rep 3: 58 frames, 123 -> 40.1 -> 123 deg),
 *       split at the bottom and normalised per half so the loop closes exactly;
 *     - how far the shoulder leans forward of the planted wrist at each elbow angle
 *       (the shoulders really do travel past the hands at the bottom of a pushup);
 *     - the ear offset from the shoulder in the torso frame, which sets the neutral
 *       neck angle (the file's median neck is 171.3 deg; this model reproduces ~171).
 *
 *   NOT REAL, and why:
 *     - LEGS. The source is a portrait Short with the feet cropped out: ankle
 *       visibility is 0.14 median and ankle x reaches 1.27 (outside the frame), so the
 *       extraction reports hipDeviation as null on every frame. The leg segments here
 *       come from anthropometric ratios, NOT from the detector's off-frame guesses.
 *     - THE TOP OF THE ARC. The demonstrator never locks out (tops read 123-153 deg, so
 *       the app's upEnterDeg=155 scored zero reps). Clips that must show a lockout
 *       rescale the real arc to reach it. That is a documented extrapolation.
 *     - ARM SEGMENT LENGTHS. The source is a 2D projection of a 3D arm, so its apparent
 *       upper arm swings 0.40..0.57 torso units within one rep. An isosceles arm is used
 *       instead so that |shoulder - wrist| = 2*LIMB*sin(elbow/2) is exactly invertible
 *       and the drawn figure measures back the elbow angle it was asked for.
 *
 * RELATIONSHIP TO src/pose/__tests__/fixtures.ts: same idea, deliberately. That file
 * derives the shoulder height from the requested elbow angle and puts the hip at a
 * fixed fraction along the shoulder->ankle line. This is the 3D version of it, because
 * a front view needs lateral offsets and a real projection. It is a PORT, not an
 * import: fixtures.ts is test code and must not be a production render dependency. If
 * the fixture geometry is ever recalibrated, this file does not follow automatically.
 *
 * UNITS AND SIGNS, once, everywhere: one unit is the shoulder->hip length. x runs along
 * the body with the HEAD at -x. y grows DOWNWARD with the floor at y = 0, matching both
 * the screen and src/pose/angles.ts, so a sagging hip has the LARGER y exactly as
 * `hipDeviation` documents. z is lateral, +z toward the camera-near side.
 */

import { leanAt } from './ref-exemplar.mjs'

/**
 * Body proportions, in shoulder->hip lengths.
 *
 * Provenance of each: LIMB is the mean of the exemplar's apparent upper arm (median
 * 0.533) and forearm (median 0.349), forced equal so the arm is isosceles. FEMUR and
 * SHANK are anthropometric — hip->knee and knee->ankle are each ~0.245 of stature
 * against ~0.288 for shoulder->hip, hence ~0.85 — because the source's legs are off
 * frame. FOOT is ankle->toe, ~0.09 of stature. EAR_* are exemplar medians in the torso
 * frame and are what set the neutral neck angle.
 */
export const PROPORTIONS = {
  LIMB: 0.5,
  TORSO: 1.0,
  FEMUR: 0.85,
  SHANK: 0.85,
  FOOT: 0.3,
  EAR_ALONG: -0.432,
  EAR_PERP: 0.069,
  /**
   * The drawn head circle sits beyond the ear on the same ray, far enough out that the
   * neck segment is actually visible rather than swallowed by the head.
   */
  HEAD_CENTRE_FACTOR: 1.32,
  /**
   * A real head is about 0.45 shoulder->hip lengths across, so 0.225 would be
   * anatomical. 0.155 instead: on a stick figure with no face, an anatomically sized
   * circle reads as a balloon and eats the shoulder.
   */
  HEAD_RADIUS: 0.155,
  /** Planted hand and toe, drawn as short ticks on the floor so the contacts read. */
  HAND_TICK: 0.15,
  FOOT_TICK: 0.17,
  /** Wrist joint height above the floor with the palm planted. */
  WRIST_LIFT: 0.05,
  /** Lateral half-offsets: biacromial, hands a touch wider, bi-iliac, legs together. */
  Z_SHOULDER: 0.425,
  Z_WRIST: 0.5,
  Z_HIP: 0.28,
  Z_KNEE: 0.24,
  Z_ANKLE: 0.22,
  Z_EAR: 0.16,
  /** A sagging hip drags the thigh with it; a pure hip kink reads as a broken joint. */
  KNEE_SAG_SHARE: 0.35,
}

/** Shoulder->toe distance at the nominal lockout, which fixes where the toe is planted. */
const BODY_SPAN = PROPORTIONS.TORSO + PROPORTIONS.FEMUR + PROPORTIONS.SHANK + PROPORTIONS.FOOT
const NOMINAL_LOCKOUT_DEG = 175

/** Fractions along shoulder->toe. Same structural trick as fixtures.ts's hipFraction. */
const CHAIN_FRACTION = {
  hip: PROPORTIONS.TORSO / BODY_SPAN,
  knee: (PROPORTIONS.TORSO + PROPORTIONS.FEMUR) / BODY_SPAN,
  ankle: (PROPORTIONS.TORSO + PROPORTIONS.FEMUR + PROPORTIONS.SHANK) / BODY_SPAN,
  toe: 1,
}

/**
 * The two cameras, as orthographic yaw + pitch in degrees. Yaw 0 is a pure side-on view;
 * 90 would be dead head-on.
 *
 * WHY 80 AND NOT 45. Both were rendered and looked at. At 45 the body is still 2.0 units
 * long on screen against 0.7 of lateral spread, so the picture reads as a slightly rotated
 * SIDE view — which would make all seven front clips a lie, because the manifest says
 * "Front view:" and the coach reads that sentence aloud. At 80 the body foreshortens to
 * 0.50 while the hands span 0.98, so the figure is wider than it is long and reads as
 * someone coming toward the lens: head nearest, shoulders wide, elbows visibly out to the
 * sides, legs stacked away behind. Past ~85 the two sides collapse onto each other.
 *
 * WHY PITCH IS ZERO. A pitched camera was tried, on the theory that looking down the body
 * would spread the joints apart vertically. It does — and it also tilts the projected floor
 * line, so the figure reads as lying on a ramp, which is a worse error than a compact
 * silhouette. With no pitch the floor stays a horizontal line in both views.
 *
 * WHAT THE YAW COSTS, measured: the app's `elbowFlare` (elbow->shoulder->hip, front view
 * only per src/pose/angles.ts) is scale-free but not projection-free, and at this yaw the
 * torso axis foreshortens to ~0.17 of its length while an abducted upper arm keeps ~0.98 of
 * its lateral offset. So the projected abduction of even a TUCKED arm clears
 * FAULT_THRESHOLDS.flareDeg — the metric stops discriminating near true front. See the
 * flared_elbows claims in ref-clips.mjs, which assert the flared half and deliberately do
 * not assert the tucked one.
 */
export const CAMERAS = {
  side: { yawDeg: 0, pitchDeg: 0 },
  front: { yawDeg: 80, pitchDeg: 0 },
}

/** Bisection budget for solving the elbow roll that produces a requested flare. */
const FLARE_SOLVE = { minRollDeg: 0, maxRollDeg: 135, iterations: 40 }

/** Pose parameters. Everything defaults to correct form; each clip overrides one thing. */
export const NEUTRAL_POSE = {
  elbowDeg: NOMINAL_LOCKOUT_DEG,
  /** Hip offset perpendicular to shoulder->toe. + = sag (below the line), - = pike. */
  sagUnits: 0,
  /**
   * Which way the bent elbow points, in degrees of humeral roll about the
   * shoulder->wrist axis: 0 points it straight back along the ribs (tucked), 90 swings
   * it out sideways (flared). This, not the measured abduction angle, is the parameter
   * the athlete actually controls — and it is the only one that stays meaningful at
   * lockout, where a straight arm puts the elbow ON the shoulder->wrist line and no
   * roll changes the measured elbow->shoulder->hip angle at all. Use `rollForFlare` to
   * convert a target abduction at a given depth into a roll.
   */
  elbowRollDeg: 0,
  /** Degrees the head is rotated off the neutral neck ray, toward the floor. */
  craneDeg: 0,
  /** Fraction the shoulder->ear ray is shortened: the head sinking between the shoulders. */
  shrugUnits: 0,
  /** Degrees added to the forward shoulder lean. + = shoulders creep past the hands. */
  leanBiasDeg: 0,
  /** Lateral head tilt, degrees. Visible in the front view only; not measured by the app. */
  headTiltDeg: 0,
}

const toRad = (deg) => (deg * Math.PI) / 180
const toDeg = (rad) => (rad * 180) / Math.PI

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const scale = (a, f) => ({ x: a.x * f, y: a.y * f, z: a.z * f })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const norm = (a) => Math.sqrt(dot(a, a))
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

function unit(a, what) {
  const length = norm(a)
  if (!(length > 0)) throw new Error(`unit: cannot normalise a zero vector (${what})`)
  return scale(a, 1 / length)
}

/** Unsigned angle at b in the triangle a-b-c, degrees. Mirrors angles.ts `angleAt`. */
export function angleAt(a, b, c) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) }
  const v = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) }
  const lu = norm(u)
  const lv = norm(v)
  if (lu === 0 || lv === 0) return 180
  return toDeg(Math.acos(Math.min(1, Math.max(-1, dot(u, v) / (lu * lv)))))
}/**
 * Builds one 3D pose. Order matters: the arm fixes the shoulder, the shoulder and the
 * planted toe fix the body line, the body line fixes the hip (plus its fault offset),
 * and only then can the head and the elbows be hung off the result.
 */
export function buildPose(exemplar, overrides = {}) {
  const spec = { ...NEUTRAL_POSE, ...overrides }
  const { LIMB, WRIST_LIFT, Z_SHOULDER, Z_WRIST } = PROPORTIONS

  const reach = 2 * LIMB * Math.sin(toRad(spec.elbowDeg) / 2)
  const leanDeg = leanAt(exemplar.leanTable, spec.elbowDeg) + spec.leanBiasDeg
  const lateral = Z_WRIST - Z_SHOULDER

  // Height solved so the 3D shoulder->wrist distance is exactly `reach` despite the
  // lateral offset, which is what keeps the measured elbow angle equal to the request.
  const planar = Math.sqrt(Math.max(0, reach * reach - lateral * lateral))
  const height = Math.cos(toRad(leanDeg)) * planar
  const shoulder = { x: -height * Math.tan(toRad(leanDeg)), y: -WRIST_LIFT - height, z: 0 }

  const toe = { x: toeX(exemplar), y: 0, z: 0 }
  const chain = sub(toe, shoulder)
  const dir = unit(chain, 'shoulder->toe')
  const perp = { x: -dir.y, y: dir.x, z: 0 } // +y side of the body line, i.e. sag

  const onLine = (fraction) => add(shoulder, scale(chain, fraction))
  const hip = add(onLine(CHAIN_FRACTION.hip), scale(perp, spec.sagUnits))
  const knee = add(onLine(CHAIN_FRACTION.knee), scale(perp, spec.sagUnits * PROPORTIONS.KNEE_SAG_SHARE))
  const ankle = onLine(CHAIN_FRACTION.ankle)

  const head = buildHead(spec, shoulder, hip)
  const sides = { near: 1, far: -1 }
  const arms = Object.fromEntries(
    Object.entries(sides).map(([name, sign]) => [name, buildArm(spec, shoulder, hip, reach, sign)]),
  )

  const withZ = (point, z) => ({ ...point, z })
  return {
    spec,
    leanDeg,
    reach,
    joints: {
      shoulder: withZ(shoulder, PROPORTIONS.Z_SHOULDER),
      hip: withZ(hip, PROPORTIONS.Z_HIP),
      knee: withZ(knee, PROPORTIONS.Z_KNEE),
      ankle: withZ(ankle, PROPORTIONS.Z_ANKLE),
      toe: withZ(toe, PROPORTIONS.Z_ANKLE),
      ear: withZ(head.ear, PROPORTIONS.Z_EAR + head.tiltZ),
      headCentre: withZ(head.centre, head.tiltZ),
      wrist: { x: 0, y: -WRIST_LIFT, z: Z_WRIST },
      elbow: arms.near.elbow,
    },
    arms,
    head,
    perp,
    dir,
  }
}

/** Where the toe is planted: derived once from the nominal lockout, never hand-tuned. */
function toeX(exemplar) {
  const { LIMB, WRIST_LIFT, Z_SHOULDER, Z_WRIST } = PROPORTIONS
  const reach = 2 * LIMB * Math.sin(toRad(NOMINAL_LOCKOUT_DEG) / 2)
  const leanDeg = leanAt(exemplar.leanTable, NOMINAL_LOCKOUT_DEG)
  const lateral = Z_WRIST - Z_SHOULDER
  const planar = Math.sqrt(Math.max(0, reach * reach - lateral * lateral))
  const height = Math.cos(toRad(leanDeg)) * planar
  const shoulderX = -height * Math.tan(toRad(leanDeg))
  const shoulderY = WRIST_LIFT + height
  return shoulderX + Math.sqrt(Math.max(0, BODY_SPAN * BODY_SPAN - shoulderY * shoulderY))
}

/** Ear and head centre, hung off the torso frame, then craned / shrugged / tilted. */
function buildHead(spec, shoulder, hip) {
  const along = unit(sub(hip, shoulder), 'shoulder->hip')
  const perp = { x: -along.y, y: along.x, z: 0 }
  const base = add(scale(along, PROPORTIONS.EAR_ALONG), scale(perp, PROPORTIONS.EAR_PERP))

  // Crane rotates the ray toward +perp (the floor side), which is the direction that
  // drops the ear->shoulder->hip angle. Shrug shortens it: the head sinks into the
  // shoulders, which is what "shoulders ride up toward the ears" looks like.
  // NEGATED because the ray points at -along: rotating a mostly-backward vector by a
  // POSITIVE angle in this basis swings the head AWAY from the floor and the neck angle
  // goes UP, which is the opposite of craning.
  const angle = -toRad(spec.craneDeg)
  const rotated = {
    x: base.x * Math.cos(angle) - base.y * Math.sin(angle),
    y: base.x * Math.sin(angle) + base.y * Math.cos(angle),
    z: 0,
  }
  const ray = scale(rotated, 1 - spec.shrugUnits)
  const tiltZ = Math.sin(toRad(spec.headTiltDeg)) * PROPORTIONS.HEAD_RADIUS * 2
  return {
    ear: add(shoulder, ray),
    centre: add(shoulder, scale(ray, PROPORTIONS.HEAD_CENTRE_FACTOR)),
    tiltZ,
  }
}

/**
 * One arm. The elbow is the apex of an isosceles triangle on shoulder->wrist; WHERE on
 * that apex circle it sits is the roll. Both segments stay exactly LIMB long, so the
 * measured elbow angle is unaffected by the roll: flare and depth stay independent.
 */
function buildArm(spec, shoulder, hip, reach, sign) {
  const shoulderSide = { ...shoulder, z: PROPORTIONS.Z_SHOULDER * sign }
  const wristSide = { x: 0, y: -PROPORTIONS.WRIST_LIFT, z: PROPORTIONS.Z_WRIST * sign }
  const hipSide = { ...hip, z: PROPORTIONS.Z_HIP * sign }

  const axis = unit(sub(wristSide, shoulderSide), 'shoulder->wrist')
  const mid = scale(add(shoulderSide, wristSide), 0.5)
  const apex = Math.sqrt(Math.max(0, PROPORTIONS.LIMB ** 2 - (reach / 2) ** 2))

  const backward = { x: 1, y: 0, z: 0 }
  const e1 = unit(sub(backward, scale(axis, dot(backward, axis))), 'tuck basis')
  const e2raw = cross(axis, e1)
  const e2 = scale(unit(e2raw, 'flare basis'), Math.sign(e2raw.z * sign) || 1)

  const roll = toRad(spec.elbowRollDeg)
  const offset = add(scale(e1, Math.cos(roll)), scale(e2, Math.sin(roll)))
  const elbow = add(mid, scale(offset, apex))
  return {
    shoulder: shoulderSide,
    wrist: wristSide,
    elbow,
    rollDeg: spec.elbowRollDeg,
    flareDeg: angleAt(elbow, shoulderSide, hipSide),
  }
}

/**
 * The roll that makes the 3D abduction (elbow->shoulder->hip) read `flareDeg` at a given
 * depth. Bisected because the map has no closed form. Depth matters: at lockout the
 * range collapses to a point, so this is always called at the depth the flare is meant
 * to be read at — the bottom of the rep — and the roll is then held for the whole rep,
 * which is what a real athlete's shoulder does.
 */
export function rollForFlare(exemplar, overrides, flareDeg) {
  const flareAt = (rollDeg) => buildPose(exemplar, { ...overrides, elbowRollDeg: rollDeg }).arms.near.flareDeg
  let lo = FLARE_SOLVE.minRollDeg
  let hi = FLARE_SOLVE.maxRollDeg
  const atLo = flareAt(lo)
  const atHi = flareAt(hi)
  if (flareDeg < Math.min(atLo, atHi) || flareDeg > Math.max(atLo, atHi)) {
    throw new Error(
      `rollForFlare: ${flareDeg} deg of flare is unreachable at elbow ${overrides.elbowDeg} deg ` +
        `(range ${atLo.toFixed(1)}..${atHi.toFixed(1)}) — choose a target inside it rather than clamping silently`,
    )
  }
  const rising = atHi > atLo
  for (let i = 0; i < FLARE_SOLVE.iterations; i += 1) {
    const midRoll = (lo + hi) / 2
    if ((flareAt(midRoll) < flareDeg) === rising) lo = midRoll
    else hi = midRoll
  }
  return (lo + hi) / 2
}

/**
 * The joints of ONE side of the body. `sign` is +1 for the camera-near side, -1 for the
 * far one. The side view draws only the near side — a true side projection stacks the two
 * exactly, which is the occlusion `pickSide` in src/pose/landmarks.ts exists to resolve —
 * and the front view draws both.
 */
export function sidedJoints(pose, sign) {
  const arm = pose.arms[sign > 0 ? 'near' : 'far']
  const z = (name) => PROPORTIONS[name] * sign
  return {
    shoulder: arm.shoulder,
    elbow: arm.elbow,
    wrist: arm.wrist,
    hip: { ...pose.joints.hip, z: z('Z_HIP') },
    knee: { ...pose.joints.knee, z: z('Z_KNEE') },
    ankle: { ...pose.joints.ankle, z: z('Z_ANKLE') },
    toe: { ...pose.joints.toe, z: z('Z_ANKLE') },
  }
}

// ------------------------------------------------------------------- projection

/**
 * Orthographic projection to screen-space model units (y still downward).
 * 'side' is a pure side-on camera at floor level — z drops out entirely and only the near
 * limbs are drawn, exactly what a phone on the floor beside the athlete sees. 'front' yaws
 * toward head-on and pitches down, which is the only way an elbow that has swung sideways
 * is visible at all — see the FRONT VIEW ONLY note on `elbowFlare` in src/pose/angles.ts.
 */
export function project(point, view) {
  const camera = CAMERAS[view]
  if (!camera) throw new Error(`project: unknown view "${view}"`)
  const yaw = toRad(camera.yawDeg)
  const pitch = toRad(camera.pitchDeg)
  // Yaw about the vertical axis, then pitch about the screen-horizontal axis. `depth` is
  // distance INTO the screen; pitching the camera down lifts distant points up the frame,
  // and y grows downward, so depth is SUBTRACTED from the screen y.
  //
  // The SIGN of depth is load-bearing. At yaw 0 it must be -z, because +z is defined as the
  // camera-near side, and at yaw 90 it must be +x, which puts the camera in FRONT of the
  // head (the head is at -x) with the feet receding away. Negating it silently produces a
  // view from behind the FEET: the body then projects downhill and the figure reads as
  // someone lying on a ramp rather than as a pushup coming toward the lens.
  const depth = point.x * Math.sin(yaw) - point.z * Math.cos(yaw)
  return {
    x: point.x * Math.cos(yaw) + point.z * Math.sin(yaw),
    y: point.y * Math.cos(pitch) - depth * Math.sin(pitch),
  }
}

/**
 * Measures the projected figure with the same definitions src/pose/angles.ts uses, so a
 * clip can be checked against the angle it was asked to show. This is a MIRROR of that
 * file's elbowAngle / bodyLineAngle / neckAngle / elbowFlare / hipDeviation; it is
 * duplicated rather than imported because those are TypeScript and this is a plain node
 * script with no build step.
 */
export function measureProjected(pose, view) {
  const p = (point) => project(point, view)
  const arm = pose.arms.near
  const { shoulder, hip, ankle, ear, wrist } = pose.joints
  const [ps, ph, pa, pe, pw, pel] = [shoulder, hip, ankle, ear, wrist, arm.elbow].map(p)

  const bodyLine = angleAt(ps, ph, pa)
  const lineY = interpolateY(ps, pa, ph.x)
  const magnitude = 180 - bodyLine
  return {
    elbow: angleAt(ps, pel, pw),
    bodyLine,
    hipDeviation: lineY === null ? null : ph.y - lineY === 0 ? 0 : ph.y > lineY ? magnitude : -magnitude,
    neck: angleAt(pe, ps, ph),
    flare: Math.max(
      angleAt(p(pose.arms.near.elbow), p(pose.arms.near.shoulder), p({ ...hip, z: PROPORTIONS.Z_HIP })),
      angleAt(p(pose.arms.far.elbow), p(pose.arms.far.shoulder), p({ ...hip, z: -PROPORTIONS.Z_HIP })),
    ),
  }
}

/** Mirrors angles.ts `lineYAt`: y on the a->b line at x, or null if the span is degenerate. */
function interpolateY(a, b, x) {
  const span = b.x - a.x
  if (Math.abs(span) < 1e-6) return null
  return a.y + ((b.y - a.y) * (x - a.x)) / span
}
