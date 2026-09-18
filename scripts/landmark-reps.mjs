/**
 * Segmentation and rep counting for the offline reference-motion extractor: a faithful
 * port of the two-state hysteresis in src/pose/repMachine.ts, plus the shot-boundary
 * logic a recorded video needs and a live camera does not. Pure functions.
 *
 * TWO THINGS A VIDEO NEEDS THAT A CAMERA DOES NOT:
 *
 *   1. SEGMENTS. Frames where the detector found no pose, and hard cuts between shots,
 *      split the timeline. The machine RESETS per segment — otherwise a cutaway between
 *      a descent and an ascent welds into one phantom rep, and the "top of rep" elbow
 *      angle gets inherited from a different shot, reporting a lockout that the
 *      demonstrator never performed.
 *   2. A SECOND, LOWER LOCKOUT THRESHOLD (`RELAXED`). The app scores a rep only when
 *      the elbow returns above `upEnterDeg`; a demonstrator who holds tension and never
 *      straightens produces real reps the app would not count. Callers run BOTH passes
 *      and report both counts, so nobody can mistake one for the other.
 *
 * All app thresholds are injected (`tunables.rep`), never re-typed.
 *
 * TUNABLES LIVE IN: the caller (mirrored from src/pose) plus `RELAXED` (this file).
 */

import { X, Y } from './landmark-geometry.mjs'

// ------------------------------------------------------------------- tunables

export const RELAXED = Object.freeze({
  /**
   * Lockout threshold for the pass the exemplar comes from. The app uses 155deg; a
   * demonstrator in an instructional clip commonly tops out around 125-140deg. 120
   * sits below every observed top and 20deg above the app's `downEnterDeg`, so the
   * gap is still wider than the median filter's residual noise — but it IS narrower
   * than the app's 55deg gap, which is why `minAmplitudeDeg` and `minRepFrames` back
   * it up instead of trusting hysteresis alone.
   */
  upEnterDeg: 120,
  /** A cycle whose elbow swing is smaller than this is dither, not a rep. */
  minAmplitudeDeg: 30,
  /** ...and one shorter than this is a twitch. 8 frames = 0.27s at 30fps. */
  minRepFrames: 8,
})
// ---------------------------------------------------------------- segmentation

/**
 * Landmarks a CAMERA CUT moves and a limb glitch does not: head and torso. Wrists and
 * elbows are excluded on purpose — MediaPipe flips those onto the far arm for a frame
 * or two, and treating that as a cut would fragment a perfectly good rep.
 */
const CUT_ANCHORS = Object.freeze([0, 11, 12, 23, 24])

/** Shoulder->hip length on the measured side: the scale unit that is always in frame. */
function torsoSpan(frame) {
  const shoulder = frame.lm[frame.joints.shoulder]
  const hip = frame.lm[frame.joints.hip]
  return Math.hypot(hip[X] - shoulder[X], hip[Y] - shoulder[Y])
}

/**
 * Is the step from `previous` to `current` a discontinuity rather than motion?
 * Either the detector lost the pose in between (a frame gap) or the whole torso
 * teleported, which means the editor cut to another shot.
 */
function boundaryBetween(previous, current, extraction) {
  if (current.i - previous.i > extraction.maxFrameGap) return 'gap'
  const scale = (torsoSpan(previous) + torsoSpan(current)) / 2
  // No torso length means no way to judge; start a new run rather than guess.
  if (!(scale > 0)) return 'cut'
  const jump = Math.max(...CUT_ANCHORS.map((index) => Math.hypot(
    current.lm[index][X] - previous.lm[index][X],
    current.lm[index][Y] - previous.lm[index][Y],
  ))) / scale
  return jump > extraction.cutJumpBodyLengths ? 'cut' : null
}

/**
 * Split usable frames into runs of continuous motion, and RESET the rep machine per
 * run. Without this, a talking-head cutaway between a descent and an ascent welds into
 * one phantom rep, and the "top of rep" elbow angle can be inherited from a completely
 * different shot — which would report a lockout that the demonstrator never performed.
 */
export function splitSegments(frames, extraction) {
  const grouped = frames.reduce((acc, frame) => {
    const current = acc.runs[acc.runs.length - 1]
    const boundary = current ? boundaryBetween(current[current.length - 1], frame, extraction) : 'start'
    if (!boundary) {
      return { runs: [...acc.runs.slice(0, -1), [...current, frame]], reasons: acc.reasons }
    }
    return { runs: [...acc.runs, [frame]], reasons: [...acc.reasons, boundary] }
  }, { runs: [], reasons: [] })

  const keep = grouped.runs
    .map((run, index) => ({ run, startedBy: grouped.reasons[index] }))
    .filter((entry) => entry.run.length >= extraction.minSegmentFrames)
  return { segments: keep.map((entry) => entry.run), startedBy: keep.map((entry) => entry.startedBy) }
}

// ---------------------------------------------------------------- rep machine

function emptyRepState() {
  return {
    phase: 'top',
    armed: false,
    lastElbow: null,
    lastT: null,
    lastPos: null,
    descentStartedAt: null,
    descentStartPos: null,
    topMaxElbow: null,
    current: null,
  }
}

/** Port of `trackDescent`: below the threshold AND measurably falling. */
function trackDescent(state, sample, rep) {
  if (state.lastElbow === null) return { at: null, pos: null }
  const falling = sample.elbow < state.lastElbow - rep.descentNoiseDeg
  if (falling && sample.elbow < rep.descentStartDeg) {
    return {
      at: state.descentStartedAt ?? state.lastT ?? sample.t,
      pos: state.descentStartPos ?? state.lastPos ?? sample.pos,
    }
  }
  return falling
    ? { at: state.descentStartedAt, pos: state.descentStartPos }
    : { at: null, pos: null }
}

/**
 * Hip extremes, tracked ONLY over frames where the body line was measurable.
 *
 * Returns exactly the three hip keys and NOTHING else, even in the unmeasurable case.
 * It is spread over an already-updated accumulator, so returning the whole `acc` here
 * would silently roll back that frame's minElbow/maxElbow/frames — which is a rep
 * counter that reports the threshold-crossing angle as its depth, and every rep one
 * frame long.
 */
function foldHip(acc, hipDeviation) {
  if (hipDeviation === null) {
    return { worstSag: acc.worstSag, worstPike: acc.worstPike, hipFrames: acc.hipFrames }
  }
  return {
    worstSag: Math.max(acc.worstSag ?? 0, hipDeviation),
    worstPike: Math.min(acc.worstPike ?? 0, hipDeviation),
    hipFrames: acc.hipFrames + 1,
  }
}

function openAccumulator(state, sample) {
  return {
    startedAt: state.descentStartedAt ?? state.lastT ?? sample.t,
    startPos: state.descentStartPos ?? state.lastPos ?? sample.pos,
    minElbow: sample.elbow,
    minElbowAt: sample.t,
    minElbowPos: sample.pos,
    maxElbow: Math.max(state.topMaxElbow ?? sample.elbow, sample.elbow),
    frames: 1,
    ...foldHip({ worstSag: null, worstPike: null, hipFrames: 0 }, sample.hipDeviation),
  }
}

function accumulate(acc, sample) {
  const deeper = sample.elbow < acc.minElbow
  return {
    ...acc,
    minElbow: deeper ? sample.elbow : acc.minElbow,
    minElbowAt: deeper ? sample.t : acc.minElbowAt,
    minElbowPos: deeper ? sample.pos : acc.minElbowPos,
    maxElbow: Math.max(acc.maxElbow, sample.elbow),
    frames: acc.frames + 1,
    ...foldHip(acc, sample.hipDeviation),
  }
}

/**
 * Ports `depthPct`, `worstDeviation` and the `partial`/`clean` rules. `clean` is NULL,
 * not false, when no frame of the rep had a measurable body line: "we could not see"
 * is a third answer and collapsing it into "not clean" would be a lie in either
 * direction.
 */
function toRepMetrics(acc, endSample, rep) {
  const measured = acc.hipFrames > 0
  const deviation = measured
    ? (Math.abs(acc.worstSag) >= Math.abs(acc.worstPike) ? acc.worstSag : acc.worstPike)
    : null
  const pct = ((rep.depthZeroDeg - acc.minElbow) / (rep.depthZeroDeg - rep.depthFullDeg)) * 100
  const partial = acc.minElbow > rep.partialAboveDeg
  return {
    startPos: acc.startPos,
    bottomPos: acc.minElbowPos,
    endPos: endSample.pos,
    startT: acc.startedAt,
    bottomT: acc.minElbowAt,
    endT: endSample.t,
    minElbowAngle: acc.minElbow,
    maxElbowAngle: acc.maxElbow,
    amplitudeDeg: acc.maxElbow - acc.minElbow,
    depthPct: pct < 0 ? 0 : pct > 100 ? 100 : pct,
    bodyLineMeasurable: measured,
    hipFrames: acc.hipFrames,
    hipDeviationDeg: deviation,
    worstSag: measured ? acc.worstSag : null,
    worstPike: measured ? acc.worstPike : null,
    descentMs: Math.max(0, (acc.minElbowAt - acc.startedAt) * 1000),
    ascentMs: Math.max(0, (endSample.t - acc.minElbowAt) * 1000),
    frameCount: acc.frames,
    partial,
    meetsAppLockout: acc.maxElbow > rep.upEnterDeg,
    clean: measured ? (!partial && Math.abs(deviation) < rep.cleanHipDeviationDeg) : null,
  }
}

/** One frame through the two-state hysteresis. Port of `step` in repMachine.ts. */
function stepRep(state, sample, rep, upEnterDeg) {
  const tail = { lastElbow: sample.elbow, lastT: sample.t, lastPos: sample.pos }
  if (state.phase === 'top') {
    const armed = state.armed || sample.elbow >= upEnterDeg
    const descent = trackDescent(state, sample, rep)
    const tracked = {
      ...state,
      armed,
      topMaxElbow: Math.max(state.topMaxElbow ?? sample.elbow, sample.elbow),
      descentStartedAt: descent.at,
      descentStartPos: descent.pos,
    }
    if (armed && sample.elbow < rep.downEnterDeg) {
      return {
        state: {
          ...tracked, ...tail,
          phase: 'bottom',
          current: openAccumulator(tracked, sample),
          descentStartedAt: null,
          descentStartPos: null,
        },
        rep: null,
      }
    }
    return { state: { ...tracked, ...tail }, rep: null }
  }

  const acc = accumulate(state.current ?? openAccumulator(state, sample), sample)
  if (sample.elbow <= upEnterDeg) {
    return { state: { ...state, ...tail, current: acc }, rep: null }
  }
  return {
    state: {
      ...state, ...tail,
      phase: 'top',
      current: null,
      topMaxElbow: sample.elbow,
      descentStartedAt: null,
      descentStartPos: null,
    },
    rep: toRepMetrics(acc, sample, rep),
  }
}

/**
 * Run the hysteresis across every segment. `guards` (relaxed pass only) rejects
 * cycles too small or too short to be a rep — the app needs no such guard because its
 * 55deg threshold gap already provides it; a narrower gap does not.
 */
export function detectReps(segments, smoothedPerSegment, tunables, { upEnterDeg, guards }) {
  return segments.reduce((outer, segment, segmentIndex) => {
    const smoothed = smoothedPerSegment[segmentIndex]
    const pass = segment.reduce((acc, frame, pos) => {
      const s = smoothed[pos]
      if (s.elbow === null) return acc
      const sample = { elbow: s.elbow, hipDeviation: s.hipDeviation, t: frame.t, pos }
      const stepped = stepRep(acc.machine, sample, tunables.rep, upEnterDeg)
      if (!stepped.rep) return { ...acc, machine: stepped.state }
      const rejected = guards && (
        stepped.rep.amplitudeDeg < guards.minAmplitudeDeg ||
        stepped.rep.frameCount < guards.minRepFrames
      )
      return {
        machine: stepped.state,
        reps: rejected ? acc.reps : [...acc.reps, stepped.rep],
        rejected: acc.rejected + (rejected ? 1 : 0),
      }
    }, { machine: emptyRepState(), reps: [], rejected: 0 })

    return {
      reps: [...outer.reps, ...pass.reps.map((rep) => ({ rep, segmentIndex, segment }))],
      rejected: outer.rejected + pass.rejected,
    }
  }, { reps: [], rejected: 0 })
}

