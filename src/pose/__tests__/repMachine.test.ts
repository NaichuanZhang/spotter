import { describe, expect, it } from 'vitest'
import { measureAngles } from '../angles'
import {
  createRepMachineState,
  depthPct,
  REP_THRESHOLDS,
  step,
  syntheticRep,
  validateRepThresholds,
  worstDeviation,
} from '../repMachine'
import {
  cleanSet,
  eventsOfKind,
  FRAME_INTERVAL_MS,
  outOfFrameSet,
  partialSet,
  runPipeline,
  sideViewPose,
} from './fixtures'

/** Drive the machine from a bare elbow-angle series, no landmarks involved. */
function driveAngles(series: readonly number[]) {
  let state = createRepMachineState()
  const events = []
  for (const [i, elbow] of series.entries()) {
    const result = step(state, {
      angles: { side: 'left', elbow, bodyLine: 180, hipDeviation: 0, neck: 175, flare: 40 },
      t: i * FRAME_INTERVAL_MS,
    })
    state = result.state
    events.push(...result.events)
  }
  return { state, events }
}

describe('threshold configuration', () => {
  it('is internally consistent', () => {
    expect(() => validateRepThresholds()).not.toThrow()
  })

  it('rejects a partial threshold that can never be reached', () => {
    // The brief's literal 110 sits above downEnterDeg=100: no scored rep could ever be
    // flagged partial. Recalibration must fail loudly rather than kill the flag.
    expect(() => validateRepThresholds({ ...REP_THRESHOLDS, partialAboveDeg: 110 })).toThrow(
      /partialAboveDeg/,
    )
  })

  it('rejects an inverted hysteresis gap', () => {
    expect(() => validateRepThresholds({ ...REP_THRESHOLDS, upEnterDeg: 90 })).toThrow(/downEnterDeg/)
  })
})

describe('depthPct', () => {
  it('maps the anchor angles and clamps outside them', () => {
    expect(depthPct(REP_THRESHOLDS.depthZeroDeg)).toBe(0)
    expect(depthPct(REP_THRESHOLDS.depthFullDeg)).toBe(100)
    expect(depthPct(120)).toBeCloseTo(50, 6)
    expect(depthPct(180)).toBe(0)
    expect(depthPct(20)).toBe(100)
  })
})

describe('worstDeviation', () => {
  it('keeps the sign of whichever extreme was larger', () => {
    expect(worstDeviation(18, -4)).toBe(18)
    expect(worstDeviation(4, -18)).toBe(-18)
    expect(worstDeviation(0, 0)).toBe(0)
  })
})

describe('hysteresis', () => {
  it('counts ten reps from the clean fixture, smoothed', () => {
    const run = runPipeline(cleanSet(10))
    const reps = eventsOfKind(run.events, 'rep_completed')
    expect(reps).toHaveLength(10)
    expect(reps.map((e) => e.totalReps)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(run.reps.totalReps).toBe(10)
  })

  it('counts the same ten reps unsmoothed, so smoothing is not load-bearing for counting', () => {
    const run = runPipeline(cleanSet(10), { smooth: false })
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(10)
  })

  it('emits nothing while dithering across a single threshold', () => {
    // A naive one-threshold counter at 100 degrees would score once per oscillation.
    const series = [178, 178, 178]
    for (let i = 0; i < 20; i += 1) series.push(i % 2 === 0 ? 95 : 105)
    const { events } = driveAngles(series)
    expect(events).toHaveLength(0)
  })

  it('emits nothing while dithering across the up threshold either', () => {
    const series = [178, 178, 178, 90]
    for (let i = 0; i < 20; i += 1) series.push(i % 2 === 0 ? 150 : 154)
    const { events } = driveAngles(series)
    expect(events).toHaveLength(0)
  })

  it('refuses a freebie rep when the engine starts with the user already down', () => {
    // No frame at lockout yet, so the machine is not armed and the first ascent is
    // setup, not a rep.
    const { events, state } = driveAngles([88, 85, 85, 90, 120, 160, 178])
    expect(events).toHaveLength(0)
    expect(state.armed).toBe(true)
    expect(state.totalReps).toBe(0)
  })
})

describe('rep metrics', () => {
  it('records depth, tempo and a clean verdict for a textbook rep', () => {
    const run = runPipeline(cleanSet(3))
    const [first] = eventsOfKind(run.events, 'rep_completed')
    expect(first).toBeDefined()
    const rep = first!.rep

    expect(rep.index).toBe(1)
    expect(rep.partial).toBe(false)
    expect(rep.clean).toBe(true)
    expect(rep.minElbowAngle).toBeLessThan(REP_THRESHOLDS.partialAboveDeg)
    expect(rep.depthPct).toBeGreaterThan(75)
    expect(rep.maxElbowAngle).toBeGreaterThan(REP_THRESHOLDS.upEnterDeg)
    expect(rep.descentMs).toBeGreaterThan(0)
    expect(rep.ascentMs).toBeGreaterThan(0)
    expect(Math.abs(rep.hipDeviationDeg)).toBeLessThan(1)
  })

  it('counts shallow reps and flags every one of them partial', () => {
    const run = runPipeline(partialSet(3))
    const reps = eventsOfKind(run.events, 'rep_completed')
    expect(reps).toHaveLength(3)
    for (const e of reps) {
      expect(e.rep.partial).toBe(true)
      expect(e.rep.clean).toBe(false)
      expect(e.rep.minElbowAngle).toBeGreaterThan(REP_THRESHOLDS.partialAboveDeg)
    }
    // Partial reps still count toward the total — a counter that disagrees with what
    // the human felt they did reads as broken.
    expect(run.reps.totalReps).toBe(3)
    expect(run.reps.cleanReps).toBe(0)
  })

  it('reports a whole-descent tempo, not just the sub-threshold slice', () => {
    const run = runPipeline(cleanSet(2), { smooth: false })
    const [first] = eventsOfKind(run.events, 'rep_completed')
    // The fixture descends over 6 frames (~200ms); the clock must start at the top of
    // the descent, not at the moment the elbow crossed downEnterDeg.
    expect(first!.rep.descentMs).toBeGreaterThan(3 * FRAME_INTERVAL_MS)
  })
})

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before = createRepMachineState()
    const snapshot = JSON.stringify(before)
    const after = step(before, {
      angles: { side: 'left', elbow: 90, bodyLine: 180, hipDeviation: 5, neck: 175, flare: 40 },
      t: 100,
    })
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after.state).not.toBe(before)
  })

  it('ignores a non-finite frame instead of poisoning the accumulator', () => {
    const start = createRepMachineState()
    const result = step(start, {
      angles: { side: 'left', elbow: Number.NaN, bodyLine: 180, hipDeviation: 0, neck: 175, flare: 40 },
      t: 0,
    })
    expect(result.state).toBe(start)
    expect(result.events).toHaveLength(0)
  })

  it('is replay-deterministic', () => {
    const frames = cleanSet(4)
    expect(JSON.stringify(runPipeline(frames).events)).toBe(JSON.stringify(runPipeline(frames).events))
  })
})

describe('out-of-frame gaps', () => {
  it('invents no reps across the gap and resumes counting after it', () => {
    const frames = outOfFrameSet(20)
    const run = runPipeline(frames)
    expect(run.skipped).toBe(20)
    // Two reps before the gap and two after; nothing extra fabricated by the gap.
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(4)
  })

  it('skips unmeasurable frames rather than reading them as maximum depth', () => {
    const blind = sideViewPose(178).map((lm) => ({ ...lm, visibility: 0 }))
    expect(measureAngles(blind)).toBeNull()
  })
})

describe('syntheticRep', () => {
  it('scores a demo rep through the same counters as a real one', () => {
    const start = createRepMachineState()
    const { state, events } = syntheticRep(start, 1234)
    expect(events).toHaveLength(1)
    const event = eventsOfKind(events, 'rep_completed')[0]!
    expect(event.totalReps).toBe(1)
    expect(event.cleanReps).toBe(1)
    expect(event.rep.partial).toBe(false)
    expect(state.totalReps).toBe(1)
    expect(start.totalReps).toBe(0)
  })

  it('accepts overrides but always numbers the rep itself', () => {
    const { state, events } = syntheticRep({ ...createRepMachineState(), totalReps: 7, cleanReps: 5 }, 10, {
      index: 999,
      partial: true,
      clean: false,
    })
    const event = eventsOfKind(events, 'rep_completed')[0]!
    expect(event.rep.index).toBe(8)
    expect(event.rep.partial).toBe(true)
    expect(state.cleanReps).toBe(5)
  })

  it('leaves the phase alone, because the hotkey can be pressed mid-rep', () => {
    const mid = { ...createRepMachineState(), phase: 'bottom' as const }
    expect(syntheticRep(mid, 0).state.phase).toBe('bottom')
  })
})
