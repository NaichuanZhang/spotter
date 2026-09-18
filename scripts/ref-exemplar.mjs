/**
 * Reduces the real extraction in public/clips/landmarks.json to the three things the
 * renderer can honestly reuse from it, and nothing else:
 *
 *   1. the SHAPE of each half of good_rep's elbow arc, as a 0..1 depth profile;
 *   2. how far the shoulder leans forward of the planted wrist at each elbow angle;
 *   3. the tempo and extremes of the source rep, for the record and for the one clip
 *      (no_lockout) whose fault magnitude IS the source's own measured top of rep.
 *
 * Nothing here knows what a skeleton looks like — that is ref-pose.mjs. The split matters
 * because these are the only functions that touch the recording, so "what did we take from
 * the video" is answerable by reading one file.
 *
 * Every failure throws. A silently-empty arc would produce fourteen clips of a motionless
 * stick figure, which is far worse than a failed render.
 */

import { readFileSync } from 'node:fs'

const toDeg = (rad) => (rad * 180) / Math.PI
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Reads the exemplar out of landmarks.json and reduces it to the two things this
 * renderer can honestly reuse: the shape of each half of the elbow arc, and how the
 * shoulder leans over the planted hand at each elbow angle.
 *
 * Throws on anything unexpected. A silently-empty arc would produce 14 clips of a
 * motionless stick figure, which is far worse than a failed render.
 */
export function loadExemplar(path) {
  const raw = readFileSync(path, 'utf8')
  const doc = JSON.parse(raw)
  if (doc.schemaVersion !== 1) {
    throw new Error(`loadExemplar: expected schemaVersion 1, got ${doc.schemaVersion}`)
  }
  const rep = doc.good_rep
  if (!rep || !Array.isArray(rep.frames) || rep.frames.length < 12) {
    throw new Error('loadExemplar: landmarks.json has no usable good_rep.frames')
  }
  const names = doc.landmarkNames
  const side = rep.normalisation?.measuredSide
  if (side !== 'left' && side !== 'right') {
    throw new Error(`loadExemplar: good_rep.normalisation.measuredSide is "${side}"`)
  }
  const at = (frame, name) => {
    const index = names.indexOf(`${side}_${name}`)
    if (index < 0) throw new Error(`loadExemplar: landmarkNames has no ${side}_${name}`)
    const lm = frame.lm[index]
    return { x: lm[0], y: lm[1] }
  }

  const series = rep.frames.map((frame) => {
    if (typeof frame.angles?.elbow !== 'number') {
      throw new Error(`loadExemplar: frame ${frame.i} has no numeric angles.elbow`)
    }
    return frame.angles.elbow
  })
  const bottom = series.indexOf(Math.min(...series))
  if (bottom < 4 || bottom > series.length - 5) {
    throw new Error(`loadExemplar: bottom of the arc at index ${bottom} of ${series.length}`)
  }

  const lean = rep.frames.map((frame) => {
    const shoulder = at(frame, 'shoulder')
    const wrist = at(frame, 'wrist')
    return { elbow: frame.angles.elbow, leanDeg: toDeg(Math.atan2(-(shoulder.x - wrist.x), -(shoulder.y - wrist.y))) }
  })

  return {
    descentU: halfProfile(series.slice(0, bottom + 1)),
    ascentU: halfProfile(series.slice(bottom).reverse()).reverse(),
    leanTable: binnedLeanTable(lean),
    source: {
      repIndex: rep.repIndex,
      frameCount: series.length,
      durationMs: rep.durationMs,
      topDeg: Math.max(series[0], series[series.length - 1]),
      bottomDeg: series[bottom],
      descentFrames: bottom,
      ascentFrames: series.length - 1 - bottom,
    },
  }
}

/**
 * One half of the arc as a 0..1 depth profile, 0 at that half's own top sample.
 * Normalising each half against its OWN endpoint is what makes the loop close: the
 * source's rep starts at 114 deg and ends at 123 deg, so a single shared normalisation
 * would leave a 9-degree step at the loop point.
 */
function halfProfile(samples) {
  const top = samples[0]
  const bottom = samples[samples.length - 1]
  const span = top - bottom
  if (!(span > 1)) throw new Error(`halfProfile: degenerate half, span ${span} deg`)
  return samples.map((value) => clamp01((top - value) / span))
}

/** Median lean per 10-degree elbow bucket: 58 raw samples are too noisy to interpolate. */
function binnedLeanTable(samples, bucketDeg = 10) {
  const buckets = new Map()
  for (const sample of samples) {
    const key = Math.round(sample.elbow / bucketDeg)
    const list = buckets.get(key) ?? []
    buckets.set(key, [...list, sample.leanDeg])
  }
  return [...buckets.entries()]
    .map(([key, leans]) => {
      const sorted = [...leans].sort((a, b) => a - b)
      return { elbow: key * bucketDeg, leanDeg: sorted[Math.floor(sorted.length / 2)] }
    })
    .sort((a, b) => a.elbow - b.elbow)
}

/** Piecewise-linear lean lookup, held FLAT outside the source's elbow range. */
export function leanAt(table, elbowDeg) {
  if (elbowDeg <= table[0].elbow) return table[0].leanDeg
  const last = table[table.length - 1]
  if (elbowDeg >= last.elbow) return last.leanDeg
  for (let i = 1; i < table.length; i += 1) {
    if (elbowDeg <= table[i].elbow) {
      const a = table[i - 1]
      const b = table[i]
      const f = (elbowDeg - a.elbow) / (b.elbow - a.elbow)
      return a.leanDeg + (b.leanDeg - a.leanDeg) * f
    }
  }
  throw new Error(`leanAt: unreachable for ${elbowDeg}`)
}

/** Resamples a 0..1 profile to `count` samples over (0, 1], i.e. excluding its top. */
function resampleProfile(profile, count) {
  if (count < 1) throw new Error(`resampleProfile: count ${count}`)
  return Array.from({ length: count }, (_, i) => {
    const at = ((i + 1) / count) * (profile.length - 1)
    const lo = Math.floor(at)
    const hi = Math.min(profile.length - 1, lo + 1)
    return profile[lo] + (profile[hi] - profile[lo]) * (at - lo)
  })
}

/**
 * One rep as a series of DEPTHS in 0..1 — 0 at the top, 1 at the bottom — not as angles.
 * Depth rather than degrees because a contrast clip has to run two variants with
 * different tops and bottoms through the SAME moment of the SAME rep: the ghost is only
 * a fair counterfactual if it is at the same fraction of the descent, not the same angle.
 *
 * Starts and ends at 0, so the clip loops without a step.
 */
export function depthSeries(exemplar, shape) {
  const { topDwellFrames, descentFrames, bottomDwellFrames, ascentFrames } = shape
  // resampleProfile drops each profile's FIRST sample, which is exactly the frame the
  // preceding dwell already holds: the descent's top and the ascent's bottom.
  return [
    ...Array.from({ length: topDwellFrames }, () => 0),
    ...resampleProfile(exemplar.descentU, descentFrames),
    ...Array.from({ length: bottomDwellFrames }, () => 1),
    ...resampleProfile(exemplar.ascentU, ascentFrames),
  ]
}

/** Maps a 0..1 depth onto one variant's own elbow range. */
export function elbowAtDepth(variant, depth) {
  if (!(variant.topDeg > variant.bottomDeg)) {
    throw new Error(`elbowAtDepth: top ${variant.topDeg} <= bottom ${variant.bottomDeg}`)
  }
  return variant.topDeg - clamp01(depth) * (variant.topDeg - variant.bottomDeg)
}
