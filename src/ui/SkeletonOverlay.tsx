/**
 * Skeleton drawn over the camera.
 *
 * Only the pushup-relevant bones — arms, torso, legs, ear-to-shoulder for the neck
 * line. Drawing all 33 BlazePose points adds noise (fingers, eyes, toes) and hides
 * the thing the coach is actually talking about.
 *
 * Two geometry traps are handled here, and both are easy to get wrong:
 *  1. MIRRORING. The camera feed is CSS-flipped so the user sees themselves the
 *     way a mirror would. Landmarks come back in unflipped frame space, so x is
 *     flipped in code. The canvas itself is NOT CSS-flipped.
 *  2. LETTERBOXING. The video is object-fit: cover, so the frame is scaled up and
 *     centre-cropped. Normalised landmarks must be mapped through that same
 *     transform or the skeleton drifts off the body near the edges.
 *
 * NOTHING ABOUT THE VIDEO IS CACHED ACROSS FRAMES, and that is load-bearing now that
 * the user can switch cameras mid-set: `videoWidth`/`videoHeight` and the canvas box are
 * re-read every tick, so a 1280x720 lid camera and a 1920x1080 iPhone letterbox
 * correctly without anyone telling this component that anything changed. The one thing
 * a re-measure cannot fix is the FIRST frame after a switch, where the landmarks in hand
 * were measured in the old camera's frame space — those are dropped (see `geometryRef`)
 * rather than projected through the new letterbox, which would put the skeleton visibly
 * off the body.
 *
 * Landmarks are PULLED once per animation frame instead of pushed through React
 * state — 30 re-renders a second of the whole tree would cost more than the draw.
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Structurally compatible with MediaPipe's NormalizedLandmark. */
export interface OverlayLandmark {
  readonly x: number
  readonly y: number
  readonly visibility?: number
}

export type LandmarkSource = () => readonly OverlayLandmark[] | null

/** BlazePose indices. Named so the bone list below reads as anatomy. */
const L = {
  nose: 0,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
} as const

const BONES: readonly (readonly [number, number])[] = [
  [L.shoulderL, L.elbowL],
  [L.elbowL, L.wristL],
  [L.shoulderR, L.elbowR],
  [L.elbowR, L.wristR],
  [L.shoulderL, L.shoulderR],
  [L.shoulderL, L.hipL],
  [L.shoulderR, L.hipR],
  [L.hipL, L.hipR],
  [L.hipL, L.kneeL],
  [L.hipR, L.kneeR],
  [L.kneeL, L.ankleL],
  [L.kneeR, L.ankleR],
  [L.earL, L.shoulderL],
  [L.earR, L.shoulderR],
]

const JOINTS: readonly number[] = [
  L.nose,
  L.shoulderL,
  L.shoulderR,
  L.elbowL,
  L.elbowR,
  L.wristL,
  L.wristR,
  L.hipL,
  L.hipR,
  L.kneeL,
  L.kneeR,
  L.ankleL,
  L.ankleR,
]

/** Draw parameters. Recalibrate here, nowhere else. */
const DRAW = {
  MIN_VISIBILITY: 0.5,
  BONE_WIDTH: 5,
  JOINT_RADIUS: 5.5,
  CLEAN_STROKE: 'rgba(238,246,255,0.92)',
  FAULT_STROKE: '#FF3B30',
  HALO: 'rgba(0,0,0,0.55)',
  HALO_BLUR: 10,
  MAX_DPR: 2,
} as const

interface Box {
  readonly width: number
  readonly height: number
}

interface CoverLayout {
  readonly drawnWidth: number
  readonly drawnHeight: number
  readonly offsetX: number
  readonly offsetY: number
}

/** Reproduces object-fit: cover for a video of intrinsic size vw x vh inside box. */
function coverLayout(videoWidth: number, videoHeight: number, box: Box): CoverLayout {
  const scale = Math.max(box.width / videoWidth, box.height / videoHeight)
  const drawnWidth = videoWidth * scale
  const drawnHeight = videoHeight * scale
  return {
    drawnWidth,
    drawnHeight,
    offsetX: (box.width - drawnWidth) / 2,
    offsetY: (box.height - drawnHeight) / 2,
  }
}

function projectX(landmark: OverlayLandmark, layout: CoverLayout, box: Box, mirrored: boolean): number {
  const x = layout.offsetX + landmark.x * layout.drawnWidth
  return mirrored ? box.width - x : x
}

function projectY(landmark: OverlayLandmark, layout: CoverLayout): number {
  return layout.offsetY + landmark.y * layout.drawnHeight
}

function isVisible(landmark: OverlayLandmark | undefined): landmark is OverlayLandmark {
  if (!landmark) return false
  if (landmark.visibility === undefined) return true
  return landmark.visibility >= DRAW.MIN_VISIBILITY
}

function paint(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly OverlayLandmark[],
  layout: CoverLayout,
  box: Box,
  mirrored: boolean,
  stroke: string,
): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.shadowColor = DRAW.HALO
  ctx.shadowBlur = DRAW.HALO_BLUR
  ctx.strokeStyle = stroke
  ctx.fillStyle = stroke
  ctx.lineWidth = DRAW.BONE_WIDTH

  for (const [from, to] of BONES) {
    const a = landmarks[from]
    const b = landmarks[to]
    if (!isVisible(a) || !isVisible(b)) continue
    ctx.beginPath()
    ctx.moveTo(projectX(a, layout, box, mirrored), projectY(a, layout))
    ctx.lineTo(projectX(b, layout, box, mirrored), projectY(b, layout))
    ctx.stroke()
  }

  for (const index of JOINTS) {
    const point = landmarks[index]
    if (!isVisible(point)) continue
    ctx.beginPath()
    ctx.arc(
      projectX(point, layout, box, mirrored),
      projectY(point, layout),
      DRAW.JOINT_RADIUS,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
}

interface SkeletonOverlayProps {
  /** Ref (not the element) so the draw loop can start before the stream arrives. */
  readonly videoRef: RefObject<HTMLVideoElement | null>
  readonly getLandmarks: LandmarkSource
  readonly mirrored?: boolean
  readonly faultActive?: boolean
}

export default function SkeletonOverlay({
  videoRef,
  getLandmarks,
  mirrored = true,
  faultActive = false,
}: SkeletonOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const faultRef = useRef(faultActive)
  /** The video geometry the last drawn skeleton was projected through. */
  const geometryRef = useRef('')

  useEffect(() => {
    faultRef.current = faultActive
  }, [faultActive])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      console.error('[spotter] 2d canvas context unavailable — skeleton overlay disabled.')
      return undefined
    }

    let frame = 0
    const tick = () => {
      frame = window.requestAnimationFrame(tick)
      const video = videoRef.current
      const box: Box = { width: canvas.clientWidth, height: canvas.clientHeight }
      if (box.width === 0 || box.height === 0) return

      const dpr = Math.min(window.devicePixelRatio || 1, DRAW.MAX_DPR)
      const backingWidth = Math.round(box.width * dpr)
      const backingHeight = Math.round(box.height * dpr)
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth
        canvas.height = backingHeight
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, box.width, box.height)

      const landmarks = getLandmarks()
      if (!landmarks || landmarks.length === 0) return
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) return

      // A camera switch changes the intrinsic size under us. The canvas was cleared
      // above, so skipping this one frame shows nothing rather than the old camera's pose
      // stretched across the new one's letterbox.
      const geometry = `${video.videoWidth}x${video.videoHeight}`
      const settled = geometry === geometryRef.current
      geometryRef.current = geometry
      if (!settled) return

      const layout = coverLayout(video.videoWidth, video.videoHeight, box)
      paint(ctx, landmarks, layout, box, mirrored, faultRef.current ? DRAW.FAULT_STROKE : DRAW.CLEAN_STROKE)
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [getLandmarks, mirrored, videoRef])

  return <canvas ref={canvasRef} className="skeleton" aria-hidden="true" />
}
