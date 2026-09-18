/**
 * THE PIPELINE, RUN ON A REAL HUMAN DOING REAL PUSHUPS.
 *
 * Every other test in this package feeds `measureAngles` poses that were generated from
 * geometry, which proves the arithmetic and proves nothing about the detector. This one
 * replays 578 frames of landmarks that this repo's own vendored `pose_landmarker_full.task`
 * produced from a real pushup video, in MediaPipe's own coordinate space, through the real
 * `measureAngles` -> median filter -> `repMachine` chain that `poseEngine.processFrame`
 * runs. See `realMotion.ts` for provenance.
 *
 * ================================ THE HEADLINE ================================
 *
 * SPOTTER COUNTS ZERO OF THIS DEMONSTRATOR'S SIX PUSHUPS. That is not a bug in the
 * detector and not a bug in the geometry — both work fine on a horizontal body, which is
 * itself the good news this file exists to prove. It is a CALIBRATION failure, in exactly
 * one threshold:
 *
 *   REP_THRESHOLDS.upEnterDeg is 155. The six cycles top out at 121.7, 122.4, 123.6,
 *   126.7, 129.0 and 151.0 smoothed degrees. The machine gets all the way down past
 *   `downEnterDeg` (100) on every one of them and then never comes back up far enough to
 *   score, so it sits in BOTTOM forever.
 *
 * WHAT WOULD HAVE TO CHANGE, and why this test does not change it: `upEnterDeg` would have
 * to drop to about 120 to score all six, which leaves a 20-degree gap over `downEnterDeg`
 * instead of the present 55. `repMachine.ts` says in its own header that "the gap IS the
 * algorithm" — it is what stops landmark noise dithering across one line and inventing
 * reps. Narrowing it is a real trade, on real hardware, against a real noise floor, and it
 * is not a decision a test gets to make by quietly editing a constant until it goes green.
 *
 * So the expectation below is the measured truth (zero), written down loudly. When the
 * thresholds are recalibrated this test WILL fail, and the failure is the point: it forces
 * whoever recalibrates to look at what the new numbers do to real motion.
 *
 * SECOND FINDING, smaller but sharper: the source is a portrait crop that cuts the feet
 * off. Only 45 of 578 frames satisfy `requiredLandmarks`, yet `measureAngles` returns a
 * `hipDeviation` on all 578, because `hipDeviation` gates on finiteness and body span but
 * never on ankle VISIBILITY. It happily extrapolates a line to an ankle the detector
 * invented off-frame. The last test here pins that, because it is the mechanism by which
 * this clip produces a 68-degree "pike" that no human spine could make.
 */

import { describe, expect, it } from 'vitest'
import { measureAngles } from '../angles'
import { inFrame, LEFT_ANKLE, RIGHT_ANKLE, VISIBILITY, visibilityOf } from '../landmarks'
import { REP_THRESHOLDS } from '../repMachine'
import { createAngleWindows, pushAngles, smoothedAngles } from '../smoothing'
import { eventsOfKind, runPipeline } from './fixtures'
import { loadRealMotion, MEASURED } from './realMotion'

const fixture = loadRealMotion()

/**
 * The smoothed elbow angle of every frame, tagged with its source-video frame number.
 *
 * Computed ONCE over the whole stream and then sliced, never recomputed per cycle. That is
 * not an optimisation — it is the only faithful reading. A median window is never reset
 * mid-set in the live engine, so restarting it at each cycle boundary would measure four
 * frames of warm-up instead of the angle the rep machine actually saw, and it reads several
 * degrees low at exactly the top-of-rep that decides whether a rep scores.
 */
const SERIES: readonly { sourceFrame: number; elbow: number }[] = (() => {
  let windows = createAngleWindows()
  const out: { sourceFrame: number; elbow: number }[] = []
  fixture.frames.forEach((frame, position) => {
    const raw = measureAngles(frame.landmarks)
    if (!raw) return
    windows = pushAngles(windows, raw)
    const smoothed = smoothedAngles(windows, raw)
    if (smoothed) out.push({ sourceFrame: fixture.sourceFrames[position]!, elbow: smoothed.elbow })
  })
  return out
})()

/** Smoothed elbow angles inside one recorded frame range. Throws rather than return []. */
function elbowsIn(startFrame: number, endFrame: number): number[] {
  const inRange = SERIES.filter((s) => s.sourceFrame >= startFrame && s.sourceFrame <= endFrame).map((s) => s.elbow)
  if (inRange.length === 0) throw new Error(`realMotion: no smoothed frames in range ${startFrame}..${endFrame}`)
  return inRange
}

describe('real motion: the detector on a horizontal body', () => {
  it('reads the fixture the extraction wrote, at the size it recorded', () => {
    expect(fixture.frames).toHaveLength(MEASURED.frameCount)
    expect(fixture.sourceFrames).toHaveLength(MEASURED.frameCount)
    // Monotonic in both the source frame number and the timestamp, or the replay order is
    // not the capture order and every duration below is meaningless.
    for (let i = 1; i < fixture.frames.length; i += 1) {
      expect(fixture.sourceFrames[i]!).toBeGreaterThan(fixture.sourceFrames[i - 1]!)
      expect(fixture.frames[i]!.t).toBeGreaterThan(fixture.frames[i - 1]!.t)
    }
  })

  it('measures every real frame — BlazePose does track a horizontal body', () => {
    const run = runPipeline(fixture.frames, { view: 'side' })
    expect(run.skipped).toBe(MEASURED.unmeasurableFrames)
    expect(run.lastAngles).not.toBeNull()

    // Not just non-null: the elbow signal has to be a pushup, not a flat line.
    const elbows = SERIES.map((s) => s.elbow)
    expect(elbows).toHaveLength(MEASURED.frameCount)
    expect(Math.min(...elbows)).toBeLessThan(REP_THRESHOLDS.downEnterDeg)
    expect(Math.max(...elbows) - Math.min(...elbows)).toBeGreaterThan(fixture.minAmplitudeDeg)
  })

  it('finds a real pushup cycle in every range the extraction recorded', () => {
    expect(fixture.cycles).toHaveLength(fixture.repsScoredByRelaxedThresholds)

    for (const cycle of fixture.cycles) {
      const elbows = elbowsIn(cycle.startFrame, cycle.endFrame)
      const measured = { min: Math.min(...elbows), max: Math.max(...elbows) }

      // The live code reproduces the recorded depth to a tenth of a degree, which also
      // establishes that the extraction smoothed with the app's own median-5 and not
      // something of its own.
      expect(measured.min).toBeCloseTo(cycle.minElbowAngle, 0)

      // Amplitude is asserted on the FILE's number, not on the range. The extraction
      // measures a cycle's swing from the lockout it descended out of, which can sit a
      // frame or two outside [startFrame, endFrame] — rep 2 spans 26.4 degrees inside its
      // own range against a recorded 44.2 — so max-min over the slice is not the same
      // quantity and asserting it would be comparing two different measurements.
      expect(cycle.amplitudeDeg).toBeGreaterThanOrEqual(fixture.minAmplitudeDeg)

      // Deep enough to open a rep...
      expect(measured.min).toBeLessThan(REP_THRESHOLDS.downEnterDeg)
      // ...and never straight enough to close one, by either measurement. The finding.
      expect(measured.max).toBeLessThan(REP_THRESHOLDS.upEnterDeg)
      expect(cycle.maxElbowAngle).toBeLessThan(REP_THRESHOLDS.upEnterDeg)
      expect(cycle.meetsAppLockout).toBe(false)
    }
  })

  it('scores exactly what the extraction said SPOTTER would score: none of them', () => {
    const run = runPipeline(fixture.frames, { view: 'side' })

    expect(run.reps.totalReps).toBe(fixture.repsScoredByAppThresholds)
    expect(run.reps.totalReps).toBe(MEASURED.repsScored)
    expect(run.reps.cleanReps).toBe(0)
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(0)

    // Stuck in BOTTOM, not idling at the top: the descent was seen, the ascent never
    // cleared `upEnterDeg`. A `top` here would mean something else was wrong.
    expect(run.reps.armed).toBe(true)
    expect(run.reps.phase).toBe('bottom')
    expect(run.reps.current).not.toBeNull()
  })

  it('pins the one threshold that is wrong, and by how much', () => {
    const tops = fixture.cycles.map((cycle) => Math.max(...elbowsIn(cycle.startFrame, cycle.endFrame)))
    const best = Math.max(...tops)

    expect(best).toBeCloseTo(MEASURED.highestCycleTopDeg, 0)
    // The best lockout in the whole clip still misses by a few degrees...
    expect(best).toBeLessThan(REP_THRESHOLDS.upEnterDeg)
    // ...and the WORST cycle is the one that sets the bar: scoring all six needs an
    // `upEnterDeg` below this, which would narrow the hysteresis gap to ~20 degrees.
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(fixture.relaxedUpEnterDeg)
    expect(fixture.relaxedUpEnterDeg).toBeLessThan(REP_THRESHOLDS.upEnterDeg)
  })

  it('replays the chosen exemplar rep and reproduces its recorded depth', () => {
    const elbows = elbowsIn(fixture.exemplar.startFrame, fixture.exemplar.endFrame)

    expect(Math.min(...elbows)).toBeCloseTo(fixture.exemplar.minElbowAngle, 0)
    expect(Math.min(...elbows)).toBeLessThan(MEASURED.deepestElbowDeg + fixture.minAmplitudeDeg)
    // Full depth by the app's own scale, so the rendered reference clip is not claiming
    // a depth the source rep did not have.
    expect(Math.min(...elbows)).toBeLessThan(REP_THRESHOLDS.depthFullDeg)
  })

  /**
   * CHARACTERISATION, NOT APPROVAL. This documents a hazard rather than blessing it: if
   * `hipDeviation` ever learns to refuse an invisible ankle, this test fails and should be
   * rewritten to assert the refusal. Do not "fix" it by loosening the expectation.
   */
  it('still reports a hip deviation from an ankle it cannot see (known hazard)', () => {
    const framed = fixture.frames.filter((frame) => inFrame(frame.landmarks).inFrame)
    expect(framed).toHaveLength(MEASURED.inFrameFrames)

    const ankleVisible = fixture.frames.filter(
      (frame) =>
        frame.landmarks !== null &&
        Math.max(visibilityOf(frame.landmarks, LEFT_ANKLE), visibilityOf(frame.landmarks, RIGHT_ANKLE)) >=
          VISIBILITY.joint,
    )
    expect(ankleVisible.length).toBeLessThan(fixture.frames.length / 2)

    // Yet a hip deviation comes back on frames whose ankle is a guess, and it is not small.
    const deviations = fixture.frames
      .map((frame) => measureAngles(frame.landmarks))
      .filter((angles): angles is NonNullable<typeof angles> => angles !== null)
      .map((angles) => Math.abs(angles.hipDeviation))
    expect(deviations).toHaveLength(MEASURED.frameCount)
    expect(Math.max(...deviations)).toBeGreaterThan(REP_THRESHOLDS.cleanHipDeviationDeg)
  })
})
