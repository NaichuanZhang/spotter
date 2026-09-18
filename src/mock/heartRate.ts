/**
 * Simulated heart rate, driven by the REAL rep tempo the pose engine measures.
 *
 * Why a first-order lag instead of random numbers: a real heart accelerates fast
 * and recovers slowly, so the asymmetric time constants are what make the number
 * feel alive on screen. Fake randomness reads as fake immediately — it jitters
 * without ever trending.
 *
 * Everything here is pure. `step()` returns a NEW state; nothing is mutated, so the
 * UI can hold old snapshots and the whole thing is trivially testable.
 *
 * It is a simulation and says so: every result carries `simulated: true`.
 */

import type { GetHeartRateResult } from '../types/tools'

export type HeartRateZone = GetHeartRateResult['zone']
export type HeartRateTrend = GetHeartRateResult['trend']

/** One place to retune the whole simulation. */
export const HR_CONFIG = {
  restBpm: 64,
  /** Plausible ceiling for a fit adult; the lag is clamped to this. */
  maxBpm: 186,
  /** Each rep per minute of sustained work demands this many extra bpm. */
  bpmPerRepPerMinute: 3.2,
  /** Effort alone lifts demand this much the moment a set starts. */
  activationBpm: 14,
  /** Fast rise: ~6s to reach 63% of a step up in demand. */
  riseTauMs: 6_000,
  /** Slow decay: recovery takes far longer than the climb. */
  decayTauMs: 22_000,
  /** Respiratory sinus arrhythmia — the small breathing wobble. */
  wobbleAmpBpm: 1.8,
  wobbleHz: 0.28,
  /** A move of at least this much per second counts as rising / falling. */
  trendBpmPerSec: 0.35,
  /** Tab-away produces huge dt; clamp so one step cannot teleport the curve. */
  maxStepMs: 4_000,
  /** Zone edges as a fraction of maxBpm (standard %HRmax bands). */
  zones: { warmup: 0.5, aerobic: 0.6, threshold: 0.8, max: 0.9 },
} as const

export interface HeartRateState {
  /** The lagged value without the breathing wobble. Drives the physics. */
  readonly baseBpm: number
  /** What to show: baseBpm plus wobble. Never fed back into the lag. */
  readonly bpm: number
  /** Where the lag is heading given the current work rate. */
  readonly demandBpm: number
  /** Wobble oscillator phase, radians. */
  readonly phase: number
  /** Signed slope of baseBpm, bpm per second. */
  readonly slope: number
}

export function createHeartRateState(restBpm: number = HR_CONFIG.restBpm): HeartRateState {
  const base = clamp(restBpm, HR_CONFIG.restBpm * 0.6, HR_CONFIG.maxBpm)
  return Object.freeze({ baseBpm: base, bpm: base, demandBpm: base, phase: 0, slope: 0 })
}

/**
 * Advance the simulation.
 *
 * @param dtMs             elapsed wall time since the last step
 * @param repsInLastMinute measured rep rate; 0 while resting
 */
export function step(state: HeartRateState, dtMs: number, repsInLastMinute: number): HeartRateState {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return state
  const dt = Math.min(dtMs, HR_CONFIG.maxStepMs)
  const reps = Number.isFinite(repsInLastMinute) ? Math.max(0, repsInLastMinute) : 0

  const demandBpm = demandFor(reps)
  // Exponential approach: correct for any dt, and asymmetric because a heart
  // climbs much faster than it recovers.
  const tau = demandBpm > state.baseBpm ? HR_CONFIG.riseTauMs : HR_CONFIG.decayTauMs
  const alpha = 1 - Math.exp(-dt / tau)
  const baseBpm = clamp(
    state.baseBpm + (demandBpm - state.baseBpm) * alpha,
    HR_CONFIG.restBpm * 0.6,
    HR_CONFIG.maxBpm,
  )

  const dtSec = dt / 1000
  const phase = wrapPhase(state.phase + 2 * Math.PI * HR_CONFIG.wobbleHz * dtSec)
  const bpm = clamp(
    baseBpm + Math.sin(phase) * HR_CONFIG.wobbleAmpBpm,
    HR_CONFIG.restBpm * 0.6,
    HR_CONFIG.maxBpm,
  )

  return Object.freeze({
    baseBpm,
    bpm,
    demandBpm,
    phase,
    slope: (baseBpm - state.baseBpm) / dtSec,
  })
}

/** Steady-state heart rate for a given work rate. */
export function demandFor(repsInLastMinute: number): number {
  if (repsInLastMinute <= 0) return HR_CONFIG.restBpm
  const demand =
    HR_CONFIG.restBpm + HR_CONFIG.activationBpm + repsInLastMinute * HR_CONFIG.bpmPerRepPerMinute
  return Math.min(demand, HR_CONFIG.maxBpm)
}

export function zoneOf(bpm: number): HeartRateZone {
  const fraction = bpm / HR_CONFIG.maxBpm
  const { zones } = HR_CONFIG
  if (fraction >= zones.max) return 'max'
  if (fraction >= zones.threshold) return 'threshold'
  if (fraction >= zones.aerobic) return 'aerobic'
  if (fraction >= zones.warmup) return 'warmup'
  return 'rest'
}

export function trendOf(state: HeartRateState): HeartRateTrend {
  if (state.slope > HR_CONFIG.trendBpmPerSec) return 'rising'
  if (state.slope < -HR_CONFIG.trendBpmPerSec) return 'falling'
  return 'steady'
}

/** Exactly the shape get_heart_rate hands back to the model. */
export function toHeartRateResult(state: HeartRateState): GetHeartRateResult {
  return {
    bpm: Math.round(state.bpm),
    zone: zoneOf(state.bpm),
    trend: trendOf(state),
    simulated: true,
  }
}

/**
 * Rep rate from the timestamps the pose engine already produces. Extrapolates a
 * short set so the first few reps still move the needle: three reps in the last
 * ten seconds reads as eighteen per minute, not three.
 */
export function repsPerMinute(
  repTimestamps: readonly number[],
  now: number,
  windowMs = 60_000,
  minWindowMs = 12_000,
): number {
  if (repTimestamps.length === 0) return 0
  const cutoff = now - windowMs
  const recent = repTimestamps.filter((at) => at > cutoff && at <= now)
  if (recent.length === 0) return 0
  const oldest = Math.min(...recent)
  const span = Math.max(now - oldest, minWindowMs)
  return (recent.length * 60_000) / span
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function wrapPhase(phase: number): number {
  const twoPi = 2 * Math.PI
  return phase - twoPi * Math.floor(phase / twoPi)
}
