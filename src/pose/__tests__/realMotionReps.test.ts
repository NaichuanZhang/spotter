/**
 * THE SPECIFICATION: SPOTTER COUNTS THE SIX PUSHUPS IN THE REAL FOOTAGE.
 *
 * `realMotion.test.ts` is the characterisation of the input — is the signal a pushup at
 * all, does the detector track a horizontal body, do the recorded numbers still reproduce.
 * THIS file is the requirement: the product's job is to count a real human's real reps and
 * to say only true things about them. Everything it asserts was measured on
 * `public/clips/landmarks.json`, 578 frames of this repo's own vendored detector's output
 * over a pushup tutorial containing six unambiguous reps.
 *
 * Two independent defects used to make this file's every assertion fail:
 *
 *   1. `upEnterDeg` was 155 while the demonstrator's rep TOPS measure 121.7 - 151.0
 *      smoothed degrees. The machine went down past `downEnterDeg` on all six and never
 *      came back up far enough to close one, so it sat in BOTTOM forever and counted 0.
 *   2. `measureAngles` extrapolated the shoulder->ankle line to an ankle that is off
 *      frame (ankle visibility median 0.14 against a 0.5 gate, ankle x reaching 1.27) and
 *      produced a body line from it — a 69.5-degree "pike" no spine can make. The coach
 *      would have criticised form it could not see.
 *
 * Both are fixed, and the fixes are independent: (1) is what buys the reps, (2) is what
 * stops the reps being libelled. This file pins both, plus the honesty properties that
 * follow from (2): an unmeasurable body line reports NULL, never 0, and the event line the
 * coach reads makes no hip claim at all.
 *
 * WHY THE REPLAY IS PER-TAKE. See `segmentedFrames` — the source is an edited video, and
 * splicing its four takes together manufactures two reps out of the cuts. The spliced
 * count is asserted too, so the difference stays visible instead of being mistaken for
 * motion.
 */

import { describe, expect, it } from 'vitest'
import type { RepMetrics } from '../../types/events'
import { toEventLine } from '../../types/events'
import { measureAngles } from '../angles'
import { evaluateFaults } from '../faults'
import { REP_THRESHOLDS } from '../repMachine'
import { createAngleWindows, pushAngles, smoothedAngles } from '../smoothing'
import { eventsOfKind, faultTypes, runPipeline } from './fixtures'
import { loadRealMotion, MEASURED, segmentedFrames } from './realMotion'

const fixture = loadRealMotion()
const takes = segmentedFrames(fixture)

/** Every take replayed through the real pipeline with its own fresh state. */
const runs = takes.map((frames) => runPipeline(frames, { view: 'side' }))

const repEvents = runs.flatMap((run) => eventsOfKind(run.events, 'rep_completed'))
const reps: readonly RepMetrics[] = repEvents.map((event) => event.rep)

describe('real motion: the six reps are counted', () => {
  it('scores every one of the demonstrator six', () => {
    expect(reps).toHaveLength(MEASURED.repsScored)
    expect(reps).toHaveLength(fixture.repsScoredByRelaxedThresholds)
    expect(runs.reduce((sum, run) => sum + run.reps.totalReps, 0)).toBe(MEASURED.repsScored)
  })

  it('reproduces the depth the extraction recorded for each of them, in order', () => {
    const recorded = [...fixture.cycles].sort((a, b) => a.startFrame - b.startFrame)
    expect(recorded).toHaveLength(reps.length)

    reps.forEach((rep, i) => {
      const cycle = recorded[i]!
      expect(rep.minElbowAngle).toBeCloseTo(cycle.minElbowAngle, 0)
      expect(rep.depthPct).toBeCloseTo(cycle.depthPct, 0)
      // The two shallow reps are counted AND flagged short — that is the whole point of
      // `partial`: the rep happened, it just was not deep.
      expect(rep.partial).toBe(cycle.partial)
    })
  })

  it('counts them because of the lockout change, and would not at the old threshold', () => {
    // Every rep closed on an elbow angle that the shipped threshold accepts...
    for (const rep of reps) expect(rep.maxElbowAngle).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
    // ...and that the OLD one rejected. This is the whole of defect 1, in one assertion.
    const old = MEASURED.repsScoredByOldLockoutDeg
    for (const rep of reps) expect(rep.maxElbowAngle).toBeLessThan(old.upEnterDeg)
  })

  it('does not mistake the source video cuts for reps', () => {
    // The same frames, spliced: two extra reps appear out of the edits. Replaying per take
    // is what removes them, not a guard against them.
    const spliced = runPipeline(fixture.frames, { view: 'side' })
    expect(spliced.reps.totalReps).toBe(MEASURED.repsScoredAcrossCuts)
    expect(spliced.reps.totalReps).toBeGreaterThan(MEASURED.repsScored)
  })
})

describe('real motion: a countable rep with an unseeable body line', () => {
  it('measures every frame for counting while refusing a body line on nearly all of them', () => {
    const measured = fixture.frames.map((frame) => measureAngles(frame.landmarks))
    expect(measured.filter((angles) => angles === null)).toHaveLength(MEASURED.unmeasurableFrames)

    const withBodyLine = measured.filter((angles) => angles !== null && angles.hipDeviation !== null)
    expect(withBodyLine).toHaveLength(MEASURED.bodyLineFrames)
    // The refusal is the majority case here, not an edge case.
    expect(withBodyLine.length).toBeLessThan(fixture.frames.length / 2)
  })

  it('reports an unmeasurable body line as null and NEVER as zero degrees of sag', () => {
    // The confidently-wrong case. `Math.max(acc.worstSag, null)` coerces to 0, and 0 means
    // "perfectly straight back" — the coach would praise a spine it never saw. Every one of
    // these six reps has hipFrames 0 in the extraction, so every one must read null.
    expect(fixture.cycles.every((cycle) => cycle.hipFrames === 0)).toBe(true)
    for (const rep of reps) {
      expect(rep.hipDeviationDeg).toBeNull()
      expect(rep.hipDeviationDeg).not.toBe(0)
    }
  })

  it('makes no hip claim in the line the coach actually reads', () => {
    for (const event of repEvents) {
      const line = toEventLine(event)
      expect(line).not.toContain('hip_sag')
      expect(line).not.toContain('hip_pike')
      // ...and it says so out loud rather than staying silent, so "clean" cannot be read
      // as "I checked your back".
      expect(line).toContain('body line not visible')
    }
  })

  it('raises no sag or pike fault anywhere in the clip', () => {
    // Before the fix this replay emitted a SEVERE piked_hips at 68 degrees.
    const faults = runs.flatMap((run) => faultTypes(run.events))
    expect(faults).not.toContain('sagging_hips')
    expect(faults).not.toContain('piked_hips')

    const perFrame = fixture.frames.flatMap((frame) => {
      const angles = measureAngles(frame.landmarks)
      if (!angles) return []
      return evaluateFaults({ angles, phase: 'bottom', view: 'side', inFrame: true }).map((c) => c.fault)
    })
    expect(perFrame).not.toContain('sagging_hips')
    expect(perFrame).not.toContain('piked_hips')
  })
})

describe('real motion: the user is told the body line cannot be judged', () => {
  const unobservable = runs.flatMap((run) => eventsOfKind(run.events, 'form_unobservable'))

  it('says it once per take, not once per frame', () => {
    // Three of the four takes are long enough to clear the debounce; take 2 is eight frames
    // and says nothing, which is the point of the debounce.
    expect(unobservable).toHaveLength(MEASURED.unobservableUtterances)
    const frames = takes.reduce((sum, take) => sum + take.length, 0)
    expect(unobservable.length).toBeLessThan(frames / 100)
    for (const event of unobservable) {
      expect(event.missing).toContain('ankle')
      expect(toEventLine(event)).toContain('back up')
    }
  })

  it('names the ankle and not the hip, because the hip is visible throughout', () => {
    for (const event of unobservable) expect(event.missing).not.toContain('hip')
  })
})

describe('real motion: the lockout is coached, not enforced', () => {
  it('tells the user to lock out instead of silently withholding the rep', () => {
    const faults = runs.flatMap((run) => faultTypes(run.events))
    expect(faults).toContain('no_lockout')
  })

  it('keeps no_lockout reachable: a rep can complete without straightening', () => {
    // If the fault threshold ever drops below the rep threshold, every completed rep is a
    // lockout by definition and the fault becomes dead code — the exact trap
    // `partialAboveDeg` fell into in the original brief.
    const tops = fixture.cycles.map((cycle) => cycle.maxElbowAngle)
    for (const top of tops) expect(top).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
  })
})

/**
 * The smoothed elbow angle of every frame with its source-video frame number, computed
 * ONE TAKE AT A TIME so the median window warms up per take exactly as the replay does.
 * Kept grouped by take, because a frame-to-frame step across a cut is an edit, not motion.
 */
const perTakeSeries: readonly (readonly { sourceFrame: number; elbow: number }[])[] = (() => {
  const byTime = new Map(fixture.frames.map((frame, position) => [frame.t, fixture.sourceFrames[position]!]))
  return takes.map((frames) => {
    let windows = createAngleWindows()
    const out: { sourceFrame: number; elbow: number }[] = []
    for (const frame of frames) {
      const raw = measureAngles(frame.landmarks)
      if (!raw) continue
      windows = pushAngles(windows, raw)
      const smoothed = smoothedAngles(windows, raw)
      if (smoothed) out.push({ sourceFrame: byTime.get(frame.t)!, elbow: smoothed.elbow })
    }
    return out
  })
})()

const series = perTakeSeries.flat()

describe('real motion: the band the lockout threshold was chosen against', () => {
  it('puts every rep top in the 121.7 - 151.0 band the threshold sits below', () => {
    const tops = fixture.cycles.map((cycle) => {
      const inCycle = series
        .filter((s) => s.sourceFrame >= cycle.startFrame && s.sourceFrame <= cycle.endFrame)
        .map((s) => s.elbow)
      expect(inCycle.length).toBeGreaterThan(0)
      return Math.max(...inCycle)
    })

    expect(Math.max(...tops)).toBeCloseTo(MEASURED.highestCycleTopDeg, 0)
    expect(Math.min(...tops)).toBeCloseTo(MEASURED.lowestCycleTopDeg, 0)

    // THE WHOLE RECALIBRATION, in two assertions: the shipped threshold clears the worst
    // real lockout with margin, and the old one did not clear even the best.
    expect(REP_THRESHOLDS.upEnterDeg).toBeLessThan(Math.min(...tops))
    expect(MEASURED.repsScoredByOldLockoutDeg.upEnterDeg).toBeGreaterThan(Math.max(...tops))
  })

  it('keeps a hysteresis gap the smoothed signal cannot cross on noise', () => {
    const gap = REP_THRESHOLDS.upEnterDeg - REP_THRESHOLDS.downEnterDeg
    expect(gap).toBeGreaterThanOrEqual(REP_THRESHOLDS.minHysteresisGapDeg)

    // Frame-to-frame steps WITHIN a take, past the median warm-up. The large ones are real
    // descent velocity; the point is that the typical step is nowhere near the gap.
    const steps = perTakeSeries.flatMap((take) => {
      const elbows = take.map((s) => s.elbow).slice(5)
      return elbows.slice(1).map((elbow, i) => Math.abs(elbow - elbows[i]!))
    })
    const sorted = [...steps].sort((a, b) => a - b)
    expect(sorted[Math.floor(sorted.length * 0.5)]!).toBeLessThan(3)
    expect(sorted[Math.floor(sorted.length * 0.99)]!).toBeLessThan(gap)
  })
})
