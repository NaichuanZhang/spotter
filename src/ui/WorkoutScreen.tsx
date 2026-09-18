/**
 * The workout screen: the user is full-bleed, the data is glass in the corner.
 *
 * Exactly two video surfaces live here — the camera and the reference clip. That
 * is only possible because the avatar is confined to the intro; a third moving
 * rectangle would turn the layout into a control room.
 *
 * Camera ownership: the pose engine is expected to attach the stream to the
 * element we hand up via onVideoReady. If it has not done so shortly after mount
 * we acquire the stream ourselves, because a black rectangle on stage is fatal and
 * a duplicate getUserMedia call is not.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GetHeartRateResult, PersonaId } from '../types/tools'
import type { WorkoutState } from '../types/events'
import Hud from './Hud'
import type { ConnState } from './Hud'
import PersonaRail from './PersonaRail'
import FaultChip, { useFaultLatch } from './FaultChip'
import type { FaultCandidate } from './FaultChip'
import Captions from './Captions'
import type { Utterance } from './Captions'
import ReferenceClip from './ReferenceClip'
import type { ReferenceClipSpec } from './ReferenceClip'
import SkeletonOverlay from './SkeletonOverlay'
import type { LandmarkSource } from './SkeletonOverlay'

/** Camera behaviour. Recalibrate here, nowhere else. */
const CAMERA = {
  /** Grace period for the pose engine to attach its own stream first. */
  FALLBACK_DELAY_MS: 1200,
  CONSTRAINTS: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
  } as MediaTrackConstraints,
} as const

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

async function acquireCamera(): Promise<MediaStream> {
  const media = navigator.mediaDevices
  if (!media || typeof media.getUserMedia !== 'function') {
    throw new Error('No camera API in this browser — SPOTTER needs https or localhost.')
  }
  return media.getUserMedia({ video: CAMERA.CONSTRAINTS, audio: false })
}

interface WorkoutScreenProps {
  readonly persona: PersonaId
  readonly onPersona: (persona: PersonaId) => void
  readonly workout: WorkoutState
  readonly fps: number
  /** Simulated heart rate, already lifted into App state — never read from a ref. */
  readonly heart: GetHeartRateResult
  readonly conn: ConnState
  readonly offline: boolean
  readonly summary: string | null
  readonly faultCandidate: FaultCandidate | null
  readonly utterance: Utterance | null
  readonly captionsEnabled: boolean
  readonly clip: ReferenceClipSpec | null
  readonly onDismissClip: () => void
  readonly getLandmarks: LandmarkSource
  /**
   * Hand the element to the pose engine. Returns true when the engine has CLAIMED
   * it — meaning the engine owns the camera from here and this component must not
   * touch srcObject again.
   *
   * The return value has to be synchronous. The engine claims the element before
   * it awaits getUserMedia, so `element.srcObject` stays null for as long as the
   * permission prompt is on screen. The fallback below used to test srcObject,
   * which meant a slow "Allow" click opened a SECOND camera stream and the two
   * assignments aborted each other's play() — the AbortError this comment exists
   * to prevent coming back.
   */
  readonly onVideoReady: (video: HTMLVideoElement) => boolean
}

export default function WorkoutScreen({
  persona,
  onPersona,
  workout,
  fps,
  heart,
  conn,
  offline,
  summary,
  faultCandidate,
  utterance,
  captionsEnabled,
  clip,
  onDismissClip,
  getLandmarks,
  onVideoReady,
}: WorkoutScreenProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const ownedStreamRef = useRef<MediaStream | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const latched = useFaultLatch(faultCandidate)

  const takeOverCamera = useCallback((element: HTMLVideoElement) => {
    acquireCamera()
      .then((stream) => {
        ownedStreamRef.current = stream
        element.srcObject = stream
        return element.play()
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        console.error('[spotter] camera could not be started:', detail)
        setCameraError(detail)
      })
  }, [])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return undefined
    element.muted = true
    const claimed = onVideoReady(element)

    let cancelled = false
    // Only ever arm the fallback when NOTHING claimed the element. Racing the
    // engine on a timer opens a second getUserMedia and both plays abort.
    const timer = claimed
      ? null
      : window.setTimeout(() => {
          if (cancelled || element.srcObject) return
          takeOverCamera(element)
        }, CAMERA.FALLBACK_DELAY_MS)

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      const owned = ownedStreamRef.current
      if (owned) {
        stopStream(owned)
        ownedStreamRef.current = null
      }
    }
  }, [onVideoReady, takeOverCamera])

  return (
    <main className="workout">
      {/* NO autoPlay: assigning srcObject would make the browser start its own
          load, which interrupts the explicit play() the pose engine awaits and
          throws AbortError. play() is called deliberately by whoever owns the
          stream. muted + playsInline stay — iOS Safari needs both. */}
      <video ref={videoRef} className="workout__video" muted playsInline />
      <SkeletonOverlay videoRef={videoRef} getLandmarks={getLandmarks} faultActive={latched !== null} />
      <div className="workout__tint" aria-hidden="true" />
      <div className="workout__rim" aria-hidden="true" />
      <div className="workout__scrim" aria-hidden="true" />

      <div className="workout__ui">
        <div className="workout__top">
          <Hud
            target={workout.target}
            totalReps={workout.totalReps}
            cleanReps={workout.cleanReps}
            elapsedSec={workout.setElapsedSec}
            fps={fps}
            heart={heart}
            conn={conn}
            offline={offline}
            inFrame={workout.inFrame}
            summary={summary}
            compact={clip !== null}
          >
            <ReferenceClip clip={clip} onDismiss={onDismissClip} />
          </Hud>
          <PersonaRail persona={persona} onSelect={onPersona} />
        </div>

        <div className="workout__mid">
          <FaultChip latched={latched} />
        </div>

        <div className="workout__bottom">
          <Captions utterance={utterance} persona={persona} enabled={captionsEnabled} />
        </div>
      </div>

      {cameraError ? (
        <div className="workout__error" role="alert">
          <strong>Camera unavailable.</strong>
          <span>{cameraError}</span>
          <span className="workout__errorHint">Allow camera access, then reload.</span>
        </div>
      ) : null}
    </main>
  )
}
