import { describe, expect, it } from 'vitest'
import type { PoseAngles } from '../angles'
import type { FaultCandidate, GateState } from '../faults'
import {
  canSpeak,
  createGateState,
  evaluateFaults,
  evaluateRepFaults,
  FAULT_THRESHOLDS,
  gate,
  GATE_CONFIG,
  noteUtterance,
  persistenceFor,
  severityFor,
  UTTERANCE_RANK,
} from '../faults'
import type { RepMetrics } from '../../types/events'
import {
  cleanSet,
  eventsOfKind,
  faultTypes,
  FRAME_INTERVAL_MS,
  heldSagFrames,
  pikingSet,
  runPipeline,
  saggingSet,
  sideViewPose,
} from './fixtures'

const straight: PoseAngles = {
  side: 'left',
  elbow: 178,
  bodyLine: 180,
  hipDeviation: 0,
  neck: 175,
  flare: 40,
}

/** Feed the same candidate repeatedly and collect whatever the gate lets through. */
function pump(candidates: readonly FaultCandidate[], frames: number, startAt = 0) {
  let state: GateState = createGateState()
  const events = []
  for (let i = 0; i < frames; i += 1) {
    const result = gate(state, { candidates, t: startAt + i * FRAME_INTERVAL_MS })
    state = result.state
    events.push(...result.events)
  }
  return { state, events }
}

const sagCandidate: FaultCandidate = { fault: 'sagging_hips', severity: 'major', valueDeg: 22 }

describe('severityFor', () => {
  it('escalates with degrees past the threshold', () => {
    expect(severityFor(0)).toBe('minor')
    expect(severityFor(FAULT_THRESHOLDS.severityBands.majorAtDeg - 0.1)).toBe('minor')
    expect(severityFor(FAULT_THRESHOLDS.severityBands.majorAtDeg)).toBe('major')
    expect(severityFor(FAULT_THRESHOLDS.severityBands.severeAtDeg)).toBe('severe')
    expect(severityFor(100)).toBe('severe')
  })

  it('accepts per-fault bands', () => {
    const bands = { majorAtDeg: 50, severeAtDeg: 90 }
    expect(severityFor(20, bands)).toBe('minor')
    expect(severityFor(60, bands)).toBe('major')
  })
})

describe('evaluateFaults', () => {
  it('finds nothing wrong with a straight plank', () => {
    expect(evaluateFaults({ angles: straight, phase: 'top', view: 'side', inFrame: true })).toEqual([])
  })

  it('reports sag and pike from the SIGN of hipDeviation, never from its magnitude', () => {
    const sag = evaluateFaults({
      angles: { ...straight, hipDeviation: 25 },
      phase: 'top',
      view: 'side',
      inFrame: true,
    })
    const pike = evaluateFaults({
      angles: { ...straight, hipDeviation: -25 },
      phase: 'top',
      view: 'side',
      inFrame: true,
    })
    expect(sag.map((c) => c.fault)).toEqual(['sagging_hips'])
    expect(pike.map((c) => c.fault)).toEqual(['piked_hips'])
    // Both report a positive magnitude, so the event line never prints "-25deg".
    expect(sag[0]!.valueDeg).toBeGreaterThan(0)
    expect(pike[0]!.valueDeg).toBeGreaterThan(0)
  })

  it('cannot report both sag and pike at once', () => {
    for (const deviation of [-40, -13, 0, 13, 40]) {
      const faults = evaluateFaults({
        angles: { ...straight, hipDeviation: deviation },
        phase: 'top',
        view: 'side',
        inFrame: true,
      }).map((c) => c.fault)
      expect(faults.includes('sagging_hips') && faults.includes('piked_hips')).toBe(false)
    }
  })

  it('suppresses front-only faults in a side view and vice versa', () => {
    const flared: PoseAngles = { ...straight, flare: 85 }
    const fromSide = evaluateFaults({ angles: flared, phase: 'top', view: 'side', inFrame: true })
    const fromFront = evaluateFaults({ angles: flared, phase: 'top', view: 'front', inFrame: true })
    expect(fromSide.map((c) => c.fault)).not.toContain('flared_elbows')
    expect(fromFront.map((c) => c.fault)).toContain('flared_elbows')

    // The reverse direction: a sag is only trustworthy from the side.
    const sagging: PoseAngles = { ...straight, hipDeviation: 25 }
    expect(
      evaluateFaults({ angles: sagging, phase: 'top', view: 'front', inFrame: true }).map((c) => c.fault),
    ).not.toContain('sagging_hips')
  })

  it('only looks for lockout at the top of a rep', () => {
    const bent: PoseAngles = { ...straight, elbow: 130 }
    expect(
      evaluateFaults({ angles: bent, phase: 'top', view: 'side', inFrame: true }).map((c) => c.fault),
    ).toContain('no_lockout')
    expect(
      evaluateFaults({ angles: bent, phase: 'bottom', view: 'side', inFrame: true }).map((c) => c.fault),
    ).toEqual([])
  })

  it('stays silent when the body is not measurable', () => {
    const bad: PoseAngles = { ...straight, hipDeviation: 40, neck: 90 }
    expect(evaluateFaults({ angles: bad, phase: 'top', view: 'side', inFrame: false })).toEqual([])
  })

  it('skips nullable angles rather than treating them as zero', () => {
    const noNeck: PoseAngles = { ...straight, neck: null, flare: null }
    expect(evaluateFaults({ angles: noNeck, phase: 'top', view: 'front', inFrame: true })).toEqual([])
  })
})

describe('evaluateRepFaults', () => {
  const rep: RepMetrics = {
    index: 1,
    minElbowAngle: 98,
    maxElbowAngle: 176,
    depthPct: 77.5,
    hipDeviationDeg: 2,
    descentMs: 500,
    ascentMs: 400,
    partial: true,
    clean: false,
  }

  it('flags a short rep', () => {
    const faults = evaluateRepFaults(rep, 'side')
    expect(faults.map((c) => c.fault)).toEqual(['partial_depth'])
    expect(faults[0]!.severity).not.toBe('minor')
  })

  it('says nothing about a full-depth rep', () => {
    expect(evaluateRepFaults({ ...rep, partial: false }, 'side')).toEqual([])
  })

  it('respects view reliability', () => {
    expect(evaluateRepFaults(rep, 'front')).toEqual([])
  })
})

describe('the gate: persistence', () => {
  it('ignores a fault that has not held long enough', () => {
    const { required } = persistenceFor('sagging_hips')
    expect(pump([sagCandidate], required - 1).events).toHaveLength(0)
  })

  it('fires once the fault has held its required frames', () => {
    const { required } = persistenceFor('sagging_hips')
    const { events } = pump([sagCandidate], required)
    expect(events).toHaveLength(1)
    expect(eventsOfKind(events, 'form_fault')[0]!.heldFrames).toBe(required)
  })

  it('demands a much longer hold for no_lockout, because every descent looks like one', () => {
    const lockout = persistenceFor('no_lockout')
    expect(lockout.required).toBeGreaterThan(persistenceFor('sagging_hips').required)
    const candidate: FaultCandidate = { fault: 'no_lockout', severity: 'major', valueDeg: 130 }
    expect(pump([candidate], lockout.required - 1).events).toHaveLength(0)
    expect(pump([candidate], lockout.required).events).toHaveLength(1)
  })

  it('lets per-rep faults through immediately, since the rep was the evidence', () => {
    const candidate: FaultCandidate = { fault: 'partial_depth', severity: 'major', heldFrames: 1 }
    const result = gate(createGateState(), { candidates: [candidate], t: 0, mode: 'immediate' })
    expect(result.events).toHaveLength(1)
  })
})

describe('the gate: throttling', () => {
  it('turns 100 consecutive sagging frames into a handful of utterances', () => {
    const { events } = pump([sagCandidate], 100)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.length).toBeLessThan(5)
    // 100 frames at 30fps is 3.3s; the 4s per-fault cooldown should allow exactly one.
    expect(events.length * 20).toBeLessThan(100)
  })

  it('holds the same fault for its cooldown, then allows it again', () => {
    let state = createGateState()
    const fire = (t: number) => {
      const result = gate(state, { candidates: [sagCandidate], t })
      state = result.state
      return result.events.length
    }
    // Warm the persistence window.
    for (let i = 0; i < persistenceFor('sagging_hips').required - 1; i += 1) fire(i)
    expect(fire(1000)).toBe(1)
    expect(fire(1000 + GATE_CONFIG.perFaultCooldownMs - 1)).toBe(0)
    expect(fire(1000 + GATE_CONFIG.perFaultCooldownMs)).toBe(1)
  })

  it('emits at most one fault per frame even with several candidates', () => {
    const many: FaultCandidate[] = [
      { fault: 'sagging_hips', severity: 'minor', valueDeg: 13 },
      { fault: 'craned_neck', severity: 'severe', valueDeg: 110 },
    ]
    const { events } = pump(many, persistenceFor('sagging_hips').required)
    expect(events).toHaveLength(1)
    // Highest severity wins.
    expect(eventsOfKind(events, 'form_fault')[0]!.fault).toBe('craned_neck')
  })
})

describe('the gate: severity pre-emption', () => {
  it('lets a severe fault interrupt a routine rep callout', () => {
    const spoken = noteUtterance(createGateState(), 1000, UTTERANCE_RANK.routine)
    expect(canSpeak(spoken, 1100, UTTERANCE_RANK.severe)).toBe(true)
  })

  it('does not let a routine callout interrupt a severe fault', () => {
    const spoken = noteUtterance(createGateState(), 1000, UTTERANCE_RANK.severe)
    expect(canSpeak(spoken, 1100, UTTERANCE_RANK.routine)).toBe(false)
    expect(canSpeak(spoken, 1100, UTTERANCE_RANK.minor)).toBe(false)
  })

  it('opens the bucket again once the global interval has passed', () => {
    const spoken = noteUtterance(createGateState(), 1000, UTTERANCE_RANK.severe)
    expect(canSpeak(spoken, 1000 + GATE_CONFIG.globalIntervalMs, UTTERANCE_RANK.routine)).toBe(true)
  })

  it('speaks freely before anything has been said', () => {
    expect(canSpeak(createGateState(), 0, UTTERANCE_RANK.routine)).toBe(true)
  })
})

describe('the gate: purity', () => {
  it('never mutates the state or the history arrays it was given', () => {
    const before = createGateState()
    const once = gate(before, { candidates: [sagCandidate], t: 0 })
    const snapshot = JSON.stringify(once.state)
    gate(once.state, { candidates: [sagCandidate], t: FRAME_INTERVAL_MS })
    expect(JSON.stringify(once.state)).toBe(snapshot)
    expect(before.history).toEqual({})
  })

  it('reports active faults even while a cooldown keeps the coach quiet', () => {
    const { required } = persistenceFor('sagging_hips')
    let state = createGateState()
    let last = gate(state, { candidates: [sagCandidate], t: 0 })
    for (let i = 1; i <= required; i += 1) {
      state = last.state
      last = gate(state, { candidates: [sagCandidate], t: i * FRAME_INTERVAL_MS })
    }
    // Cooldown is active now, but the on-screen badge must stay lit.
    expect(last.events).toHaveLength(0)
    expect(last.active).toContain('sagging_hips')
  })
})

describe('end-to-end over fixtures', () => {
  it('says nothing at all about a clean set', () => {
    const run = runPipeline(cleanSet(10))
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(10)
    expect(eventsOfKind(run.events, 'form_fault')).toHaveLength(0)
  })

  it('reports sagging_hips and NEVER piked_hips on a sagging set', () => {
    // The sign-convention regression test. Getting hipDeviation backwards produces a
    // coach that tells a sagging user to lower their hips.
    const run = runPipeline(saggingSet(6))
    const faults = faultTypes(run.events)
    expect(faults).toContain('sagging_hips')
    expect(faults).not.toContain('piked_hips')
    expect(eventsOfKind(run.events, 'rep_completed')).toHaveLength(6)
  })

  it('reports piked_hips and NEVER sagging_hips on a piking set', () => {
    const faults = faultTypes(runPipeline(pikingSet(6)).events)
    expect(faults).toContain('piked_hips')
    expect(faults).not.toContain('sagging_hips')
  })

  it('mentions a sag at most once per cooldown, even across six sagging reps', () => {
    // 6 reps is ~4.7s of wall clock and the per-fault cooldown is 4s, so one utterance
    // is the correct answer here — not a sign the fault was missed.
    const sagging = eventsOfKind(runPipeline(saggingSet(6)).events, 'form_fault').filter(
      (e) => e.fault === 'sagging_hips',
    )
    expect(sagging).toHaveLength(1)
  })

  it('escalates severity as the sag gets worse over a longer set', () => {
    const sagging = eventsOfKind(runPipeline(saggingSet(12)).events, 'form_fault').filter(
      (e) => e.fault === 'sagging_hips',
    )
    expect(sagging.length).toBeGreaterThan(1)
    const ranks = sagging.map((e) => UTTERANCE_RANK[e.severity])
    expect(Math.max(...ranks)).toBeGreaterThan(Math.min(...ranks))

    // And every utterance is spaced by at least the per-fault cooldown.
    for (let i = 1; i < sagging.length; i += 1) {
      expect(sagging[i]!.at - sagging[i - 1]!.at).toBeGreaterThanOrEqual(GATE_CONFIG.perFaultCooldownMs)
    }
  })

  it('escalates candidate severity with the size of the deviation', () => {
    const severityAt = (deviation: number) =>
      evaluateFaults({
        angles: { ...straight, hipDeviation: deviation },
        phase: 'top',
        view: 'side',
        inFrame: true,
      })[0]?.severity
    expect(severityAt(13)).toBe('minor')
    expect(severityAt(20)).toBe('major')
    expect(severityAt(30)).toBe('severe')
  })

  it('does not mistake a normal descent for a failure to lock out', () => {
    expect(faultTypes(runPipeline(cleanSet(10)).events)).not.toContain('no_lockout')
  })

  it('does catch a genuinely un-locked top', () => {
    // 60 frames hovering at 135 degrees without ever straightening up.
    const frames = Array.from({ length: 60 }, (_, i) => ({
      landmarks: sideViewPose(135),
      t: i * FRAME_INTERVAL_MS,
    }))
    expect(faultTypes(runPipeline(frames).events)).toContain('no_lockout')
  })

  it('throttles a long static sag rather than narrating every frame', () => {
    const frames = heldSagFrames(100, 0.05)
    const faults = eventsOfKind(runPipeline(frames).events, 'form_fault')
    expect(faults.length).toBeGreaterThanOrEqual(1)
    expect(faults.length).toBeLessThan(5)
  })
})
