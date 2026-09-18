import { describe, expect, it } from 'vitest'
import {
  createHeartRateState,
  demandFor,
  HR_CONFIG,
  repsPerMinute,
  step,
  toHeartRateResult,
  trendOf,
  zoneOf,
} from '../heartRate'

/** Advance the simulation by `seconds` at a fixed work rate, 200ms per tick (the App poll rate). */
function run(seconds: number, repsPerMin: number, from = createHeartRateState()) {
  const tickMs = 200
  let state = from
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += tickMs) {
    state = step(state, tickMs, repsPerMin)
  }
  return state
}

describe('repsPerMinute — the clock-domain contract', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The pose engine stamps every `CoachEvent.at` with `performance.now()` (ms since
   * page load). `repsPerMinute` is clock-agnostic — it only ever subtracts — so it is
   * correct for ANY single domain but silently returns 0 when the caller mixes two.
   * App.tsx feeds it `event.at` values, so App's tick clock MUST be performance.now().
   * Both clocks are plain `number`, so nothing in the type system guards this.
   */
  it('returns 0 when performance.now() timestamps are compared against a Date.now() clock', () => {
    const repsAt = [30_000, 32_500, 35_000] // performance.now() domain
    const epochNow = 1_790_000_000_000 // Date.now() domain

    expect(repsPerMinute(repsAt, epochNow)).toBe(0)
  })

  it('reports a real rate once both sides share the performance.now() domain', () => {
    const repsAt = [30_000, 32_500, 35_000]
    const monotonicNow = 36_000

    expect(repsPerMinute(repsAt, monotonicNow)).toBeGreaterThan(0)
  })

  it('extrapolates a short set instead of under-reading it', () => {
    // 3 reps inside the 12s minimum window reads as 15/min, not 3/min.
    expect(repsPerMinute([1_000, 3_000, 5_000], 6_000)).toBeCloseTo(15, 5)
  })

  it('ignores reps older than the window and reps in the future', () => {
    expect(repsPerMinute([1_000], 100_000)).toBe(0)
    expect(repsPerMinute([50_000], 10_000)).toBe(0)
    expect(repsPerMinute([], 10_000)).toBe(0)
  })
})

describe('the heart rate curve', () => {
  it('rises under sustained work and stays at rest without it', () => {
    const resting = run(60, 0)
    expect(resting.baseBpm).toBeCloseTo(HR_CONFIG.restBpm, 5)

    const working = run(60, 20)
    expect(working.baseBpm).toBeGreaterThan(HR_CONFIG.restBpm + 20)
    expect(working.baseBpm).toBeLessThanOrEqual(HR_CONFIG.maxBpm)
  })

  it('recovers more slowly than it climbs — the asymmetric time constants', () => {
    const rest = createHeartRateState()
    const climbed = run(20, 20, rest)
    const gained = climbed.baseBpm - rest.baseBpm

    const recovered = run(20, 0, climbed)
    const lost = climbed.baseBpm - recovered.baseBpm

    expect(gained).toBeGreaterThan(0)
    expect(lost).toBeGreaterThan(0)
    expect(lost).toBeLessThan(gained)
  })

  it('never exceeds maxBpm even at an absurd work rate', () => {
    expect(demandFor(10_000)).toBe(HR_CONFIG.maxBpm)
    expect(run(300, 10_000).bpm).toBeLessThanOrEqual(HR_CONFIG.maxBpm)
  })

  it('clamps a huge dt so one tab-away step cannot teleport the curve', () => {
    const once = step(createHeartRateState(), 10 * 60_000, 30)
    const capped = step(createHeartRateState(), HR_CONFIG.maxStepMs, 30)
    expect(once.baseBpm).toBeCloseTo(capped.baseBpm, 5)
  })

  it('ignores a non-advancing or non-finite dt rather than producing NaN', () => {
    const state = createHeartRateState()
    expect(step(state, 0, 20)).toBe(state)
    expect(step(state, -5, 20)).toBe(state)
    expect(step(state, Number.NaN, 20)).toBe(state)
  })

  it('treats a non-finite rep rate as rest instead of poisoning the curve', () => {
    const state = step(createHeartRateState(), 200, Number.NaN)
    expect(Number.isFinite(state.bpm)).toBe(true)
    expect(state.demandBpm).toBe(HR_CONFIG.restBpm)
  })

  it('does not mutate the state handed to it', () => {
    const before = createHeartRateState()
    const snapshot = { ...before }
    step(before, 1_000, 25)
    expect({ ...before }).toEqual(snapshot)
    expect(Object.isFrozen(before)).toBe(true)
  })
})

describe('zones, trend and the result shape', () => {
  it('maps bpm onto the standard %HRmax bands', () => {
    const { maxBpm, zones } = HR_CONFIG
    expect(zoneOf(maxBpm * 0.3)).toBe('rest')
    expect(zoneOf(maxBpm * zones.warmup)).toBe('warmup')
    expect(zoneOf(maxBpm * zones.aerobic)).toBe('aerobic')
    expect(zoneOf(maxBpm * zones.threshold)).toBe('threshold')
    expect(zoneOf(maxBpm * zones.max)).toBe('max')
  })

  it('reports rising while climbing and falling while recovering', () => {
    const climbing = step(createHeartRateState(), 1_000, 25)
    expect(trendOf(climbing)).toBe('rising')

    const recovering = step(run(30, 25), 1_000, 0)
    expect(trendOf(recovering)).toBe('falling')
    expect(trendOf(createHeartRateState())).toBe('steady')
  })

  it('always stamps simulated: true so the model cannot claim a real sensor', () => {
    const result = toHeartRateResult(run(30, 22))
    expect(result.simulated).toBe(true)
    expect(Number.isInteger(result.bpm)).toBe(true)
  })
})
