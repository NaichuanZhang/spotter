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
 * ============================== WHAT THIS FILE IS =============================
 *
 * The INPUT characterisation: does the detector track a horizontal body, is the signal a
 * pushup, do the recorded numbers still reproduce frame for frame. The REQUIREMENT — that
 * all six reps are counted and that nothing untrue is said about them — lives next door in
 * `realMotionReps.test.ts`. Keep the split: this file is allowed to change when the fixture
 * changes, that one is not allowed to change at all without an argument.
 *
 * ============================ WHAT IT USED TO SAY =============================
 *
 * That SPOTTER counted ZERO of this demonstrator's six pushups, and that fixing it was a
 * calibration decision no test got to make. Both findings were real, both are now fixed,
 * and this file was rewritten deliberately rather than loosened:
 *
 *   1. `upEnterDeg` was 155 against rep tops of 121.7 - 151.0 smoothed degrees, so the
 *      machine descended past `downEnterDeg` six times and never closed a rep. It is now
 *      115, the failure to lock out is coached through `no_lockout` instead of silently
 *      withholding the rep, and the hysteresis gap it cost (55 -> 15 degrees) is floored by
 *      `REP_THRESHOLDS.minHysteresisGapDeg`. The argument and the numbers behind 115 are in
 *      `repMachine.ts`; the evidence that it works is in `realMotionReps.test.ts`.
 *   2. `measureAngles` returned a `hipDeviation` on all 578 frames although only 45 have a
 *      visible ankle, by extrapolating the shoulder->ankle line to a foot the detector
 *      placed off frame. The last test here used to pin that hazard and now pins its
 *      REFUSAL, which is what its own comment demanded should happen.
 *
 * The scale of hazard 2, for the record: the fabricated deviations reached 69.5 degrees of
 * "pike", while on the 45 frames where the ankle is genuinely visible the deviation spans
 * -11.95 to -4.13 degrees. The invented number was nearly six times the largest real one.
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
      // ...and straight enough at the top to close one, now that the lockout is a quality
      // flag rather than a gate. `meetsAppLockout` is the extraction's record of the OLD
      // threshold, and it is false on every cycle — that is what used to score zero.
      expect(measured.max).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
      expect(cycle.maxElbowAngle).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
      expect(cycle.meetsAppLockout).toBe(false)
    }
  })

  /**
   * UPDATED DELIBERATELY. This test used to assert zero reps and to cite
   * `repDetection.appThresholds.repsScored` (also zero) as corroboration. Both numbers were
   * measurements of the pre-recalibration thresholds, so the JSON field is now history and
   * the live count belongs to `realMotionReps.test.ts`. What is still worth pinning HERE is
   * the thing the fixture is for: the spliced stream ends at the top of a rep with the
   * machine idle, not stuck in BOTTOM, which is how the old failure announced itself.
   */
  it('no longer strands the machine in BOTTOM for the whole clip', () => {
    const run = runPipeline(fixture.frames, { view: 'side' })

    expect(run.reps.totalReps).toBeGreaterThan(0)
    expect(run.reps.armed).toBe(true)
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(run.reps.totalReps)
    // The old reading: descents seen, no ascent ever cleared `upEnterDeg`, so `current`
    // stayed open forever and every rep was swallowed.
    expect(fixture.repsScoredByAppThresholds).toBe(MEASURED.repsScoredByOldLockoutDeg.repsScored)
  })

  it('pins the band the threshold was calibrated against, and the margin either side', () => {
    const tops = fixture.cycles.map((cycle) => Math.max(...elbowsIn(cycle.startFrame, cycle.endFrame)))
    const best = Math.max(...tops)
    const worst = Math.min(...tops)

    expect(best).toBeCloseTo(MEASURED.highestCycleTopDeg, 0)
    expect(worst).toBeCloseTo(MEASURED.lowestCycleTopDeg, 0)

    // The worst cycle sets the bar, and the shipped threshold clears it with room to spare
    // — that margin is what fatigue is allowed to eat before reps stop counting.
    expect(REP_THRESHOLDS.upEnterDeg).toBeLessThan(worst)
    // The old threshold did not clear even the best cycle. Hence zero.
    expect(MEASURED.repsScoredByOldLockoutDeg.upEnterDeg).toBeGreaterThan(best)
    // The extraction's exploratory 120 also worked; 115 is the shipped, more conservative
    // choice. If a future recalibration puts `upEnterDeg` above the relaxed pass's value,
    // the fixture's six reps stop being reproducible and this is where it shows up.
    expect(REP_THRESHOLDS.upEnterDeg).toBeLessThanOrEqual(fixture.relaxedUpEnterDeg)
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
   * THE REFUSAL. This test is the rewrite the old characterisation test asked for: it used
   * to pin `measureAngles` returning a hip deviation on all 578 frames although only 45 have
   * a visible ankle, and to say that if the refusal was ever implemented the test should
   * assert it instead. It was, so it does.
   *
   * Do not relax this into "usually refuses". The failure mode it guards is a coach that
   * confidently criticises a back it cannot see.
   */
  it('refuses a hip deviation on every frame whose ankle it cannot see', () => {
    const framed = fixture.frames.filter((frame) => inFrame(frame.landmarks).inFrame)
    expect(framed).toHaveLength(MEASURED.inFrameFrames)

    const ankleVisible = (frame: (typeof fixture.frames)[number]): boolean =>
      frame.landmarks !== null &&
      Math.max(visibilityOf(frame.landmarks, LEFT_ANKLE), visibilityOf(frame.landmarks, RIGHT_ANKLE)) >=
        VISIBILITY.joint
    expect(fixture.frames.filter(ankleVisible).length).toBeLessThan(fixture.frames.length / 2)

    // Every frame still measures an elbow — losing the feet costs the body line and nothing
    // else. And the body line comes back EXACTLY on the frames that have an ankle.
    let measuredBodyLines = 0
    for (const frame of fixture.frames) {
      const angles = measureAngles(frame.landmarks)
      expect(angles).not.toBeNull()
      expect(Number.isFinite(angles!.elbow)).toBe(true)

      if (ankleVisible(frame)) {
        expect(angles!.hipDeviation).not.toBeNull()
        expect(angles!.bodyLine).not.toBeNull()
        measuredBodyLines += 1
      } else {
        expect(angles!.hipDeviation).toBeNull()
        expect(angles!.bodyLine).toBeNull()
      }
    }
    expect(measuredBodyLines).toBe(MEASURED.bodyLineFrames)

    // What the honest measurement looks like when it IS available: a mild pike, nowhere near
    // the 69.5-degree "pike" the extrapolated ankle used to invent.
    const real = fixture.frames
      .map((frame) => measureAngles(frame.landmarks)?.hipDeviation ?? null)
      .filter((deviation): deviation is number => deviation !== null)
    expect(real).toHaveLength(MEASURED.bodyLineFrames)
    expect(Math.max(...real.map(Math.abs))).toBeLessThan(2 * REP_THRESHOLDS.cleanHipDeviationDeg)
  })
})
