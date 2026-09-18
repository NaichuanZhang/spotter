/**
 * Pushup geometry. Pure functions over landmarks — no state, no time, no DOM.
 *
 * All measurement is 2D on the (x, y) image plane. BlazePose's `z` is relative to
 * the hip centre and is an order of magnitude noisier than x/y; for a horizontal
 * body it is close to useless, and folding it in would add jitter to every angle
 * without adding information.
 *
 * REMEMBER: y grows DOWNWARD (image origin is top-left). The signed hip deviation
 * below depends on that and is the single easiest thing in this codebase to invert.
 *
 * TUNABLES LIVE IN: `GEOMETRY` (this file).
 */

import type { Landmark, Point2, Side, SideJoints } from './landmarks'
import { pickSide, SIDE_JOINTS, VISIBILITY, visibilityOf } from './landmarks'

export const GEOMETRY = {
  /**
   * Returned by `angleAt` when two of the three points coincide, so the angle is
   * undefined. 180 ("perfectly straight") is the deliberately SAFE answer: a
   * straight elbow keeps the rep machine at the top instead of inventing a rep,
   * and a straight body line raises no fault. Never a measurement — a refusal.
   */
  degenerateAngleDeg: 180,
  /** Vector magnitude below this counts as a coincident point. Normalized units. */
  coincidentEps: 1e-6,
  /**
   * Minimum shoulder->ankle horizontal span, as a fraction of frame width, before
   * the body-line interpolation is trusted. Below this the body is vertical in
   * frame (standing, or camera rotated) and this is not a pushup view.
   */
  minBodySpanX: 0.08,
} as const

const RAD_TO_DEG = 180 / Math.PI

// -------------------------------------------------------------- core trigonometry

/**
 * Interior angle at vertex `b` of the path a -> b -> c, in degrees, range [0, 180].
 *
 * The acos domain is clamped: floating point on normalized coordinates routinely
 * produces cos values like 1.0000000000000002, and un-clamped `Math.acos` returns
 * NaN for those. A NaN here poisons the rep machine silently, so it is clamped
 * rather than trusted.
 */
export function angleAt(a: Point2, b: Point2, c: Point2): number {
  const bax = a.x - b.x
  const bay = a.y - b.y
  const bcx = c.x - b.x
  const bcy = c.y - b.y

  const magBA = Math.hypot(bax, bay)
  const magBC = Math.hypot(bcx, bcy)
  if (magBA < GEOMETRY.coincidentEps || magBC < GEOMETRY.coincidentEps) {
    return GEOMETRY.degenerateAngleDeg
  }

  const cos = (bax * bcx + bay * bcy) / (magBA * magBC)
  const clamped = cos > 1 ? 1 : cos < -1 ? -1 : cos
  return Math.acos(clamped) * RAD_TO_DEG
}

/**
 * y of the point on segment a->b at horizontal position `x` (extrapolating past the
 * ends is allowed and correct — the caller only needs which side of the line we are
 * on). Returns null when the segment is too vertical for x-interpolation to mean
 * anything.
 */
export function lineYAt(a: Point2, b: Point2, x: number): number | null {
  const span = b.x - a.x
  if (Math.abs(span) < GEOMETRY.minBodySpanX) return null
  const t = (x - a.x) / span
  return a.y + t * (b.y - a.y)
}

// --------------------------------------------------------------- joint resolution

function jointsFor(
  landmarks: readonly Landmark[] | null | undefined,
  side: Side | undefined,
  involved: readonly (keyof SideJoints)[],
): SideJoints | null {
  if (side) return SIDE_JOINTS[side]
  return pickSide(landmarks, involved)?.joints ?? null
}

function at(landmarks: readonly Landmark[], index: number): Landmark | null {
  const lm = landmarks[index]
  if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return null
  return lm
}

/** Resolve three indices to points, or null if any is absent/non-finite. */
function triple(
  landmarks: readonly Landmark[] | null | undefined,
  joints: SideJoints | null,
  names: readonly [keyof SideJoints, keyof SideJoints, keyof SideJoints],
): [Landmark, Landmark, Landmark] | null {
  if (!joints || !landmarks) return null
  const a = at(landmarks, joints[names[0]])
  const b = at(landmarks, joints[names[1]])
  const c = at(landmarks, joints[names[2]])
  if (!a || !b || !c) return null
  return [a, b, c]
}

// ------------------------------------------------------------------ pushup angles

/**
 * Elbow flexion: shoulder -> elbow -> wrist. ~180 locked out, ~90 at parallel,
 * lower is deeper. This is the signal the rep machine runs on.
 */
export function elbowAngle(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const joints = jointsFor(landmarks, side, ['shoulder', 'elbow', 'wrist'])
  const pts = triple(landmarks, joints, ['shoulder', 'elbow', 'wrist'])
  return pts ? angleAt(pts[0], pts[1], pts[2]) : null
}

/**
 * Body line: shoulder -> hip -> ankle. 180 is a straight plank. UNSIGNED — a sag
 * and a pike of equal size give the identical number here, which is exactly why
 * `hipDeviation` exists. Never branch a fault on this value alone.
 */
export function bodyLineAngle(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const joints = jointsFor(landmarks, side, ['shoulder', 'hip', 'ankle'])
  const pts = triple(landmarks, joints, ['shoulder', 'hip', 'ankle'])
  return pts ? angleAt(pts[0], pts[1], pts[2]) : null
}

/**
 * Neck: ear -> shoulder -> hip. ~180 is neutral (head in line with the spine);
 * lower means the chin is dropped or craned forward.
 */
export function neckAngle(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const joints = jointsFor(landmarks, side, ['ear', 'shoulder', 'hip'])
  const pts = triple(landmarks, joints, ['ear', 'shoulder', 'hip'])
  return pts ? angleAt(pts[0], pts[1], pts[2]) : null
}

/**
 * Elbow abduction away from the torso: elbow -> shoulder -> hip. ~45 is a tucked,
 * shoulder-safe pushup; approaching 90 is a fully flared T-shape.
 *
 * FRONT VIEW ONLY (see FAULT_VIEW_RELIABILITY). From the side this angle is a
 * projection artefact and reads ~90 even on a perfectly tucked pushup, which is
 * precisely why the fault gate suppresses `flared_elbows` outside the front view.
 *
 * With no explicit side it returns the WORST (largest) of the two arms rather than
 * using `pickSide`: in a front view both arms are equally visible, so pickSide
 * would choose between them on visibility noise and report a random arm.
 */
export function elbowFlare(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const names = ['elbow', 'shoulder', 'hip'] as const
  if (side) {
    const pts = triple(landmarks, SIDE_JOINTS[side], names)
    return pts ? angleAt(pts[0], pts[1], pts[2]) : null
  }
  if (!landmarks) return null

  const perSide = (['left', 'right'] as const)
    .filter((s) => names.every((n) => visibilityOf(landmarks, SIDE_JOINTS[s][n]) >= VISIBILITY.joint))
    .map((s) => {
      const pts = triple(landmarks, SIDE_JOINTS[s], names)
      return pts ? angleAt(pts[0], pts[1], pts[2]) : null
    })
    .filter((v): v is number => v !== null)

  if (perSide.length > 0) return Math.max(...perSide)
  // Neither arm clears the visibility gate on its own: fall back to a single side.
  const joints = jointsFor(landmarks, undefined, names)
  const pts = triple(landmarks, joints, names)
  return pts ? angleAt(pts[0], pts[1], pts[2]) : null
}

/**
 * SIGNED hip deviation from a straight plank, in degrees.
 *
 *   POSITIVE = hips SAGGING  (hip is BELOW the shoulder->ankle line)
 *   NEGATIVE = hips PIKED    (hip is ABOVE the line)
 *   0        = straight, or not measurable
 *
 * How the sign is obtained, and why it cannot come from an angle: `bodyLineAngle`
 * is the unsigned corner at the hip, so a 20-degree sag and a 20-degree pike are
 * both "160". The sign therefore comes from position, not angle — we interpolate y
 * along the shoulder->ankle line at the hip's own x, and compare the real hip.y
 * against it. Screen y grows DOWNWARD, so a hip that has dropped below the line has
 * the LARGER y, hence `hip.y - lineY > 0` means sag.
 *
 * Magnitude is `180 - bodyLineAngle`, so the number stays consistent with the
 * unsigned angle and is in real degrees.
 *
 * Facing direction is irrelevant: mirroring the body in x flips the interpolation's
 * `t` and the span together, and y-down is absolute. Sag reads positive whether the
 * user's feet are camera-left or camera-right.
 */
export function hipDeviation(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const joints = jointsFor(landmarks, side, ['shoulder', 'hip', 'ankle'])
  const pts = triple(landmarks, joints, ['shoulder', 'hip', 'ankle'])
  if (!pts) return null
  const [shoulder, hip, ankle] = pts

  const lineY = lineYAt(shoulder, ankle, hip.x)
  if (lineY === null) return null

  const magnitude = 180 - angleAt(shoulder, hip, ankle)
  const dy = hip.y - lineY
  if (dy === 0) return 0
  return dy > 0 ? magnitude : -magnitude
}

// -------------------------------------------------------------- per-frame bundle

/**
 * Every angle for one frame, measured on ONE side so they are mutually consistent.
 * `neck` and `flare` are nullable because losing an ear or an occluded far arm must
 * not throw away a frame that can still count reps.
 */
export interface PoseAngles {
  side: Side
  /** Degrees. Drives the rep machine. */
  elbow: number
  /** Degrees, unsigned. 180 = straight plank. */
  bodyLine: number
  /** Degrees, SIGNED. Positive = sag, negative = pike. See `hipDeviation`. */
  hipDeviation: number
  neck: number | null
  flare: number | null
}

/**
 * The single entry point the engine uses. Returns null when the frame is not
 * measurable — no pose, occluded core joints, or a non-pushup camera geometry.
 * A null frame must be SKIPPED, never coerced to zeros: zeros look like a perfect
 * rep at full depth and would fabricate reps out of an empty room.
 */
export function measureAngles(landmarks: readonly Landmark[] | null | undefined): PoseAngles | null {
  const pick = pickSide(landmarks, ['shoulder', 'elbow', 'wrist', 'hip', 'ankle'])
  if (!pick) return null

  const elbow = elbowAngle(landmarks, pick.side)
  const bodyLine = bodyLineAngle(landmarks, pick.side)
  const deviation = hipDeviation(landmarks, pick.side)
  if (elbow === null || bodyLine === null || deviation === null) return null

  return {
    side: pick.side,
    elbow,
    bodyLine,
    hipDeviation: deviation,
    neck: neckAngle(landmarks, pick.side),
    // Deliberately un-sided: worst of both arms. See `elbowFlare`.
    flare: elbowFlare(landmarks),
  }
}
