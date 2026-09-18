/**
 * Reference-motion analysis: raw per-frame landmarks in, segmented reps and one
 * normalised exemplar out. Pure functions — no fs, no network, no clock.
 * `scripts/extract-landmarks.mjs` owns all I/O and documents the output schema.
 *
 * Geometry lives in ./landmark-geometry.mjs, rep counting in ./landmark-reps.mjs; this
 * file picks the exemplar, normalises it for rendering, and serialises everything.
 *
 * COORDINATES: MediaPipe normalized image space, origin TOP-LEFT, **y grows DOWNWARD**.
 * Therefore a hip BELOW the shoulder->ankle line has the LARGER y and is a SAG, which
 * is POSITIVE. That sign is the single easiest thing in this codebase to invert.
 *
 * HONESTY RULES, in one place:
 *   - a frame with no pose, or with a core joint under the visibility gate, is DROPPED
 *     and counted — never interpolated, never zero-filled;
 *   - hip fields and `clean` are NULL when the ankle was off-frame. Null means "not
 *     seen", which is neither "fine" nor "bad";
 *   - the exemplar carries `compromises`: everything that had to be relaxed to find it;
 *   - suspect frames may be DROPPED from the ends of the exemplar, never replaced.
 *
 * TUNABLES LIVE IN: the caller (mirrored from src/pose), `GATE` (geometry),
 * `RELAXED` (reps) and `EXEMPLAR` (this file).
 */

import { GATE, medianOf, prepareFrame, smoothSegment, V, X, Y } from './landmark-geometry.mjs'
import { detectReps, RELAXED, splitSegments } from './landmark-reps.mjs'

// ------------------------------------------------------------------- tunables

export const EXEMPLAR = Object.freeze({
  /** Per depth percent. Depth is the headline property of a good rep. */
  depthWeight: 1,
  /** Per degree of |hip deviation|, when it is measurable at all. */
  hipPenaltyPerDeg: 4,
  /** Per degree of top-of-rep elbow extension above the app's `upEnterDeg`. */
  lockoutWeightPerDeg: 0.5,
  /** A rep shorter than this is not a demonstrable movement. ~0.33s at 30fps. */
  minFrames: 10,
  /**
   * Largest believable single-frame move of a core joint, in body-relative units
   * (1.0 = the normalisation `scaleBasis` length). Measured honest motion in this
   * source peaks at ~0.09 per frame; detector glitches land at 0.3-0.45. 0.15 sits
   * between the two. Used ONLY to trim the ends of the exemplar — see
   * `trimGlitchedEnds`.
   */
  maxJointJumpPerFrame: 0.15,
  /**
   * How many frames from each end `trimGlitchedEnds` is allowed to look at. Bounded so
   * a glitch in the MIDDLE of a rep can never cause the rep to be chopped in half:
   * outside this window a bad frame is reported, not removed. 4 frames = 0.13s.
   */
  maxTrimFrames: 4,
})

// ------------------------------------------------------------------- exemplar

function exemplarScore(rep, tunables) {
  const hipPenalty = rep.bodyLineMeasurable
    ? Math.abs(rep.hipDeviationDeg) * EXEMPLAR.hipPenaltyPerDeg
    : 0
  return (
    rep.depthPct * EXEMPLAR.depthWeight - hipPenalty +
    Math.max(0, rep.maxElbowAngle - tunables.rep.upEnterDeg) * EXEMPLAR.lockoutWeightPerDeg
  )
}

/**
 * Best rep, plus the list of requirements that had to be relaxed to find one. Tiers
 * are tried in order and the first non-empty one wins; `compromises` is what a
 * consumer must know before calling this clip "correct form". Returns null only when
 * there are no reps at all — it never invents one.
 */
function pickExemplar(reps, tunables) {
  const best = (pool) => pool.reduce(
    (top, rep) => (top === null || exemplarScore(rep, tunables) > exemplarScore(top, tunables) ? rep : top),
    null,
  )
  const long = reps.filter((rep) => rep.frameCount >= EXEMPLAR.minFrames)
  const tiers = [
    { pool: long.filter((r) => r.clean === true), compromises: [] },
    { pool: long.filter((r) => r.clean === null && !r.partial), compromises: ['body_line_unmeasurable'] },
    { pool: long.filter((r) => !r.partial), compromises: ['hip_deviation_over_clean_limit'] },
    { pool: long, compromises: ['partial_depth'] },
    { pool: reps, compromises: ['partial_depth', `under_${EXEMPLAR.minFrames}_frames`] },
  ]
  for (const tier of tiers) {
    const winner = best(tier.pool)
    if (!winner) continue
    const lockout = winner.meetsAppLockout ? [] : ['no_lockout_in_source']
    const body = winner.bodyLineMeasurable || tier.compromises.includes('body_line_unmeasurable')
      ? [] : ['body_line_unmeasurable']
    return { rep: winner, compromises: [...tier.compromises, ...body, ...lockout] }
  }
  return null
}

// -------------------------------------------------------------- normalisation

/**
 * One similarity transform for the WHOLE rep — never per-frame, which would cancel
 * the vertical travel that IS the pushup.
 *
 *   origin : the rep-median ground contact. Wrist+ankle midpoint when the ankle is
 *            observed, otherwise the wrist alone (the only contact actually in frame).
 *   unit   : the rep-median shoulder->ankle distance, or shoulder->hip when the ankle
 *            is not observed. `scaleBasis` says which, because 1.0 means a different
 *            body length in each case.
 *   facing : x is mirrored when needed so the head always points -x.
 * y still grows DOWNWARD afterwards, so sag is still +y. Do not "fix" that.
 */
function fitNormalisation(frames) {
  const joints = frames[0].joints
  const at = (frame, name) => frame.lm[joints[name]]
  const ankleSeen = frames.every((frame) => frame.bodyLineMeasurable)
  const anchorOf = (frame) => (ankleSeen
    ? [(at(frame, 'wrist')[X] + at(frame, 'ankle')[X]) / 2, (at(frame, 'wrist')[Y] + at(frame, 'ankle')[Y]) / 2]
    : [at(frame, 'wrist')[X], at(frame, 'wrist')[Y]])
  const far = ankleSeen ? 'ankle' : 'hip'

  const anchorX = medianOf(frames.map((frame) => anchorOf(frame)[X]))
  const anchorY = medianOf(frames.map((frame) => anchorOf(frame)[Y]))
  const scale = medianOf(frames.map((frame) => Math.hypot(
    at(frame, far)[X] - at(frame, 'shoulder')[X],
    at(frame, far)[Y] - at(frame, 'shoulder')[Y],
  )))
  const facing = medianOf(frames.map((frame) => at(frame, far)[X] - at(frame, 'shoulder')[X]))
  if (anchorX === null || anchorY === null || scale === null || !(scale > 0)) return null
  return {
    anchorX,
    anchorY,
    scale,
    flippedX: facing < 0,
    scaleBasis: `shoulder_${far}`,
    anchorBasis: ankleSeen ? 'wrist_ankle_midpoint' : 'wrist',
    measuredSide: frames[0].side,
    description:
      'x = sign*(x_img - anchorX)/scale, y = (y_img - anchorY)/scale; sign = -1 when flippedX. ' +
      'Origin is the rep-median ground contact, 1.0 is the rep-median scaleBasis length, ' +
      'the head points -x, and y still grows DOWNWARD (so sag is +y). ' +
      'Render with px = cx + x*S, py = cy + y*S.',
  }
}

/**
 * Frame-to-frame displacement of the worst core joint, in body-relative units.
 * `jumps[k]` is the step between frame k and frame k+1.
 */
function coreJumpSeries(frames, joints, scale) {
  return frames.slice(1).map((frame, k) => Math.max(...GATE.coreJoints.map((name) => {
    const previous = frames[k].lm[joints[name]]
    const current = frame.lm[joints[name]]
    return Math.hypot(current[X] - previous[X], current[Y] - previous[Y]) / scale
  })))
}

/**
 * Drop leading/trailing frames whose core joints teleport. MediaPipe occasionally
 * flips a wrist onto the far arm for a frame or two, and at the END of a rep that
 * glitch is what a looping renderer would snap through.
 *
 * ONLY THE ENDS, and only ever by DELETION — an interior glitch is left in place and
 * surfaced as `maxCoreJointJump` instead, because removing an interior frame would
 * silently compress time, and replacing one would be fabrication.
 */
function trimGlitchedEnds(frames, joints, scale) {
  const jumps = coreJumpSeries(frames, joints, scale)
  const limit = EXEMPLAR.maxJointJumpPerFrame
  // Bounded windows: a glitch two frames from the end must be cut, but a glitch in the
  // middle of the descent must NOT be allowed to eat half the rep.
  const window = Math.min(EXEMPLAR.maxTrimFrames, Math.max(0, jumps.length - 1))
  const offenders = jumps.map((jump, index) => (jump > limit ? index : -1)).filter((i) => i >= 0)

  const leadingHits = offenders.filter((index) => index < window)
  const trailingHits = offenders.filter((index) => index >= jumps.length - window)
  // jumps[i] spans frames i -> i+1, so cutting at i keeps frame i on the leading side
  // and discards everything after it on the trailing side.
  const start = leadingHits.length > 0 ? Math.max(...leadingHits) + 1 : 0
  const end = trailingHits.length > 0 ? Math.min(...trailingHits) : frames.length - 1

  const inside = jumps.slice(start, Math.max(start, end))
  return {
    frames: frames.slice(start, end + 1),
    leading: start,
    trailing: frames.length - 1 - end,
    maxCoreJointJump: inside.length > 0 ? Math.max(...inside) : 0,
    limit,
  }
}

function normaliseFrames(frames, fit, span, round, decimals) {
  const sign = fit.flippedX ? -1 : 1
  const startT = span.startT
  const duration = Math.max(1e-9, span.endT - startT)
  return frames.map((frame) => ({
    phase: round((frame.t - startT) / duration, 4),
    tMs: round((frame.t - startT) * 1000, 1),
    i: frame.i,
    weak: frame.weak,
    angles: {
      elbow: round(frame.angles.elbow, decimals.angle),
      bodyLine: round(frame.angles.bodyLine, decimals.angle),
      hipDeviation: round(frame.angles.hipDeviation, decimals.angle),
      neck: round(frame.angles.neck, decimals.angle),
      flare: round(frame.angles.flare, decimals.angle),
    },
    lm: frame.lm.map((point) => [
      round((sign * (point[X] - fit.anchorX)) / fit.scale, decimals.xy),
      round((point[Y] - fit.anchorY) / fit.scale, decimals.xy),
      round(point[V], decimals.visibility),
    ]),
  }))
}

// ------------------------------------------------------------- serialisation

/**
 * `z` is deliberately DROPPED. It is hip-relative, an order of magnitude noisier than
 * x/y, useless for a horizontal body, and nothing in the app reads it — shipping it
 * would only invite someone to draw with it.
 */
function serialiseFrame(frame, smoothed, round, decimals) {
  return {
    i: frame.i,
    t: round(frame.t, decimals.time),
    side: frame.side,
    bodyLineMeasurable: frame.bodyLineMeasurable,
    weak: frame.weak,
    angles: {
      elbow: round(frame.angles.elbow, decimals.angle),
      bodyLine: round(frame.angles.bodyLine, decimals.angle),
      hipDeviation: round(frame.angles.hipDeviation, decimals.angle),
      neck: round(frame.angles.neck, decimals.angle),
      flare: round(frame.angles.flare, decimals.angle),
    },
    smoothed: {
      elbow: round(smoothed.elbow, decimals.angle),
      bodyLine: round(smoothed.bodyLine, decimals.angle),
      hipDeviation: round(smoothed.hipDeviation, decimals.angle),
    },
    lm: frame.lm.map((point) => [
      round(point[X], decimals.xy),
      round(point[Y], decimals.xy),
      round(point[V], decimals.visibility),
    ]),
  }
}

function serialiseRep(entry, index, round, decimals) {
  const { rep, segmentIndex, segment } = entry
  const frameOf = (pos) => segment[Math.min(Math.max(pos, 0), segment.length - 1)].i
  const angle = (value) => round(value, decimals.angle)
  return {
    index,
    segment: segmentIndex,
    startFrame: frameOf(rep.startPos),
    bottomFrame: frameOf(rep.bottomPos),
    endFrame: frameOf(rep.endPos),
    startT: round(rep.startT, decimals.time),
    bottomT: round(rep.bottomT, decimals.time),
    endT: round(rep.endT, decimals.time),
    frameCount: rep.frameCount,
    minElbowAngle: angle(rep.minElbowAngle),
    maxElbowAngle: angle(rep.maxElbowAngle),
    amplitudeDeg: angle(rep.amplitudeDeg),
    depthPct: round(rep.depthPct, 1),
    descentMs: Math.round(rep.descentMs),
    ascentMs: Math.round(rep.ascentMs),
    bodyLineMeasurable: rep.bodyLineMeasurable,
    hipFrames: rep.hipFrames,
    hipDeviationDeg: angle(rep.hipDeviationDeg),
    worstSag: angle(rep.worstSag),
    worstPike: angle(rep.worstPike),
    partial: rep.partial,
    meetsAppLockout: rep.meetsAppLockout,
    clean: rep.clean,
  }
}

/**
 * The exemplar payload. Fitted twice on purpose: once to get a scale for the glitch
 * test, then again on the surviving frames so the committed transform belongs to the
 * frames actually shipped.
 *
 * `stats` describes the DETECTED cycle (untrimmed) — it is the rep the hysteresis
 * scored, and silently restating it over a trimmed frame range would make the numbers
 * unverifiable against `reps`.
 */
function buildGoodRep(chosen, round, decimals, tunables) {
  const { rep, compromises, segment, serialised } = chosen
  const cycle = segment.slice(rep.startPos, rep.endPos + 1)
  const roughFit = fitNormalisation(cycle)
  if (!roughFit) return null
  const trimmed = trimGlitchedEnds(cycle, cycle[0].joints, roughFit.scale)
  if (trimmed.frames.length < EXEMPLAR.minFrames) return null
  const frames = trimmed.frames
  const fit = fitNormalisation(frames)
  if (!fit) return null
  const span = { startT: frames[0].t, endT: frames[frames.length - 1].t }
  return {
    repIndex: serialised.index,
    score: round(exemplarScore(rep, tunables), 2),
    compromises,
    frameCount: frames.length,
    durationMs: Math.round((span.endT - span.startT) * 1000),
    trim: {
      cycleFrames: cycle.length,
      leading: trimmed.leading,
      trailing: trimmed.trailing,
      maxCoreJointJump: round(trimmed.maxCoreJointJump, 4),
      limit: trimmed.limit,
      note: 'end frames whose core joints moved further than `limit` body-lengths in one ' +
        'frame were DROPPED as detector glitches; interior frames were never touched',
    },
    stats: serialised,
    normalisation: {
      anchorX: round(fit.anchorX, 5),
      anchorY: round(fit.anchorY, 5),
      scale: round(fit.scale, 5),
      flippedX: fit.flippedX,
      scaleBasis: fit.scaleBasis,
      anchorBasis: fit.anchorBasis,
      measuredSide: fit.measuredSide,
      refitAfterTrim: true,
      description: fit.description,
    },
    frames: normaliseFrames(frames, fit, span, round, decimals),
  }
}

// ---------------------------------------------------------------- entry point

/**
 * Raw browser dump -> the committed payload's data sections. `round` is injected so
 * the I/O layer owns output precision.
 *
 * Throws on a structurally unusable dump; returns empty `reps` (and a null `good_rep`)
 * when the video contains no completed pushup, which is a legitimate answer and must
 * not be papered over.
 */
export function analyseExtraction(raw, tunables, extraction, round) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    throw new Error('raw dump has no frames array')
  }
  const meta = raw.meta ?? {}
  const decimals = extraction.decimals
  const ordered = [...raw.frames].sort((a, b) => a.i - b.i)
  const prepared = ordered.map((frame) => prepareFrame(frame, tunables.visibility, tunables.geometry))
  const usable = prepared.filter((entry) => entry.ok).map((entry) => entry.frame)
  const rejections = prepared.filter((entry) => !entry.ok)
    .reduce((acc, entry) => ({ ...acc, [entry.reason]: (acc[entry.reason] ?? 0) + 1 }), {})

  const { segments, startedBy } = splitSegments(usable, extraction)
  const smoothed = segments.map((segment) => smoothSegment(segment, tunables.smoothing.windowSize))

  const appPass = detectReps(segments, smoothed, tunables, { upEnterDeg: tunables.rep.upEnterDeg })
  const usedPass = detectReps(segments, smoothed, tunables, {
    upEnterDeg: RELAXED.upEnterDeg,
    guards: RELAXED,
  })
  const reps = usedPass.reps.map((entry, position) => serialiseRep(entry, position + 1, round, decimals))

  const chosen = pickExemplar(usedPass.reps.map((entry) => entry.rep), tunables)
  const chosenIndex = chosen ? usedPass.reps.findIndex((entry) => entry.rep === chosen.rep) : -1
  const good_rep = chosenIndex < 0 ? null : buildGoodRep({
    rep: chosen.rep,
    compromises: chosen.compromises,
    segment: usedPass.reps[chosenIndex].segment,
    serialised: reps[chosenIndex],
  }, round, decimals, tunables)

  return {
    source: meta.source ?? {},
    extraction: {
      model: meta.assets?.modelPath ?? null,
      wasmBase: meta.assets?.wasmBase ?? null,
      delegate: meta.delegate ?? null,
      runningMode: meta.runningMode ?? null,
      library: meta.library ?? null,
      userAgent: meta.userAgent ?? null,
      elapsedMs: meta.elapsedMs ?? null,
      requestedFrames: meta.requestedFrames ?? ordered.length,
      detectedFrames: ordered.length,
      usableFrames: usable.length,
      rejectedFrames: ordered.length - usable.length,
      rejections,
      /**
       * `frames` below carries only frames inside a kept segment, so this is usually a
       * little under `usableFrames`: runs shorter than the minimum segment length are
       * dropped. Stated explicitly so the two numbers reconcile.
       */
      framesEmitted: segments.reduce((sum, segment) => sum + segment.length, 0),
      bodyLineMeasurableFrames: usable.filter((frame) => frame.bodyLineMeasurable).length,
      seekFailures: meta.seekFailures ?? null,
    },
    tunables,
    gate: {
      coreJoints: GATE.coreJoints,
      bodyLineJoints: GATE.bodyLineJoints,
      visibilityThreshold: tunables.visibility.joint,
      relaxation:
        "the app's requiredLandmarks also demands an ankle; this source crops the feet, " +
        'so ankle-less frames are kept and their body-line angles are null rather than ' +
        'derived from an off-frame extrapolation',
    },
    repDetection: {
      appThresholds: {
        downEnterDeg: tunables.rep.downEnterDeg,
        upEnterDeg: tunables.rep.upEnterDeg,
        repsScored: appPass.reps.length,
        note: 'the live engine\'s thresholds, unmodified — what SPOTTER itself would have counted',
      },
      used: {
        downEnterDeg: tunables.rep.downEnterDeg,
        upEnterDeg: RELAXED.upEnterDeg,
        minAmplitudeDeg: RELAXED.minAmplitudeDeg,
        minRepFrames: RELAXED.minRepFrames,
        repsScored: usedPass.reps.length,
        cyclesRejectedByGuards: usedPass.rejected,
        note: 'lowered lockout threshold, because the demonstrator holds tension and never ' +
          'straightens to 155deg; the reps below come from THIS pass, not the app\'s',
      },
    },
    frames: segments.flatMap((segment, segmentIndex) =>
      segment.map((frame, pos) => serialiseFrame(frame, smoothed[segmentIndex][pos], round, decimals))),
    segments: segments.map((segment, index) => ({
      index,
      startFrame: segment[0].i,
      endFrame: segment[segment.length - 1].i,
      frameCount: segment.length,
      startT: round(segment[0].t, decimals.time),
      endT: round(segment[segment.length - 1].t, decimals.time),
      bodyLineMeasurableFrames: segment.filter((frame) => frame.bodyLineMeasurable).length,
      /** 'start' | 'gap' (pose lost) | 'cut' (the torso teleported: another shot). */
      startedBy: startedBy[index],
    })),
    reps,
    good_rep,
  }
}
