/**
 * Turns one timeline frame into pixels.
 *
 * Two rules shape everything here, both coming from the fact that these clips play in a
 * 148px-wide slot (`.refclip__video`, src/styles.css):
 *
 *   - EVERY size is in model units (one unit = one shoulder->hip length) and multiplied
 *     by the per-clip fit scale. So a stroke is a constant fraction of the body, and the
 *     figure never changes weight between clips or between views.
 *   - ONE fit for the WHOLE clip, computed over every frame of both the live figure and
 *     its ghost. Per-frame fitting would zoom and pan on every rep, which reads as camera
 *     shake rather than as a body moving.
 */

import { fillCircle, fillRect, hexToRgb, mixRgb, strokeCircle, strokeDashedLine, strokeLine } from './ref-raster.mjs'
import { drawText, fitScale, textHeight } from './ref-font.mjs'
import { PROPORTIONS, project, sidedJoints } from './ref-pose.mjs'

/** Everything in model units except where a name says px. */
const STYLE = {
  strokeUnits: 0.055,
  jointRadiusUnits: 0.04,
  headRadiusUnits: PROPORTIONS.HEAD_RADIUS,
  ghostStrokeUnits: 0.024,
  ghostJointRadiusUnits: 0.022,
  ghostAlpha: 0.34,
  /**
   * The far half of the body in the front view. An orthographic projection has no
   * perspective and no shading, so two overlapping arms and two overlapping legs read as a
   * tangle; fading the far side is the one depth cue available, and without it the whole
   * point of the flared_elbows front clip — which elbow is further out — is unreadable.
   */
  farSideAlpha: 0.5,
  plankAlpha: 0.36,
  plankDashUnits: 0.1,
  plankGapUnits: 0.075,
  floorAlpha: 0.2,
  floorWidthPx: 2,
  /** Below this the live and ghost joints are on top of each other; the tick is noise. */
  annotationMinGapPx: 7,
  annotationAlpha: 0.9,
  captionBandPx: 86,
  captionMaxScale: 7,
  /** Fractions of the caption band: where the rule sits, and where the text starts. */
  captionRuleFraction: 0.22,
  captionTextFraction: 0.33,
  captionBottomMarginPx: 5,
  captionMinAlpha: 0.42,
  ruleWidthPx: 2,
  ruleAlpha: 0.5,
  ruleWidthUnitsFraction: 0.26,
  tagScale: 2,
  tagAlpha: 0.32,
  tagInsetPx: 12,
  /** Breathing room around the fitted figure, in model units. */
  padUnits: 0.07,
}

const RGB = {
  substrate: hexToRgb('#05070A'),
  fault: hexToRgb('#FF3B30'),
  correct: hexToRgb('#2FE0A6'),
  ink: hexToRgb('#F2F6FC'),
}

/** The bones, as joint-name pairs. The side view draws one side; the front draws both. */
const BONES = [
  ['shoulder', 'elbow'],
  ['elbow', 'wrist'],
  ['shoulder', 'hip'],
  ['hip', 'knee'],
  ['knee', 'ankle'],
  ['ankle', 'toe'],
]

const JOINT_DOTS = ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'toe']

/**
 * Every point a pose contributes to a view, so the fit can see all of them. The side view
 * takes the near side only; the front takes both.
 *
 * The head's four circle extremes are included rather than just its centre, so the fit can
 * pad by a hair everywhere instead of padding every edge by a whole head radius. That is
 * worth ~20% of figure size: the front view's bounding box is only about 1.7 units tall, so
 * a head-radius margin on all four sides was eating a third of the frame.
 */
export function posePoints(pose, view) {
  const signs = view === 'front' ? [1, -1] : [1]
  const limbs = signs.flatMap((sign) => Object.values(sidedJoints(pose, sign)))
  const head = project(pose.joints.headCentre, view)
  const r = STYLE.headRadiusUnits
  const headBox = [
    { x: head.x - r, y: head.y },
    { x: head.x + r, y: head.y },
    { x: head.x, y: head.y - r },
    { x: head.x, y: head.y + r },
  ]
  return [...limbs.map((point) => project(point, view)), ...headBox]
}

/**
 * One transform for the whole clip. The floor (model y = 0) is forced into the box so the
 * ground line is always on screen even for a clip whose figure never reaches it.
 */
export function fitLayout(frames, view, frame) {
  const points = frames.flatMap((f) => [
    ...posePoints(f.live, view),
    ...(f.ghost ? posePoints(f.ghost, view) : []),
  ])
  if (points.length === 0) throw new Error('fitLayout: no points to fit')

  const pad = STYLE.padUnits
  const xs = points.map((p) => p.x)
  const ys = [...points.map((p) => p.y), 0]
  const box = {
    x0: Math.min(...xs) - pad,
    x1: Math.max(...xs) + pad,
    y0: Math.min(...ys) - pad,
    y1: Math.max(...ys) + pad,
  }

  const availableWidth = frame.width
  const availableHeight = frame.height - STYLE.captionBandPx
  const scale = Math.min(availableWidth / (box.x1 - box.x0), availableHeight / (box.y1 - box.y0))
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new Error(`fitLayout: degenerate box ${JSON.stringify(box)}`)
  }
  return {
    scale,
    originX: (availableWidth - (box.x1 - box.x0) * scale) / 2 - box.x0 * scale,
    originY: (availableHeight - (box.y1 - box.y0) * scale) / 2 - box.y0 * scale,
    captionTop: frame.height - STYLE.captionBandPx,
  }
}

const toPx = (layout, point) => ({ x: layout.originX + point.x * layout.scale, y: layout.originY + point.y * layout.scale })

/** Draws one complete frame. Order is back-to-front: floor, plank, ghost, tick, body, text. */
export function drawFrame(canvas, layout, frame, meta) {
  const { mix } = frame
  const liveRgb = mixRgb(RGB.fault, RGB.correct, mix)
  const ghostRgb = mixRgb(RGB.correct, RGB.fault, mix)

  canvas.data.fill(0)
  for (let i = 0; i < canvas.data.length; i += 3) {
    canvas.data[i] = RGB.substrate[0]
    canvas.data[i + 1] = RGB.substrate[1]
    canvas.data[i + 2] = RGB.substrate[2]
  }

  drawFloor(canvas, layout, meta.view)
  drawPlankLine(canvas, layout, frame.live, meta.view)
  if (frame.ghost) drawSkeleton(canvas, layout, frame.ghost, meta.view, ghostRgb, 'ghost')
  if (frame.ghost && frame.annotation) {
    drawAnnotation(canvas, layout, frame, meta.view, liveRgb)
  }
  drawSkeleton(canvas, layout, frame.live, meta.view, liveRgb, 'live')
  drawCaption(canvas, layout, frame, liveRgb)
  drawViewTag(canvas, meta.view)
}

/**
 * The ground, drawn as the projection of the floor's sagittal centreline (every point with
 * y = 0 and z = 0) extended across the frame. In the side view that is exactly a horizontal
 * line. In the front view the camera's pitch turns it into a line receding away from the
 * lens, which is the strongest depth cue an orthographic projection gets to have — and it
 * is the correct one, not a decoration: it is where the floor actually is.
 */
function drawFloor(canvas, layout, view) {
  const a = toPx(layout, project({ x: -1, y: 0, z: 0 }, view))
  const b = toPx(layout, project({ x: 1, y: 0, z: 0 }, view))
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) throw new Error('drawFloor: the floor centreline projects to a point')
  const far = (canvas.width + canvas.height) / Math.hypot(dx, dy)
  strokeLine(
    canvas,
    { x: a.x - dx * far, y: a.y - dy * far },
    { x: b.x + dx * far, y: b.y + dy * far },
    STYLE.floorWidthPx,
    RGB.ink,
    STYLE.floorAlpha,
  )
}

/**
 * The dashed shoulder->toe line: the reference `hipDeviation` in angles.ts measures
 * against. Drawn in neutral INK, never in the live or ghost colour, so it reads as the
 * ruler rather than as a third body — and so it stays legible when the ghost's own
 * straight torso lies along almost exactly the same path.
 */
function drawPlankLine(canvas, layout, pose, view) {
  const a = toPx(layout, project(pose.joints.shoulder, view))
  const b = toPx(layout, project(pose.joints.toe, view))
  strokeDashedLine(
    canvas,
    a,
    b,
    Math.max(1, STYLE.ghostStrokeUnits * layout.scale),
    RGB.ink,
    STYLE.plankAlpha,
    STYLE.plankDashUnits * layout.scale,
    STYLE.plankGapUnits * layout.scale,
  )
}

function drawSkeleton(canvas, layout, pose, view, rgb, weight) {
  const ghost = weight === 'ghost'
  const alpha = ghost ? STYLE.ghostAlpha : 1
  const stroke = Math.max(1, (ghost ? STYLE.ghostStrokeUnits : STYLE.strokeUnits) * layout.scale)
  const jointRadius = (ghost ? STYLE.ghostJointRadiusUnits : STYLE.jointRadiusUnits) * layout.scale
  const signs = view === 'front' ? [1, -1] : [1]

  const sides = signs.map((sign) => {
    const joints = sidedJoints(pose, sign)
    return Object.fromEntries(Object.entries(joints).map(([name, p]) => [name, toPx(layout, project(p, view))]))
  })
  const alphaFor = (index) => (index === 0 ? alpha : alpha * STYLE.farSideAlpha)

  // Far side first, and dimmer, so the near side reads as being in front of it.
  for (let i = sides.length - 1; i >= 0; i -= 1) {
    for (const [from, to] of BONES) strokeLine(canvas, sides[i][from], sides[i][to], stroke, rgb, alphaFor(i))
  }
  if (sides.length === 2) {
    for (const name of ['shoulder', 'hip']) {
      strokeLine(canvas, sides[0][name], sides[1][name], stroke, rgb, alpha)
    }
  }

  const head = toPx(layout, project(pose.joints.headCentre, view))
  const neckFrom = sides.length === 2
    ? { x: (sides[0].shoulder.x + sides[1].shoulder.x) / 2, y: (sides[0].shoulder.y + sides[1].shoulder.y) / 2 }
    : sides[0].shoulder
  strokeLine(canvas, neckFrom, head, stroke, rgb, alpha)

  const headRadius = STYLE.headRadiusUnits * layout.scale
  if (ghost) strokeCircle(canvas, head, headRadius, stroke, rgb, alpha)
  else fillCircle(canvas, head, headRadius, rgb, alpha)

  for (let i = sides.length - 1; i >= 0; i -= 1) {
    for (const name of JOINT_DOTS) fillCircle(canvas, sides[i][name], jointRadius, rgb, alphaFor(i))
  }

  // Ground contacts. Fingers point AWAY from the feet and the toes point past the ankle,
  // which is what a planted pushup hand and a plantar-flexed foot look like from the side.
  // Skipped for the ghost: the contacts are identical in both variants, so drawing them
  // twice only thickens the floor.
  if (ghost) return
  signs.forEach((sign, i) => {
    const joints = sidedJoints(pose, sign)
    contactTick(canvas, layout, joints.wrist, -PROPORTIONS.HAND_TICK, view, stroke, rgb, alphaFor(i))
    contactTick(canvas, layout, joints.toe, PROPORTIONS.FOOT_TICK, view, stroke, rgb, alphaFor(i))
  })
}

/**
 * The live-vs-ghost gap at the one joint that IS the fault: hip for sag and pike,
 * shoulder for depth, elbow for lockout and flare, head for the neck. Drawn as a line
 * from where the joint should be to where it is, with a ring on the target.
 */
/**
 * A short bar lying on the floor, running `lengthUnits` in x from directly under a joint.
 * Built in MODEL space and then projected, so it lands on the real floor in both cameras
 * rather than on a screen-space guess at where the floor is.
 */
function contactTick(canvas, layout, joint, lengthUnits, view, stroke, rgb, alpha) {
  const from = { x: joint.x, y: 0, z: joint.z }
  const to = { x: joint.x + lengthUnits, y: 0, z: joint.z }
  strokeLine(canvas, toPx(layout, project(from, view)), toPx(layout, project(to, view)), stroke, rgb, alpha)
}

function drawAnnotation(canvas, layout, frame, view, rgb) {
  const pick = (pose) =>
    frame.annotation === 'elbow' ? pose.arms.near.elbow : pose.joints[frame.annotation]
  const live = pick(frame.live)
  const ghost = pick(frame.ghost)
  if (!live || !ghost) throw new Error(`drawAnnotation: no joint "${frame.annotation}" on the pose`)

  const a = toPx(layout, project(ghost, view))
  const b = toPx(layout, project(live, view))
  if (Math.hypot(b.x - a.x, b.y - a.y) < STYLE.annotationMinGapPx) return

  const width = Math.max(1, STYLE.ghostStrokeUnits * layout.scale)
  strokeLine(canvas, a, b, width, rgb, STYLE.annotationAlpha)
  strokeCircle(canvas, a, STYLE.jointRadiusUnits * layout.scale * 1.7, width, rgb, STYLE.annotationAlpha)
}

/**
 * The caption, plus a short rule above it in the live colour so the red/green state is
 * legible even when the frame is too small to read the word. Only ONE caption is ever on
 * screen: cross-fading two overlapping words turns them into mush, so the outgoing word
 * dims to `captionMinAlpha` and the incoming one takes over at the halfway point.
 */
function drawCaption(canvas, layout, frame, rgb) {
  if (!frame.caption) return
  const distance = Math.abs(frame.captionMix - 0.5) * 2
  const alpha = STYLE.captionMinAlpha + (1 - STYLE.captionMinAlpha) * distance

  const ruleWidth = canvas.width * STYLE.ruleWidthUnitsFraction
  const ruleY = layout.captionTop + STYLE.captionBandPx * STYLE.captionRuleFraction
  strokeLine(
    canvas,
    { x: (canvas.width - ruleWidth) / 2, y: ruleY },
    { x: (canvas.width + ruleWidth) / 2, y: ruleY },
    STYLE.ruleWidthPx,
    rgb,
    STYLE.ruleAlpha * alpha,
  )

  // Bounded by the band's remaining HEIGHT as well as its width: a scale that fits
  // horizontally can still run off the bottom of the frame, and a caption whose last
  // pixel row is chopped off looks like a broken encode rather than a design.
  const textY = Math.round(layout.captionTop + STYLE.captionBandPx * STYLE.captionTextFraction)
  const room = canvas.height - STYLE.captionBottomMarginPx - textY
  const maxScale = Math.min(STYLE.captionMaxScale, Math.floor(room / textHeight(1)))
  if (maxScale < 1) throw new Error(`drawCaption: only ${room}px left below y=${textY}; no scale fits`)
  const scale = fitScale(frame.caption, canvas.width * 0.88, maxScale)
  drawText(canvas, fillRect, frame.caption, {
    x: canvas.width / 2,
    y: textY,
    scale,
    rgb,
    alpha,
    align: 'centre',
  })
}

function drawViewTag(canvas, view) {
  drawText(canvas, fillRect, view, {
    x: STYLE.tagInsetPx,
    y: STYLE.tagInsetPx,
    scale: STYLE.tagScale,
    rgb: RGB.ink,
    alpha: STYLE.tagAlpha,
  })
}

export { STYLE as DRAW_STYLE, RGB as DRAW_RGB, textHeight }
