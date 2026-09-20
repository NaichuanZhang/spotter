/**
 * MEASURABILITY IS NOT VALIDITY, and UNKNOWN IS NOT ZERO.
 *
 * Two properties are pinned here, both of which the shipped code got wrong until the
 * ankle-decoupling pass:
 *
 *   1. A frame with shoulder, elbow and wrist is COUNTABLE even with no ankle in sight.
 *      Requiring the ankle for the whole frame meant a phone on the floor — which crops
 *      the feet — turned the product off, counter reading 0 with nothing to explain why.
 *   2. An unmeasurable body line is NULL, and null must never be read as 0. Zero degrees
 *      of deviation is a measurement meaning "straight back", so coercing null to it turns
 *      "I could not see your form" into "your form was perfect". That is the worst failure
 *      available to this codebase: confidently wrong, in the user's favour, about the one
 *      thing they cannot check themselves.
 *
 * Plus the user-facing half: when the body line cannot be judged for a sustained period,
 * the coach says so, once, with a fix — and not thirty times a second.
 */

import { describe, expect, it } from 'vitest'
import type { CoachEvent, RepMetrics } from '../../types/events'
import { EVENT_LINE, toEventLine } from '../../types/events'
import type { PoseAngles } from '../angles'
import { measureAngles } from '../angles'
import { evaluateFaults } from '../faults'
import { bodyLineInFrame, countingInFrame, inFrame } from '../landmarks'
import {
  createObservabilityState,
  OBSERVABILITY,
  stepObservability,
} from '../observability'
import { createRepMachineState, REP_THRESHOLDS, step, worstDeviation } from '../repMachine'
import {
  ankleLessSet,
  buildSet,
  cleanSet,
  eventsOfKind,
  faultTypes,
  FRAME_INTERVAL_MS,
  occludeJoints,
  runPipeline,
  sideViewPose,
  softTopSet,
} from './fixtures'

/** Drive the rep machine from hand-made angle frames. No landmarks, no smoothing. */
function driveFrames(frames: readonly { elbow: number; hipDeviation: number | null }[]) {
  let state = createRepMachineState()
  const events: CoachEvent[] = []
  frames.forEach((frame, i) => {
    const angles: PoseAngles = {
      side: 'left',
      elbow: frame.elbow,
      bodyLine: frame.hipDeviation === null ? null : 180 - Math.abs(frame.hipDeviation),
      hipDeviation: frame.hipDeviation,
      neck: 175,
      flare: 40,
    }
    const result = step(state, { angles, t: i * FRAME_INTERVAL_MS })
    state = result.state
    events.push(...result.events)
  })
  return { state, reps: eventsOfKind(events, 'rep_completed').map((e) => e.rep) }
}

/** One rep's worth of elbow angles: a full lockout, a descent past depth, and back up. */
function repElbows(): number[] {
  const { descentStartDeg, downEnterDeg, partialAboveDeg } = REP_THRESHOLDS
  const top = descentStartDeg + 13
  return [top, top, top, downEnterDeg - 5, partialAboveDeg - 10, partialAboveDeg - 10, downEnterDeg - 5, top, top]
}

describe('a countable frame with no ankle', () => {
  const footless = occludeJoints(sideViewPose(120, 0.04), ['ankle'])

  it('measures the elbow and refuses the body line', () => {
    const angles = measureAngles(footless)
    expect(angles).not.toBeNull()
    expect(angles!.elbow).toBeCloseTo(120, 6)
    expect(angles!.bodyLine).toBeNull()
    expect(angles!.hipDeviation).toBeNull()
    // The joints that ARE visible still measure: losing the feet costs the body line only.
    expect(angles!.neck).not.toBeNull()
    expect(angles!.flare).not.toBeNull()
  })

  it('is countable but not fully framed, and the two checks say different things', () => {
    expect(countingInFrame(footless).inFrame).toBe(true)
    expect(bodyLineInFrame(footless).missing).toEqual(['ankle'])
    // The full-coaching check still reports the gap, which is what drives the nag.
    expect(inFrame(footless).inFrame).toBe(false)
    expect(inFrame(footless).missing).toEqual(['ankle'])
  })

  it('proposes no sag or pike fault, in either direction', () => {
    const angles = measureAngles(footless)!
    const faults = evaluateFaults({ angles, phase: 'bottom', view: 'side', inFrame: true }).map((c) => c.fault)
    expect(faults).not.toContain('sagging_hips')
    expect(faults).not.toContain('piked_hips')

    // The same pose WITH the ankle visible does report the sag it was built with, so the
    // refusal above is the missing ankle and not a broken sag detector.
    const withFeet = measureAngles(sideViewPose(120, 0.04))!
    expect(withFeet.hipDeviation).toBeGreaterThan(0)
    expect(
      evaluateFaults({ angles: withFeet, phase: 'bottom', view: 'side', inFrame: true }).map((c) => c.fault),
    ).toContain('sagging_hips')
  })

  it('refuses the neck angle too when the hip it is anchored to is not visible', () => {
    // The same hazard one joint further up: the coordinates are still there and the angle is
    // still computable, so the refusal has to be deliberate. An invented hip would produce an
    // invented `craned_neck`.
    const hipless = occludeJoints(sideViewPose(178), ['hip'])
    const angles = measureAngles(hipless)
    expect(angles).not.toBeNull()
    expect(angles!.elbow).toBeCloseTo(178, 6)
    expect(angles!.neck).toBeNull()
    expect(angles!.hipDeviation).toBeNull()
    expect(
      evaluateFaults({ angles: angles!, phase: 'top', view: 'side', inFrame: true }).map((c) => c.fault),
    ).not.toContain('craned_neck')
  })

  it('still counts every rep of a footless set', () => {
    const run = runPipeline(ankleLessSet(3))
    expect(run.skipped).toBe(0)
    expect(run.bodyLineFrames).toBe(0)

    const reps = eventsOfKind(run.events, 'rep_completed')
    expect(reps).toHaveLength(3)
    // Identical count to the same set with the feet in shot: the ankle buys form judgement,
    // never reps.
    expect(eventsOfKind(runPipeline(cleanSet(3)).events, 'rep_completed')).toHaveLength(3)
  })
})

describe('an unmeasurable body line is null, never zero', () => {
  it('reports null for a rep whose body line was never seen', () => {
    const { reps } = driveFrames(repElbows().map((elbow) => ({ elbow, hipDeviation: null })))
    expect(reps).toHaveLength(1)
    expect(reps[0]!.hipDeviationDeg).toBeNull()
    // THE ASSERTION THIS FILE EXISTS FOR. `Math.max(acc.worstSag, null)` is 0, and 0 would
    // be reported as a perfectly straight back on a rep nobody could see.
    expect(reps[0]!.hipDeviationDeg).not.toBe(0)
    expect(reps[0]!.hipDeviationDeg).not.toBe(-0)
  })

  it('does not dilute a real deviation with the frames that had none', () => {
    // Half the rep measurable at a severe sag, half not. The worst case must survive.
    const sag = REP_THRESHOLDS.cleanHipDeviationDeg + 8
    const { reps } = driveFrames(
      repElbows().map((elbow, i) => ({ elbow, hipDeviation: i % 2 === 0 ? sag : null })),
    )
    expect(reps).toHaveLength(1)
    expect(reps[0]!.hipDeviationDeg).toBeCloseTo(sag, 6)
    expect(reps[0]!.clean).toBe(false)
  })

  it('keeps the sign of a measured pike when the rest of the rep was unmeasurable', () => {
    // Guards the sign convention through the null-handling path: screen y grows downward,
    // so a hip ABOVE the shoulder-ankle line is NEGATIVE and is a pike, not a sag.
    const pike = -(REP_THRESHOLDS.cleanHipDeviationDeg + 8)
    const { reps } = driveFrames(
      repElbows().map((elbow, i) => ({ elbow, hipDeviation: i === 4 ? pike : null })),
    )
    expect(reps[0]!.hipDeviationDeg).toBeLessThan(0)
    expect(reps[0]!.hipDeviationDeg).toBeCloseTo(pike, 6)
  })

  it('propagates null through worstDeviation instead of inventing a zero', () => {
    expect(worstDeviation(null, null)).toBeNull()
    expect(worstDeviation(18, -4)).toBe(18)
    expect(worstDeviation(4, -18)).toBe(-18)
    expect(worstDeviation(0, 0)).toBe(0)
  })

  it('says so in the line the coach reads, rather than claiming clean form', () => {
    const { reps } = driveFrames(repElbows().map((elbow) => ({ elbow, hipDeviation: null })))
    const rep: RepMetrics = reps[0]!
    const line = toEventLine({ kind: 'rep_completed', at: 0, rep, totalReps: 1, cleanReps: 1 })

    expect(line).not.toContain('hip_sag')
    expect(line).not.toContain('hip_pike')
    expect(line).toContain(EVENT_LINE.bodyLineUnseen)
    // `clean` still means "no fault DETECTED", so the count is honest — the words beside it
    // are what stop it reading as a verified straight back.
    expect(rep.clean).toBe(true)
  })

  it('still makes the hip claim when the deviation WAS measured', () => {
    const sag = EVENT_LINE.hipClaimMinDeg + 12
    const { reps } = driveFrames(repElbows().map((elbow) => ({ elbow, hipDeviation: sag })))
    const line = toEventLine({ kind: 'rep_completed', at: 0, rep: reps[0]!, totalReps: 1, cleanReps: 0 })
    expect(line).toContain(`hip_sag ${sag}deg`)
    expect(line).not.toContain(EVENT_LINE.bodyLineUnseen)
  })
})

describe('a rep that never locks out', () => {
  const run = runPipeline(softTopSet(2))

  it('completes, instead of being silently withheld', () => {
    const reps = eventsOfKind(run.events, 'rep_completed')
    expect(reps).toHaveLength(2)
    for (const event of reps) {
      // Above the shipped threshold, below the old one: these are exactly the reps that
      // used to vanish.
      expect(event.rep.maxElbowAngle).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
      expect(event.rep.maxElbowAngle).toBeLessThan(155)
    }
  })

  it('and gets told to lock it out', () => {
    expect(faultTypes(run.events)).toContain('no_lockout')
  })

  it('keeps the fault reachable by construction, not by luck', () => {
    // If `lockoutDeg` ever slips below `upEnterDeg`, every completed rep is a lockout by
    // definition and `no_lockout` becomes dead code — the trap `partialAboveDeg` fell into.
    expect(REP_THRESHOLDS.upEnterDeg).toBeLessThan(155)
  })
})

describe('telling the user the body line cannot be judged', () => {
  const missing = ['ankle']
  const speak = (measurable: boolean, t: number) => ({ measurable, missing, t, canSpeak: true })

  it('says nothing for a brief dropout', () => {
    let state = createObservabilityState()
    const events: CoachEvent[] = []
    for (let i = 0; i < OBSERVABILITY.lostFrames - 1; i += 1) {
      const result = stepObservability(state, speak(false, i * FRAME_INTERVAL_MS))
      state = result.state
      events.push(...result.events)
    }
    expect(events).toHaveLength(0)
    expect(state.announced).toBe(false)
  })

  it('says it once, then not again until the repeat interval has passed', () => {
    let state = createObservabilityState()
    const events: CoachEvent[] = []
    // Three full repeat intervals' worth of frames, all unmeasurable.
    const frames = Math.ceil((3 * OBSERVABILITY.repeatMs) / FRAME_INTERVAL_MS)
    for (let i = 0; i < frames; i += 1) {
      const result = stepObservability(state, speak(false, i * FRAME_INTERVAL_MS))
      state = result.state
      events.push(...result.events)
    }

    // Debounced, emphatically: one utterance per repeat window, not one per frame.
    expect(events).toHaveLength(3)
    expect(events.length).toBeLessThan(frames / 100)
    const stamps = events.map((e) => e.at)
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(OBSERVABILITY.repeatMs)
    }
    // And it reports how long it has been true, so a repeat can read as a repeat.
    const first = events[0]!
    expect(first.kind).toBe('form_unobservable')
    if (first.kind === 'form_unobservable') {
      expect(first.missing).toEqual(missing)
      expect(first.sinceMs).toBeGreaterThan(0)
      expect(toEventLine(first)).toContain('cannot see ankle')
      expect(toEventLine(first)).toContain('back up')
    }
  })

  it('withholds the utterance when the gate is busy, and retries rather than dropping it', () => {
    let state = createObservabilityState()
    for (let i = 0; i < OBSERVABILITY.lostFrames + 5; i += 1) {
      const result = stepObservability(state, { measurable: false, missing, t: i * FRAME_INTERVAL_MS, canSpeak: false })
      state = result.state
      expect(result.events).toHaveLength(0)
    }
    expect(state.announced).toBe(false)

    // The frame the gate frees up, it speaks.
    const freed = stepObservability(state, speak(false, 1000))
    expect(freed.events).toHaveLength(1)
    expect(freed.state.announced).toBe(true)
  })

  it('announces the body line coming back, once', () => {
    let state = createObservabilityState()
    for (let i = 0; i < OBSERVABILITY.lostFrames; i += 1) {
      state = stepObservability(state, speak(false, i * FRAME_INTERVAL_MS)).state
    }
    expect(state.announced).toBe(true)

    const events: CoachEvent[] = []
    for (let i = 0; i < 4 * OBSERVABILITY.regainedFrames; i += 1) {
      const result = stepObservability(state, speak(true, (100 + i) * FRAME_INTERVAL_MS))
      state = result.state
      events.push(...result.events)
    }
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('form_observable')
    expect(state.announced).toBe(false)
    expect(toEventLine(events[0]!)).toContain('body line visible again')
  })

  it('never mutates the state it is handed', () => {
    const before = createObservabilityState()
    const snapshot = JSON.stringify(before)
    const after = stepObservability(before, speak(false, 0))
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after.state).not.toBe(before)
  })

  it('fires through the real pipeline on a footless set, and stays quiet once the feet return', () => {
    const lost = ankleLessSet(3)
    const regained = buildSet({ reps: 3, startAt: lost.length * FRAME_INTERVAL_MS })
    const run = runPipeline([...lost, ...regained])

    const unobservable = eventsOfKind(run.events, 'form_unobservable')
    const observable = eventsOfKind(run.events, 'form_observable')
    expect(unobservable).toHaveLength(1)
    expect(observable).toHaveLength(1)
    expect(observable[0]!.at).toBeGreaterThan(unobservable[0]!.at)
    expect(run.observability.announced).toBe(false)

    // Six reps counted across the join, regardless of what the feet were doing.
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(6)
  })
})
