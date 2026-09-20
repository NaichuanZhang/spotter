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
 *
 * ── CONTRACT AMENDMENT LOG ──────────────────────────────────────────────────
 * `PoseAngles` is consumed by the rep machine, the fault gate, the smoother and the
 * engine, so its shape is contract even though it does not live in src/types. It is
 * changed by deliberate amendment, recorded here.
 *
 * 1. `bodyLine` and `hipDeviation` became NULLABLE, and `measureAngles` stopped
 *    requiring an ankle (ankle-decoupling pass). MEASURABILITY IS NOT VALIDITY:
 *
 *      - counting a rep needs shoulder + elbow + wrist,
 *      - judging the body line ADDITIONALLY needs hip + ankle.
 *
 *    Before this, `measureAngles` demanded all five through one `pickSide` call and
 *    returned null for the WHOLE frame when the ankle was missing, so a phone propped
 *    on the floor or a laptop close to the user — both of which crop the feet — turned
 *    the entire product off. Measured on `public/clips/landmarks.json` (578 frames of
 *    real pushups through this repo's own detector): shoulder, elbow and hip were
 *    visible on 594/594 detections and the wrist on 592, while the ANKLE cleared the
 *    0.5 visibility gate on 45 and had a median visibility of 0.14, with x reaching
 *    1.27 — a joint the detector placed outside the frame.
 *
 *    The second half of the amendment matters more than the first. `hipDeviation`
 *    gated on finiteness and horizontal span but never on ankle VISIBILITY, so it
 *    extrapolated the shoulder->ankle line to that invented ankle and reported a body
 *    line anyway: replaying the clip produced a SEVERE `piked_hips` at 68.3 degrees,
 *    which no spine can do. A guessed ankle does not produce a missing fault, it
 *    produces an INVENTED one, and the coach criticises form it cannot see. So the
 *    honest answer is null, and null is now representable.
 *
 *    Callers must treat null as UNKNOWN, never as 0: zero degrees of deviation means
 *    "straight back", which is a claim. `repMachine` tracks body-line measurability
 *    explicitly for this reason, and `toEventLine` makes no hip claim without it.
 *
 * 2. `elbowFlare` STOPPED FALLING BACK to a low-confidence side, so `PoseAngles.flare` is now
 *    null when neither arm has elbow + shoulder + hip genuinely visible (end-to-end
 *    verification pass).
 *
 *    Amendment 1 gated the body line and the neck on visibility but left `elbowFlare`'s
 *    fall-back in place, and that fall-back resolved its side through `pickSide`, which scores
 *    on a MEAN — so an invisible hip beside a well-tracked elbow and shoulder still produced a
 *    side, and `triple` then happily read the coordinate MediaPipe had invented for the hip.
 *    Measured: with the hip at zero visibility, `elbowFlare` returned the same 81.41 degrees as
 *    with the hip visible, and `evaluateFaults` in the front view rated that
 *    `flared_elbows SEVERE`. The same invented-joint-invents-a-fault failure as the 68-degree
 *    "pike", one limb over, and the front view is exactly where it bites: a camera in front of
 *    the user has the torso between it and the hips.
 *
 * 3. `PoseAngles` gained no field here, but `smoothing.smoothedAngles` now gates `neck` and
 *    `flare` on the RAW frame the way it already gated the body line, which is what makes
 *    their nullability mean anything downstream. Recorded here because it is what the shape
 *    above promises: reading the median window alone republished a dead angle forever
 *    (measured: `craned_neck` proposed on 70 frames out of 70 after the ear left the shot).
 */

import type { JointName, Landmark, Point2, Side, SideJoints } from './landmarks'
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

/**
 * WHICH JOINTS EACH MEASUREMENT NEEDS. The split is the whole point: a frame can be
 * perfectly countable and still say nothing about the body line.
 */
export const MEASURABILITY = {
  /** Without these there is no elbow angle, so there is no rep to count. */
  counting: ['shoulder', 'elbow', 'wrist'] as const satisfies readonly JointName[],
  /**
   * Every joint the body line reads, checked against `VISIBILITY.joint` on the MEASURED
   * side — not merely for finiteness: MediaPipe hands back a confident-looking coordinate
   * for a foot that is off frame, and an extrapolation through it invents sag.
   *
   * The shoulder appears here as well as in `counting` on purpose. `pickSide` clears a side
   * on the MEAN visibility of the counting joints, so a well-tracked elbow and wrist can
   * carry a barely-seen shoulder — fine for an elbow angle whose vertex is the elbow,
   * not fine for a line anchored at the shoulder.
   */
  bodyLine: ['shoulder', 'hip', 'ankle'] as const satisfies readonly JointName[],
  /**
   * The neck angle is ear -> shoulder -> hip, so it needs the ear AND the hip. Same hazard
   * as the body line, one joint further up: an invented hip produces an invented
   * `craned_neck`, and the coach criticises a head position it cannot see.
   */
  neck: ['ear', 'shoulder', 'hip'] as const satisfies readonly JointName[],
  /**
   * Elbow abduction is elbow -> shoulder -> hip, so it needs the hip too — and it is the
   * measurement most likely to be asked for when the hip is NOT there, because it is the
   * front-view fault and a front view puts the torso between the camera and the hips.
   *
   * MEASURED: before this was enforced, dropping the hip to zero visibility left
   * `elbowFlare` returning the identical 81.41 degrees it returned with the hip visible, and
   * `evaluateFaults` in the front view turned that into `flared_elbows SEVERE`. Exactly the
   * fabricated-ankle bug one limb over.
   */
  flare: ['elbow', 'shoulder', 'hip'] as const satisfies readonly JointName[],
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
 *
 * NULL when NEITHER arm has elbow + shoulder + hip genuinely visible. There is deliberately
 * no fall-back to a low-confidence side: this angle is anchored at the hip, and the fall-back
 * that used to be here measured the flare against a hip the detector had invented (see
 * `MEASURABILITY.flare`). An explicit `side` still bypasses the gate, because the caller has
 * then asserted which limb it wants measured.
 */
export function elbowFlare(
  landmarks: readonly Landmark[] | null | undefined,
  side?: Side,
): number | null {
  const names = MEASURABILITY.flare
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

  return perSide.length > 0 ? Math.max(...perSide) : null
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
 *
 * ONLY `side` AND `elbow` ARE GUARANTEED. Everything else is nullable, because losing a
 * joint must cost exactly the measurements that joint carried and nothing more: a frame
 * with no ankle can still count a rep, a frame with no ear can still judge the body line.
 * See the amendment log at the top of this file for what a non-null body line is worth
 * and why a fabricated one is worse than none.
 */
export interface PoseAngles {
  side: Side
  /** Degrees. Drives the rep machine. */
  elbow: number
  /**
   * Degrees, unsigned. 180 = straight plank. NULL when hip + ankle were not both visible
   * on the measured side, i.e. the body line was never seen. Never a stand-in value.
   */
  bodyLine: number | null
  /**
   * Degrees, SIGNED. Positive = sag, negative = pike. See `hipDeviation`. NULL when
   * unmeasurable — and 0 is a MEASUREMENT (a straight back), so the two must not be
   * conflated anywhere downstream.
   */
  hipDeviation: number | null
  /**
   * Degrees. Ear -> shoulder -> hip, ~180 neutral. NULL when the ear or the hip was not
   * visible on the measured side.
   */
  neck: number | null
  /**
   * Degrees. Elbow abduction, worst of the two arms. NULL when NEITHER arm had elbow +
   * shoulder + hip visible — never measured off an invented hip. See amendment 2.
   */
  flare: number | null
}

/**
 * Whether every named joint is genuinely visible on ONE side.
 *
 * The other side is deliberately NOT substituted for a missing joint. In a true side view
 * the two project close together, but mixing a right ankle into a left-side chain measures
 * a body that is not there — the same reason `pickSide` refuses to average the two sides.
 */
export function jointsVisible(
  landmarks: readonly Landmark[] | null | undefined,
  side: Side,
  names: readonly (keyof SideJoints)[],
): boolean {
  if (!landmarks) return false
  const joints = SIDE_JOINTS[side]
  return names.every((name) => visibilityOf(landmarks, joints[name]) >= VISIBILITY.joint)
}

/** The body line is honest only when shoulder, hip and ankle are all really there. */
export function bodyLineVisible(
  landmarks: readonly Landmark[] | null | undefined,
  side: Side,
): boolean {
  return jointsVisible(landmarks, side, MEASURABILITY.bodyLine)
}

/**
 * The single entry point the engine uses. Returns null only when the frame cannot be
 * COUNTED — no pose, or shoulder/elbow/wrist not tracked well enough to give an elbow
 * angle. A null frame must be SKIPPED, never coerced to zeros: zeros look like a perfect
 * rep at full depth and would fabricate reps out of an empty room.
 *
 * A frame that is countable but whose feet are out of shot comes back with `bodyLine` and
 * `hipDeviation` NULL. That is the honest answer and it is a different thing from a null
 * frame: the rep still counts, the back is simply not on camera. `bodyLine` is nulled
 * together with `hipDeviation` because an unsigned corner angle with no side to it cannot
 * tell a sag from a pike (that is the entire reason `hipDeviation` exists), so publishing
 * one without the other would only invite a caller to branch on it.
 */
export function measureAngles(landmarks: readonly Landmark[] | null | undefined): PoseAngles | null {
  const pick = pickSide(landmarks, MEASURABILITY.counting)
  if (!pick) return null

  const elbow = elbowAngle(landmarks, pick.side)
  if (elbow === null) return null

  const deviation = bodyLineVisible(landmarks, pick.side) ? hipDeviation(landmarks, pick.side) : null

  return {
    side: pick.side,
    elbow,
    bodyLine: deviation === null ? null : bodyLineAngle(landmarks, pick.side),
    hipDeviation: deviation,
    // Gated for the same reason as the body line: the neck angle is anchored at the hip.
    neck: jointsVisible(landmarks, pick.side, MEASURABILITY.neck)
      ? neckAngle(landmarks, pick.side)
      : null,
    // Deliberately un-sided: worst of both arms. See `elbowFlare`, which does its own
    // per-side visibility filtering.
    flare: elbowFlare(landmarks),
  }
}
