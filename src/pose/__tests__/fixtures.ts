/**
 * Synthetic landmark sequences. Everything here is generated from geometry, never
 * recorded — a recorded clip would freeze one body at one camera height and would
 * stop being a regression test the moment the thresholds are recalibrated.
 *
 * The model is a side-view pushup with the hand planted and the feet fixed, so the
 * body rotates about the toes as the shoulder descends. Limb lengths are constant and
 * the shoulder height is DERIVED from the requested elbow angle, which is what makes
 * the sequences physically consistent rather than just numerically convenient:
 *
 *     |shoulder - wrist| = 2 * LIMB * sin(elbow / 2)
 *
 * So asking for an 85-degree elbow puts the shoulder exactly where an 85-degree elbow
 * would put it, and the angle functions measure back the number that was requested.
 */

import type { CameraView, CoachEvent } from '../../types/events'
import type { PoseAngles } from '../angles'
import { measureAngles } from '../angles'
import type { GateState } from '../faults'
import {
  canSpeak,
  createGateState,
  evaluateFaults,
  evaluateRepFaults,
  gate,
  noteUtterance,
  UTTERANCE_RANK,
} from '../faults'
import type { JointName, Landmark } from '../landmarks'
import { bodyLineInFrame, LANDMARK_COUNT, LEFT_JOINTS, NOSE, RIGHT_JOINTS, SIDE_JOINTS } from '../landmarks'
import type { ObservabilityState } from '../observability'
import { createObservabilityState, OBSERVABILITY, stepObservability } from '../observability'
import type { RepMachineState } from '../repMachine'
import { createRepMachineState, step } from '../repMachine'
import type { AngleWindows } from '../smoothing'
import { createAngleWindows, pushAngles, smoothedAngles } from '../smoothing'

export const FIXTURE_GEOMETRY = {
  /** Planted hand, normalized image coords. y grows downward. */
  wrist: { x: 0.4, y: 0.78 },
  /** Fixed feet. The body pivots here. */
  ankle: { x: 0.85, y: 0.62 },
  /** Upper arm and forearm, equal so the elbow is the apex of an isosceles triangle. */
  limb: 0.11,
  /** Where the hip sits along the shoulder->ankle line. */
  hipFraction: 0.44,
  kneeFraction: 0.78,
  /** Ear relative to the shoulder. Gives a neutral ~170-degree neck. */
  earOffset: { x: -0.07, y: -0.015 },
  /** Side view: the near limb tracks well, the far one is occluded and low-confidence. */
  nearVisibility: 0.95,
  farVisibility: 0.25,
} as const

/** 30fps. Frame spacing matters — the gate's cooldowns are in milliseconds. */
export const FRAME_INTERVAL_MS = 1000 / 30

export interface Frame {
  /** null models "no pose detected at all", which is what leaving the frame looks like. */
  landmarks: Landmark[] | null
  t: number
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, f: number) {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

function blankPose(): Landmark[] {
  return Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }))
}

function place(
  pose: Landmark[],
  joint: JointName,
  point: { x: number; y: number },
): void {
  // Both sides get the same coordinates (a true side view projects them together) but
  // different visibility, so pickSide has a real occlusion to resolve.
  pose[LEFT_JOINTS[joint]] = { ...point, z: 0, visibility: FIXTURE_GEOMETRY.nearVisibility }
  pose[RIGHT_JOINTS[joint]] = { ...point, z: 0, visibility: FIXTURE_GEOMETRY.farVisibility }
}

/**
 * One frame of a side-view pushup.
 *
 * @param elbowDeg  desired elbow angle; the shoulder height follows from it
 * @param sagOffset normalized units the hip is pushed BELOW the shoulder->ankle line.
 *                  Positive = sag, negative = pike. Matches `hipDeviation`'s sign.
 */
export function sideViewPose(elbowDeg: number, sagOffset = 0): Landmark[] {
  const { wrist, ankle, limb, hipFraction, kneeFraction, earOffset } = FIXTURE_GEOMETRY
  const half = (elbowDeg * Math.PI) / 360
  const reach = 2 * limb * Math.sin(half)
  const shoulder = { x: wrist.x, y: wrist.y - reach }

  // Elbow is the triangle's apex, displaced toward the feet. Direction is irrelevant
  // to the measured angle; only the perpendicular height matters.
  const apexHeight = Math.sqrt(Math.max(0, limb * limb - (reach / 2) * (reach / 2)))
  const elbow = { x: (shoulder.x + wrist.x) / 2 + apexHeight, y: (shoulder.y + wrist.y) / 2 }

  const onLine = lerp(shoulder, ankle, hipFraction)
  const hip = { x: onLine.x, y: onLine.y + sagOffset }
  const knee = lerp(shoulder, ankle, kneeFraction)
  const ear = { x: shoulder.x + earOffset.x, y: shoulder.y + earOffset.y }

  const pose = blankPose()
  place(pose, 'shoulder', shoulder)
  place(pose, 'elbow', elbow)
  place(pose, 'wrist', wrist)
  place(pose, 'hip', hip)
  place(pose, 'knee', knee)
  place(pose, 'ankle', ankle)
  place(pose, 'ear', ear)
  pose[NOSE] = { x: ear.x - 0.03, y: ear.y + 0.005, z: 0, visibility: FIXTURE_GEOMETRY.nearVisibility }
  return pose
}

/** Drop named joints to a given visibility on BOTH sides. Returns a new pose. */
export function occludeJoints(
  landmarks: readonly Landmark[],
  joints: readonly JointName[],
  visibility = 0,
): Landmark[] {
  const next = landmarks.map((lm) => ({ ...lm }))
  for (const joint of joints) {
    for (const side of ['left', 'right'] as const) {
      const index = SIDE_JOINTS[side][joint]
      const existing = next[index]
      if (existing) next[index] = { ...existing, visibility }
    }
  }
  return next
}

// ------------------------------------------------------------------- rep shapes

export interface RepShape {
  topDeg: number
  bottomDeg: number
  dwellTopFrames: number
  descentFrames: number
  dwellBottomFrames: number
  ascentFrames: number
}

/**
 * 22 frames per rep at 30fps = ~730ms, a brisk but human cadence. The dwells are 5
 * frames so a 5-wide median window can actually reach the extremes; shorter dwells
 * would let the filter clip the peaks and the machine would never cross a threshold.
 */
export const DEFAULT_REP_SHAPE: RepShape = {
  topDeg: 178,
  bottomDeg: 85,
  dwellTopFrames: 5,
  descentFrames: 6,
  dwellBottomFrames: 5,
  ascentFrames: 6,
}

function ramp(from: number, to: number, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => from + ((to - from) * (i + 1)) / steps)
}

/** The elbow-angle series for one rep: top dwell, descent, bottom dwell, ascent. */
export function repAngleSeries(shape: RepShape = DEFAULT_REP_SHAPE): number[] {
  return [
    ...Array.from({ length: shape.dwellTopFrames }, () => shape.topDeg),
    ...ramp(shape.topDeg, shape.bottomDeg, shape.descentFrames),
    ...Array.from({ length: shape.dwellBottomFrames }, () => shape.bottomDeg),
    ...ramp(shape.bottomDeg, shape.topDeg, shape.ascentFrames),
  ]
}

export interface SetOptions {
  reps: number
  shape?: RepShape
  /** Sag offset per rep index. Lets a set get progressively worse. */
  sagFor?: (repIndex: number) => number
  /**
   * Extra top-dwell frames appended after the last rep. Required: with median
   * smoothing the final rep does not cross the up threshold until a few frames into
   * the following top phase, so without a tail the last rep is never scored.
   */
  settleFrames?: number
  startAt?: number
}

export function buildSet(options: SetOptions): Frame[] {
  const shape = options.shape ?? DEFAULT_REP_SHAPE
  const settle = options.settleFrames ?? 8
  const startAt = options.startAt ?? 0

  const angles: { elbow: number; sag: number }[] = []
  for (let rep = 0; rep < options.reps; rep += 1) {
    const sag = options.sagFor?.(rep) ?? 0
    for (const elbow of repAngleSeries(shape)) angles.push({ elbow, sag })
  }
  const tailSag = options.sagFor?.(options.reps - 1) ?? 0
  for (let i = 0; i < settle; i += 1) angles.push({ elbow: shape.topDeg, sag: tailSag })

  return angles.map((a, i) => ({
    landmarks: sideViewPose(a.elbow, a.sag),
    t: startAt + i * FRAME_INTERVAL_MS,
  }))
}

// --------------------------------------------------------------- named fixtures

/** 10 textbook reps: full depth, straight body, neutral neck. */
export function cleanSet(reps = 10): Frame[] {
  return buildSet({ reps })
}

/**
 * 6 reps whose hips drop further each rep. Rep 1 is under the fault threshold, reps
 * 2-6 are over it, so the set has a genuine onset rather than being wrong from frame
 * zero. Every offset is POSITIVE = below the shoulder->ankle line = sag.
 */
export function saggingSet(reps = 6): Frame[] {
  return buildSet({ reps, sagFor: (i) => 0.02 + (0.04 * i) / Math.max(1, reps - 1) })
}

/** The mirror image, for the sign-convention test. Hips ABOVE the line = pike. */
export function pikingSet(reps = 6): Frame[] {
  return buildSet({ reps, sagFor: (i) => -(0.02 + (0.04 * i) / Math.max(1, reps - 1)) })
}

/**
 * 3 reps that bottom out at 98 degrees — past `downEnterDeg` (100) so they score, but
 * above `partialAboveDeg` (95) so they are flagged short.
 */
export function partialSet(reps = 3): Frame[] {
  return buildSet({ reps, shape: { ...DEFAULT_REP_SHAPE, bottomDeg: 98 } })
}

/**
 * Two clean reps, the user walks out of shot for 20 frames, then two more reps. The
 * gap is modelled as "no pose at all", which is what MediaPipe actually returns when
 * nobody is there.
 */
export function outOfFrameSet(gapFrames = 20): Frame[] {
  const before = buildSet({ reps: 2, settleFrames: 2 })
  const nextStart = before.length + gapFrames
  const after = buildSet({ reps: 2, startAt: nextStart * FRAME_INTERVAL_MS })
  const gap: Frame[] = Array.from({ length: gapFrames }, (_, i) => ({
    landmarks: null,
    t: (before.length + i) * FRAME_INTERVAL_MS,
  }))
  return [...before, ...gap, ...after]
}

/**
 * Reps filmed with the FEET OUT OF SHOT: shoulder, elbow and wrist tracked, hip tracked,
 * ankles at zero visibility. This is not a contrived edge case — it is what a phone propped
 * on the floor in portrait produces, and it is what the repo's one piece of real footage
 * looks like (ankle above the visibility gate on 45 frames out of 578).
 *
 * Every rep here must COUNT, and every rep here must report `hipDeviationDeg: null`.
 */
export function ankleLessSet(reps = 3, options: Omit<SetOptions, 'reps'> = {}): Frame[] {
  return buildSet({ ...options, reps }).map((frame) => ({
    ...frame,
    landmarks: frame.landmarks === null ? null : occludeJoints(frame.landmarks, ['ankle']),
  }))
}

/**
 * Reps that never straighten the arms: they top out at `softTopDeg`, below the OLD
 * `upEnterDeg` of 155 but above the shipped one. The long top dwell is deliberate — it is
 * what lets `no_lockout` clear its 18-of-24-frame persistence window, which is the whole
 * point of the fixture: the rep counts AND the coach says "lock it out".
 */
export const SOFT_TOP = { softTopDeg: 130, dwellTopFrames: 30 } as const

export function softTopSet(reps = 2): Frame[] {
  return buildSet({
    reps,
    shape: {
      ...DEFAULT_REP_SHAPE,
      topDeg: SOFT_TOP.softTopDeg,
      dwellTopFrames: SOFT_TOP.dwellTopFrames,
    },
    settleFrames: SOFT_TOP.dwellTopFrames,
  })
}

/** A static sagging plank. For proving the gate does not narrate every frame. */
export function heldSagFrames(count = 100, sagOffset = 0.05): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    landmarks: sideViewPose(DEFAULT_REP_SHAPE.topDeg, sagOffset),
    t: i * FRAME_INTERVAL_MS,
  }))
}

// ------------------------------------------------------------------- the harness

export interface PipelineOptions {
  view?: CameraView
  /** Median filter on by default, matching the engine. Off isolates the rep machine. */
  smooth?: boolean
}

export interface PipelineRun {
  /** `rep_completed`, `form_fault` and the observability pair, in emission order. */
  events: CoachEvent[]
  reps: RepMachineState
  gate: GateState
  observability: ObservabilityState
  /** Frames dropped because they were not countable. */
  skipped: number
  /** Frames whose body line was measurable. */
  bodyLineFrames: number
  /** Last smoothed angles, for spot checks. */
  lastAngles: PoseAngles | null
}

/**
 * Runs the pure half of the engine over a frame sequence.
 *
 * Mirrors `poseEngine.processFrame` deliberately: unit tests on each module would
 * still pass if the modules were wired together in the wrong order, and the wiring is
 * where the interesting bugs are. Framing events are NOT reproduced here — those are
 * debounce bookkeeping tested directly against `inFrame`.
 *
 * KEEP IN STEP with `poseEngine.processFrame` when either changes.
 */
export function runPipeline(frames: readonly Frame[], options: PipelineOptions = {}): PipelineRun {
  const view: CameraView = options.view ?? 'side'
  const smooth = options.smooth ?? true

  let reps: RepMachineState = createRepMachineState()
  let windows: AngleWindows = createAngleWindows()
  let gateState: GateState = createGateState()
  let observability: ObservabilityState = createObservabilityState()
  const events: CoachEvent[] = []
  let skipped = 0
  let bodyLineFrames = 0
  let lastAngles: PoseAngles | null = null

  for (const frame of frames) {
    const raw = measureAngles(frame.landmarks)
    if (!raw) {
      skipped += 1
      continue
    }
    windows = pushAngles(windows, raw)
    const angles = smooth ? smoothedAngles(windows, raw) : raw
    if (!angles) {
      skipped += 1
      continue
    }
    lastAngles = angles
    if (angles.hipDeviation !== null) bodyLineFrames += 1

    const repResult = step(reps, { angles, t: frame.t })
    reps = repResult.state
    if (repResult.events.length > 0) {
      gateState = noteUtterance(gateState, frame.t, UTTERANCE_RANK.routine)
      events.push(...repResult.events)

      const repFaults = gate(gateState, {
        candidates: evaluateRepFaults(reps.lastRep!, view),
        t: frame.t,
        mode: 'immediate',
      })
      gateState = repFaults.state
      events.push(...repFaults.events)
    }

    const frameFaults = gate(gateState, {
      candidates: evaluateFaults({
        angles,
        phase: reps.phase,
        view,
        inFrame: true,
        topElbow: reps.topMaxElbow,
      }),
      t: frame.t,
      mode: 'frame',
    })
    gateState = frameFaults.state
    events.push(...frameFaults.events)

    // Same order and same shared utterance bucket as `poseEngine.processFrame`.
    const observed = stepObservability(observability, {
      measurable: angles.hipDeviation !== null,
      missing: bodyLineInFrame(frame.landmarks).missing,
      t: frame.t,
      canSpeak: canSpeak(gateState, frame.t, OBSERVABILITY.rank),
    })
    observability = observed.state
    if (observed.events.length > 0) {
      gateState = noteUtterance(gateState, frame.t, OBSERVABILITY.rank)
      events.push(...observed.events)
    }
  }

  return { events, reps, gate: gateState, observability, skipped, bodyLineFrames, lastAngles }
}

// ------------------------------------------------------------------ assertions aid

export function eventsOfKind<K extends CoachEvent['kind']>(
  events: readonly CoachEvent[],
  kind: K,
): Extract<CoachEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<CoachEvent, { kind: K }> => e.kind === kind)
}

export function faultTypes(events: readonly CoachEvent[]): string[] {
  return eventsOfKind(events, 'form_fault').map((e) => e.fault)
}
