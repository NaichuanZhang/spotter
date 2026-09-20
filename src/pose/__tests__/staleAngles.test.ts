/**
 * NO ANGLE MAY OUTLIVE THE JOINT THAT PRODUCED IT.
 *
 * `bodyLine.test.ts` covers the body line. This file covers the three other ways the same
 * mistake was still reachable after that pass, each of which was MEASURED on this repo before
 * being fixed. All four are one failure mode: the coach stating a number about a part of the
 * body the camera cannot see.
 *
 *   1. `smoothedAngles` read `neck` and `flare` straight off their median windows. A window
 *      that still holds samples returns a median forever, so the smoothed neck survived the ear
 *      leaving the shot indefinitely — 70 frames out of 70, proposing `craned_neck` every one.
 *   2. `elbowFlare` fell back to `pickSide` when neither arm cleared the visibility gate, and
 *      `pickSide` scores on a MEAN — so an invisible hip beside a tracked elbow and shoulder
 *      still yielded a "measurement". With the hip at zero visibility the flare came back as the
 *      identical 81.41 degrees it read with the hip visible, and the front view rated that
 *      `flared_elbows SEVERE`.
 *   3. `no_lockout` was scored on the INSTANTANEOUS elbow. `phase` stays `top` all the way down
 *      to `downEnterDeg`, so the descent sweeps ~50 degrees of the lockout band and the gate
 *      reported whichever frame it happened to fire on: the real footage's 127-degree top was
 *      announced as `no_lockout 102deg SEVERE`, a number the demonstrator was never at.
 *   4. `form_unobservable` is debounced by FRAME COUNT, so its first mention rendered
 *      "cannot see ankle for 0s" — a sentence that denies itself, pushed to a model that quotes
 *      these lines back.
 */

import { describe, expect, it } from 'vitest'
import type { CoachEvent } from '../../types/events'
import { EVENT_LINE, toEventLine } from '../../types/events'
import type { PoseAngles } from '../angles'
import { elbowFlare, MEASURABILITY, measureAngles } from '../angles'
import { evaluateFaults, FAULT_THRESHOLDS } from '../faults'
import { LEFT_EAR, LEFT_SHOULDER, RIGHT_EAR } from '../landmarks'
import { REP_THRESHOLDS } from '../repMachine'
import { createAngleWindows, pushAngles, smoothedAngles, SMOOTHING } from '../smoothing'
import {
  ankleLessSet,
  DEFAULT_REP_SHAPE,
  eventsOfKind,
  FRAME_INTERVAL_MS,
  occludeJoints,
  runPipeline,
  sideViewPose,
} from './fixtures'
import { OBSERVABILITY } from '../observability'
import { loadRealMotion, segmentedFrames } from './realMotion'

/** Long enough that a stale window would have been refilled many times over. */
const LONG_RUN_FRAMES = SMOOTHING.windowSize * 14

/** How far the ear is displaced from the shoulder to close the neck angle past the threshold. */
const CRANE_OFFSET = { x: 0.02, y: -0.06 } as const

/** Ear pulled forward of and above the shoulder, closing ear -> shoulder -> hip well past 150. */
function cranedNeckPose(): ReturnType<typeof sideViewPose> {
  const pose = sideViewPose(DEFAULT_REP_SHAPE.topDeg).map((lm) => ({ ...lm }))
  const shoulder = pose[LEFT_SHOULDER]!
  for (const ear of [LEFT_EAR, RIGHT_EAR]) {
    pose[ear] = { ...pose[ear]!, x: shoulder.x + CRANE_OFFSET.x, y: shoulder.y + CRANE_OFFSET.y }
  }
  return pose
}

/** Replay a pose sequence through the real smoother, returning every smoothed frame. */
function smoothAll(poses: readonly ReturnType<typeof sideViewPose>[]): PoseAngles[] {
  let windows = createAngleWindows()
  const out: PoseAngles[] = []
  for (const pose of poses) {
    const raw = measureAngles(pose)
    if (!raw) continue
    windows = pushAngles(windows, raw)
    const smoothed = smoothedAngles(windows, raw)
    if (smoothed) out.push(smoothed)
  }
  return out
}

describe('the smoother does not republish a dead angle', () => {
  it('nulls the neck once the ear leaves, instead of holding the last median forever', () => {
    const visible = Array.from({ length: SMOOTHING.windowSize * 2 }, () => cranedNeckPose())
    const gone = Array.from({ length: LONG_RUN_FRAMES }, () => occludeJoints(cranedNeckPose(), ['ear']))
    const frames = smoothAll([...visible, ...gone])

    // While the ear is there the angle is real and craned.
    const last = frames[visible.length - 1]!
    expect(last.neck).not.toBeNull()
    expect(last.neck!).toBeLessThanOrEqual(FAULT_THRESHOLDS.neckMinDeg)

    // The moment it goes, and for every frame after — not just until the window drains.
    for (const frame of frames.slice(visible.length)) expect(frame.neck).toBeNull()
  })

  it('stops proposing craned_neck the frame the ear goes, not 70 frames later', () => {
    const visible = Array.from({ length: SMOOTHING.windowSize * 2 }, () => cranedNeckPose())
    const gone = Array.from({ length: LONG_RUN_FRAMES }, () => occludeJoints(cranedNeckPose(), ['ear']))
    const frames = smoothAll([...visible, ...gone])
    const proposes = (angles: PoseAngles) =>
      evaluateFaults({ angles, phase: 'top', view: 'side', inFrame: true }).some((c) => c.fault === 'craned_neck')

    expect(proposes(frames[visible.length - 1]!)).toBe(true)
    const after = frames.slice(visible.length)
    expect(after.filter(proposes)).toHaveLength(0)
  })

  it('nulls the flare once the hip leaves, for the same reason', () => {
    const visible = Array.from({ length: SMOOTHING.windowSize * 2 }, () => sideViewPose(DEFAULT_REP_SHAPE.topDeg))
    const gone = Array.from({ length: LONG_RUN_FRAMES }, () =>
      occludeJoints(sideViewPose(DEFAULT_REP_SHAPE.topDeg), ['hip']),
    )
    const frames = smoothAll([...visible, ...gone])

    expect(frames[visible.length - 1]!.flare).not.toBeNull()
    for (const frame of frames.slice(visible.length)) expect(frame.flare).toBeNull()
  })
})

describe('the flare is never measured against an invented hip', () => {
  const pose = sideViewPose(DEFAULT_REP_SHAPE.topDeg)

  it('refuses rather than falling back to a low-confidence side', () => {
    expect(elbowFlare(pose)).not.toBeNull()
    // The hip is still POSITIONED here — MediaPipe always hands back a coordinate. Only its
    // visibility is gone, which is the whole difference between a measurement and a guess.
    expect(elbowFlare(occludeJoints(pose, ['hip']))).toBeNull()
  })

  it('loses exactly the angles the hip carried and nothing more', () => {
    const angles = measureAngles(occludeJoints(pose, ['hip']))
    expect(angles).not.toBeNull()
    // Still countable: the arm chain never needed a hip.
    expect(angles!.elbow).toBeGreaterThan(0)
    for (const dead of [angles!.flare, angles!.neck, angles!.bodyLine, angles!.hipDeviation]) {
      expect(dead).toBeNull()
    }
  })

  it('proposes no flared_elbows in the front view, where it used to read SEVERE', () => {
    const angles = measureAngles(occludeJoints(pose, ['hip']))!
    const faults = evaluateFaults({ angles, phase: 'top', view: 'front', inFrame: true }).map((c) => c.fault)
    expect(faults).not.toContain('flared_elbows')
  })

  it('names the joints it needs, so the gate and the measurement cannot drift apart', () => {
    expect(MEASURABILITY.flare).toEqual(['elbow', 'shoulder', 'hip'])
  })
})

describe('no_lockout is scored on the top of the rep, not on the way down', () => {
  const straight: PoseAngles = { side: 'left', elbow: 178, bodyLine: 180, hipDeviation: 0, neck: 175, flare: 20 }
  const lockout = (elbow: number, topElbow?: number | null) =>
    evaluateFaults({ angles: { ...straight, elbow }, phase: 'top', view: 'side', inFrame: true, topElbow }).find(
      (c) => c.fault === 'no_lockout',
    )

  it('proposes nothing at all while descending from a genuine lockout', () => {
    // Elbow deep inside the band, but the top of this phase was a full extension.
    expect(lockout(120, 178)).toBeUndefined()
    expect(lockout(101, 178)).toBeUndefined()
  })

  it('reports the top angle and its severity, not the descent frame it fired on', () => {
    // The real-footage case: a 127-degree top, sampled at 102 while already descending.
    const fired = lockout(101.7, 127.2)
    expect(fired).toBeDefined()
    expect(fired!.valueDeg).toBeCloseTo(127.2, 1)
    // 23 degrees short of lockout is MAJOR. Scored on the 102 it was SEVERE — a rank that
    // pre-empts the utterance bucket and pulls a reference clip, for an ordinary soft top.
    expect(fired!.severity).toBe('major')
    expect(lockout(101.7, 101.7)!.severity).toBe('severe')
  })

  it('falls back to this frame when the caller tracks no top, so a single frame still works', () => {
    expect(lockout(130)?.valueDeg).toBe(130)
    expect(lockout(130, null)?.valueDeg).toBe(130)
  })

  it('says a true number about the real footage', () => {
    const runs = segmentedFrames(loadRealMotion()).map((frames) => runPipeline(frames, { view: 'side' }))
    const fired = runs.flatMap((run) => eventsOfKind(run.events, 'form_fault')).filter((e) => e.fault === 'no_lockout')
    expect(fired.length).toBeGreaterThan(0)
    for (const event of fired) {
      // Every reported angle must be a top the machine could actually have been at: inside the
      // band between "the rep counts" and "you locked out".
      expect(event.valueDeg!).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
      expect(event.valueDeg!).toBeLessThanOrEqual(FAULT_THRESHOLDS.lockoutDeg)
      // 102 degrees is below upEnterDeg, so the old reading is now unrepresentable.
      expect(event.valueDeg!).toBeGreaterThan(REP_THRESHOLDS.downEnterDeg)
    }
  })
})

describe('the camera-reframe nag states a duration that exists', () => {
  const firstMention: CoachEvent = {
    kind: 'form_unobservable',
    at: 0,
    missing: ['ankle'],
    // What the debounce actually produces: 14 intervals at 30fps, i.e. ~467ms.
    sinceMs: (OBSERVABILITY.lostFrames - 1) * FRAME_INTERVAL_MS,
  }

  it('never renders "for 0s", which would deny the thing it is reporting', () => {
    expect(firstMention.sinceMs).toBeLessThan(1000)
    const line = toEventLine(firstMention)
    expect(line).not.toContain('for 0s')
    expect(line).toContain(`for ${EVENT_LINE.minReportedSec}s`)
  })

  it('still reports a long absence honestly rather than clamping everything to one', () => {
    expect(toEventLine({ ...firstMention, sinceMs: OBSERVABILITY.repeatMs })).toContain('for 20s')
  })

  it('holds for the lines the pipeline really emits', () => {
    const events = eventsOfKind(runPipeline(ankleLessSet(3)).events, 'form_unobservable')
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) expect(toEventLine(event)).not.toContain('for 0s')
  })
})
