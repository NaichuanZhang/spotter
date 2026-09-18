/**
 * The choreography: what each of the 14 clips in public/clips/manifest.json actually
 * shows, frame by frame.
 *
 * SHAPE OF EVERY FAULT CLIP — one loop, four beats:
 *
 *   1. one rep performed WRONG, tinted --fault red, with a dim GREEN ghost of the same
 *      moment of the same rep done right;
 *   2. a short morph at the top where the fault parameter animates away — the hip lifts
 *      into line, the arms straighten, the head comes up, the elbows tuck;
 *   3. the same rep performed RIGHT, tinted green, with a dim RED ghost of the fault;
 *   4. a morph back, so the last frame equals the first and the file loops seamlessly.
 *
 * The ghost is the point. A user cannot see that a hip is low without something to
 * compare it to, so every fault clip carries its own counterfactual at the same instant
 * of the same rep, plus the dashed shoulder->toe line that `hipDeviation` is literally
 * measured against in src/pose/angles.ts.
 *
 * good_rep is the exception: no fault, no ghost, one clean rep.
 *
 * WHY THE CAPTIONS ARE SO SHORT: `.refclip__video` in src/styles.css is 148px wide
 * (116px under the mobile breakpoint). A sentence at that size is a grey smear. The
 * sentence is already on screen next to the video as `.refclip__text`, and the coach
 * SPEAKS it, so the burned-in caption only has to carry which half of the loop you are
 * looking at.
 */

import { depthSeries, elbowAtDepth } from './ref-exemplar.mjs'
import { rollForFlare } from './ref-pose.mjs'

/** Straight out of src/styles.css. --substrate, --fault, and the corrected-form green. */
export const PALETTE = {
  substrate: '#05070A',
  fault: '#FF3B30',
  correct: '#2FE0A6',
  ink: '#F2F6FC',
}

/** 16:9 because `.refclip__video` sets `aspect-ratio: 16 / 9`. */
export const FRAME = { width: 640, height: 360, fps: 30 }

/**
 * Elbow angles the clips are built from, and how each relates to the app's own numbers
 * in src/pose/repMachine.ts (mirrored into landmarks.json `tunables.rep`).
 */
const DEPTH = {
  /** Past upEnterDeg (155) and descentStartDeg (165): an unambiguous lockout. */
  lockout: 175,
  /** Under depthFullDeg (80), so this bottom scores depthPct 100. */
  full: 76,
  /**
   * A half rep. Deliberately well above partialAboveDeg (95) rather than inside the
   * 95..100 window the app flags, because the clip has to be legible at 148px: 98 deg
   * against 76 is 27px of shoulder travel, 112 against 76 is 47px. The clip teaches the
   * MOVEMENT; `partial_depth` in faults.ts still fires on its own numbers.
   */
  partial: 112,
}

/** Fault magnitudes, each chosen against the threshold that classifies it. */
const MAGNITUDE = {
  /** +/-0.26 units of hip offset measures back as ~24 deg, vs cleanHipDeviationDeg = 10. */
  hipOffsetUnits: 0.26,
  /** 38 deg of crane measures back as a ~133 deg neck, vs neckMinDeg = 150. */
  craneDeg: 38,
  /**
   * 3D abduction targets, solved into a humeral roll at the bottom of the rep.
   *
   * The TUCKED number is 45 and must stay 45: both the manifest ("the elbows tucked to
   * about forty-five") and `REFERENCE_CLIPS` in src/coach/toolHandlers.ts ("tuck to roughly
   * forty five degrees from the ribs") say it out loud, and the coach reads one of those
   * sentences while the clip plays. A clip that showed 35 would be contradicting the audio.
   *
   * So the contrast is bought on the FLARED side instead: 88 was tried first and, rendered
   * and looked at, the two halves of the front clip were very nearly the same picture. 100
   * is near the ceiling of what this arm can reach at the bottom of a rep (the solver's
   * range there is 10.9..102.4) and reads clearly. A real flared pushup is ~90, so this is
   * a mild exaggeration for legibility — the clip's, not the detector's. `flared_elbows` in
   * faults.ts still fires on its own 65-degree threshold.
   */
  flaredDeg: 100,
  tuckedDeg: 45,
  /**
   * The SIDE view's flared elbow is specified as a roll directly, not as an abduction.
   * A side camera cannot see lateral fanning at all — angles.ts says as much — and the
   * true 88-degree abduction points the upper arm almost straight at the lens, so from
   * the side it draws as a stubby, nearly straight arm attached to a low shoulder, which
   * reads as a rendering bug rather than as a fault. 150 degrees of roll swings the elbow
   * FORWARD in the sagittal plane instead, which is the half of the fault a side camera
   * genuinely sees, and it is exactly the contrast the manifest sentence promises: elbows
   * that fan away from the ribs versus elbows that "travel backwards rather than sideways".
   */
  sideFlareRollDeg: 150,
  /** Front-view-only garnish, from the manifest's own wording for those two clips. */
  shrugUnits: 0.28,
  headTiltDeg: 22,
  shouldersForwardDeg: 7,
  shouldersBackDeg: -9,
}

/**
 * Tempo. Descent is twice the ascent in every clip: that is the coaching standard and it
 * is what good_rep's manifest line promises out loud ("about two seconds down and one
 * second up"). The SHAPE of each half is the real arc from landmarks.json; only its
 * duration is re-proportioned, because the source demonstrator went down in 733ms and
 * came up in 1167ms — the opposite way round, which is what fatigue looks like.
 */
const TEMPO = {
  /**
   * 46 frames/rep. Two reps plus two morphs is 106 frames = 3.53s, which fits the 2-4s
   * budget. The ascent is not shortened any further than this: at 13 frames for a 100
   * degree swing the head already travels 0.10 body-lengths per frame, and compressing it
   * to 10 pushed that to 0.13, which starts to strobe at 30fps.
   */
  contrast: { topDwellFrames: 4, descentFrames: 26, bottomDwellFrames: 3, ascentFrames: 13 },
  morphFrames: 7,
  /** Literally the manifest's 2s down / 1s up. 106 frames = 3.53s. */
  exemplar: { topDwellFrames: 12, descentFrames: 60, bottomDwellFrames: 4, ascentFrames: 30 },
}

/**
 * The four beats of a loop. Only the two REP beats are ever measured against a claim: a
 * morph frame is mid-blend by definition, so its top-of-rep angle sits between the two
 * variants' and would fail an assertion about either one.
 */
export const BEAT = Object.freeze({
  wrongRep: 'wrong-rep',
  toCorrect: 'to-correct',
  correctRep: 'correct-rep',
  toWrong: 'to-wrong',
})

/** Correct form, before any fault is applied. Every variant starts from this. */
const CORRECT_VARIANT = {
  topDeg: DEPTH.lockout,
  bottomDeg: DEPTH.full,
  sagUnits: 0,
  craneDeg: 0,
  shrugUnits: 0,
  leanBiasDeg: 0,
  headTiltDeg: 0,
  flareDeg: MAGNITUDE.tuckedDeg,
}

/**
 * One entry per fault. `wrong` is the delta from correct form, either as a literal or as a
 * function of the exemplar when the honest value is one the source video measured; `byView` optionally layers
 * on whatever that view's manifest sentence promises, or replaces a parameter the view
 * cannot express. `annotation` names the joint whose live-vs-ghost gap IS the fault, which
 * is what the connector is drawn between.
 */
const FAULTS = {
  sagging_hips: {
    wrong: { sagUnits: MAGNITUDE.hipOffsetUnits },
    byView: { front: { wrong: { leanBiasDeg: MAGNITUDE.shouldersForwardDeg } } },
    annotation: 'hip',
    captions: { wrong: 'HIPS SAG', correct: 'ONE LINE' },
  },
  piked_hips: {
    wrong: { sagUnits: -MAGNITUDE.hipOffsetUnits },
    byView: { front: { wrong: { leanBiasDeg: MAGNITUDE.shouldersBackDeg } } },
    annotation: 'hip',
    captions: { wrong: 'HIPS PIKE', correct: 'ONE LINE' },
  },
  partial_depth: {
    wrong: { bottomDeg: DEPTH.partial },
    annotation: 'shoulder',
    captions: { wrong: 'HALF REP', correct: 'FULL DEPTH' },
  },
  no_lockout: {
    /**
     * The soft top is not a number I chose: it is the SOURCE VIDEO's own top of rep, read
     * out of landmarks.json at render time. That demonstrator never locked out — the
     * extraction measured tops of 123-153 deg and the app's upEnterDeg of 155 therefore
     * scored zero of their six real reps — so "a rep that stops short at the top" is
     * exactly the geometry the real footage contains, and this clip shows it rather than
     * an invented approximation of it.
     *
     * It also happens to be far more legible than the 138 deg first tried: at 138 against
     * 175 the shoulder only drops 12px and the elbow bulges 11px, which is nothing. At the
     * source's 123 it is 25px and 40px.
     */
    wrong: (exemplar) => ({ topDeg: exemplar.source.topDeg }),
    annotation: 'elbow',
    captions: { wrong: 'STILL BENT', correct: 'LOCKED OUT' },
  },
  craned_neck: {
    wrong: { craneDeg: MAGNITUDE.craneDeg },
    byView: { front: { wrong: { shrugUnits: MAGNITUDE.shrugUnits, headTiltDeg: MAGNITUDE.headTiltDeg } } },
    annotation: 'headCentre',
    captions: { wrong: 'CHIN POKES', correct: 'NECK LONG' },
  },
  flared_elbows: {
    wrong: { flareDeg: MAGNITUDE.flaredDeg },
    byView: { side: { wrong: { elbowRollDeg: MAGNITUDE.sideFlareRollDeg } } },
    annotation: 'elbow',
    captions: { wrong: 'ELBOWS OUT', correct: 'ELBOWS IN' },
  },
  good_rep: {
    /** No fault: the exemplar is the correct variant, alone, for the whole loop. */
    wrong: null,
    annotation: null,
    captions: { wrong: null, correct: 'GOOD REP' },
  },
}

export const FAULT_NAMES = Object.freeze(Object.keys(FAULTS))

/**
 * What each clip CLAIMS, as assertions against the app's own thresholds (read out of
 * src/pose at run time by ref-thresholds.mjs). The coach reads the manifest sentence
 * aloud, so "then a full rep ... the elbows pass ninety degrees" has to be true of the
 * pixels, not just of the intent.
 *
 * `views` exists because two of the app's own metrics are projection-dependent and
 * angles.ts says so: `elbowFlare` is documented FRONT VIEW ONLY, and `hipDeviation` is
 * measured against a shoulder->ankle line that a front camera foreshortens away. Claiming
 * either in the wrong view would be asserting a number that means nothing there.
 *
 * DEPTH AND LOCKOUT ARE CLAIMED ON `elbow3d`, the depicted body's real joint angle, not on
 * the projected one. Not a dodge — a measured consequence. A pushup with TUCKED elbows
 * swings the humerus ~44 degrees out of the sagittal plane, so a side camera sees a
 * straighter arm than there is: this model at a true 76-degree elbow projects to 91 from
 * the side. That is a real property of the app's own metric (the same foreshortening
 * angles.ts documents for `elbowFlare`), and the honest response is to assert the body's
 * geometry and REPORT both numbers, not to un-tuck the figure until the projection agrees.
 */
export function claimsFor(fault, view, thresholds) {
  const all = ['side', 'front']
  const correctDepth = [
    { what: 'reaches full depth', half: 'correct', metric: 'elbow3d', bound: 'min', op: '<=', value: thresholds.depthFullDeg, views: all },
    { what: 'locks out at the top', half: 'correct', metric: 'elbow3d', bound: 'max', op: '>', value: thresholds.lockoutDeg, views: all },
    { what: 'would complete a rep', half: 'correct', metric: 'elbow3d', bound: 'max', op: '>=', value: thresholds.upEnterDeg, views: all },
  ]
  const straightBack = [
    { what: 'corrected back is clean', half: 'correct', metric: 'hipDeviation', bound: 'absMax', op: '<', value: thresholds.sagDeg, views: ['side'] },
  ]
  const byFault = {
    sagging_hips: [
      { what: 'hip is below the line by a sag', half: 'wrong', metric: 'hipDeviation', bound: 'max', op: '>=', value: thresholds.sagDeg, views: ['side'] },
      ...straightBack,
    ],
    piked_hips: [
      { what: 'hip is above the line by a pike', half: 'wrong', metric: 'hipDeviation', bound: 'min', op: '<=', value: -thresholds.pikeDeg, views: ['side'] },
      ...straightBack,
    ],
    partial_depth: [
      { what: 'half rep stops short of the partial flag', half: 'wrong', metric: 'elbow3d', bound: 'min', op: '>', value: thresholds.partialAboveDeg, views: all },
    ],
    no_lockout: [
      { what: 'soft top stays short of a lockout', half: 'wrong', metric: 'elbow3d', bound: 'max', op: '<=', value: thresholds.lockoutDeg, views: all },
      { what: 'soft top would never complete a rep', half: 'wrong', metric: 'elbow3d', bound: 'max', op: '<', value: thresholds.upEnterDeg, views: all },
    ],
    craned_neck: [
      { what: 'neck is craned', half: 'wrong', metric: 'neck', bound: 'min', op: '<=', value: thresholds.neckMinDeg, views: ['side'] },
      { what: 'corrected neck is neutral', half: 'correct', metric: 'neck', bound: 'min', op: '>', value: thresholds.neckMinDeg, views: ['side'] },
    ],
    flared_elbows: [
      { what: 'elbows read flared', half: 'wrong', metric: 'flare', bound: 'max', op: '>=', value: thresholds.flareDeg, views: ['front'] },
      // NOT asserted: that the corrected half reads BELOW flareDeg. At the front camera's
      // yaw the torso axis is foreshortened to about a third of its length, so projected
      // abduction runs high for any arm, tucked included. Asserting it would mean either
      // un-tucking the corrected figure or pulling the camera back toward a side view that
      // cannot show the fault at all. The measured spans are printed for both halves.
      // The side view's claim is about elbowLead, not flare: a side camera cannot measure
      // abduction, but it CAN see whether the elbow winged forward of the arm or travelled
      // back along the ribs, which is the manifest's own wording for this pair.
      { what: 'elbow wings forward of the arm', half: 'wrong', metric: 'elbowLead', bound: 'max', op: '>', value: 0.1, views: ['side'] },
      { what: 'corrected elbow travels back, never forward', half: 'correct', metric: 'elbowLead', bound: 'max', op: '<=', value: 0, views: ['side'] },
    ],
    good_rep: [],
  }
  return [...correctDepth, ...byFault[fault]].filter((claim) => claim.views.includes(view))
}

/**
 * Resolves `flareDeg` (a 3D abduction target, which is what a coach says) into
 * `elbowRollDeg` (humeral roll, which is what the model takes). Solved AT THE BOTTOM of
 * that variant's own rep, because a straight arm at lockout has no measurable abduction
 * to solve for — see NEUTRAL_POSE.elbowRollDeg in ref-pose.mjs.
 */
function resolveRoll(exemplar, variant) {
  const { flareDeg, ...rest } = variant
  if (typeof rest.elbowRollDeg === 'number') return { ...rest, flareTargetDeg: null }
  return {
    ...rest,
    elbowRollDeg: rollForFlare(exemplar, { ...rest, elbowDeg: variant.bottomDeg }, flareDeg),
    flareTargetDeg: flareDeg,
  }
}

const POSE_KEYS = ['sagUnits', 'craneDeg', 'shrugUnits', 'leanBiasDeg', 'headTiltDeg', 'elbowRollDeg']

function lerp(a, b, f) {
  return a + (b - a) * f
}

/** Interpolates two resolved variants. Used for the morph beats, and only there. */
function blendVariants(a, b, f) {
  const out = { topDeg: lerp(a.topDeg, b.topDeg, f), bottomDeg: lerp(a.bottomDeg, b.bottomDeg, f) }
  for (const key of POSE_KEYS) out[key] = lerp(a[key], b[key], f)
  return out
}

/** Pose overrides for one variant at one depth. */
function poseFor(variant, depth) {
  const spec = { elbowDeg: elbowAtDepth(variant, depth) }
  for (const key of POSE_KEYS) spec[key] = variant[key]
  return spec
}

/** Smoothstep, so the morph beats ease in and out instead of snapping. */
function ease(f) {
  const t = f < 0 ? 0 : f > 1 ? 1 : f
  return t * t * (3 - 2 * t)
}

/**
 * The whole clip as an array of frames. Each frame is everything the renderer needs and
 * nothing it has to recompute: the live pose spec, the ghost's (or null), how far through
 * the wrong->correct morph we are, and which caption is showing.
 */
export function buildTimeline(exemplar, fault, view) {
  const plan = FAULTS[fault]
  if (!plan) throw new Error(`buildTimeline: no plan for fault "${fault}"`)
  if (view !== 'side' && view !== 'front') throw new Error(`buildTimeline: bad view "${view}"`)

  const perView = plan.byView?.[view] ?? {}
  const correct = resolveRoll(exemplar, { ...CORRECT_VARIANT, ...(perView.correct ?? {}) })
  if (!plan.wrong) return exemplarTimeline(exemplar, correct, plan)

  const wrongDelta = typeof plan.wrong === 'function' ? plan.wrong(exemplar) : plan.wrong
  const wrong = resolveRoll(exemplar, { ...CORRECT_VARIANT, ...wrongDelta, ...(perView.wrong ?? {}) })

  const depths = depthSeries(exemplar, TEMPO.contrast)
  const caption = (mix) => (mix < 0.5 ? plan.captions.wrong : plan.captions.correct)
  const rep = (live, ghost, mix, beat) =>
    depths.map((depth) => ({
      live: poseFor(live, depth),
      ghost: poseFor(ghost, depth),
      mix,
      depth,
      beat,
      annotation: plan.annotation,
      caption: caption(mix),
      captionMix: mix,
    }))
  const morph = (from, to, beat, rising) =>
    Array.from({ length: TEMPO.morphFrames }, (_, i) => {
      const f = ease((i + 1) / (TEMPO.morphFrames + 1))
      const mix = rising ? f : 1 - f
      return {
        live: poseFor(blendVariants(from, to, f), 0),
        ghost: poseFor(blendVariants(to, from, f), 0),
        mix,
        depth: 0,
        beat,
        annotation: plan.annotation,
        caption: caption(mix),
        captionMix: mix,
      }
    })

  return [
    ...rep(wrong, correct, 0, BEAT.wrongRep),
    ...morph(wrong, correct, BEAT.toCorrect, true),
    ...rep(correct, wrong, 1, BEAT.correctRep),
    ...morph(correct, wrong, BEAT.toWrong, false),
  ]
}

function exemplarTimeline(exemplar, correct, plan) {
  return depthSeries(exemplar, TEMPO.exemplar).map((depth) => ({
    live: poseFor(correct, depth),
    ghost: null,
    mix: 1,
    depth,
    beat: BEAT.correctRep,
    annotation: null,
    caption: plan.captions.correct,
    captionMix: 1,
  }))
}
