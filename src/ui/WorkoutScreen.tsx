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
 *
 * THAT FALLBACK IS THE SECOND getUserMedia CALL SITE IN THE APP, so it honours
 * `cameraDeviceId` too. A slow "Allow" click used to be all it took for the engine
 * to open the chosen iPhone while this path opened the lid camera on top of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { openCameraStream, stopStream } from '../pose/cameraStream'
import type { OpenedCamera } from '../pose/cameraStream'
import type { PersonaId } from '../types/tools'
import type { WorkoutState } from '../types/events'
import type { MicState } from '../coach/micUplink'
import type { TrackId } from '../coach/musicPlayer'
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

/**
 * Same acquisition rules as the engine (`pose/cameraStream.ts`): pin the chosen device,
 * and if that device has gone home in someone's pocket, open the default camera once
 * rather than leaving the stage black.
 */
async function acquireCamera(deviceId: string | null): Promise<OpenedCamera<MediaStream>> {
  const media = navigator.mediaDevices
  if (!media || typeof media.getUserMedia !== 'function') {
    throw new Error('No camera API in this browser — SPOTTER needs https or localhost.')
  }
  return openCameraStream({
    base: CAMERA.CONSTRAINTS,
    deviceId,
    getUserMedia: (constraints) => media.getUserMedia(constraints),
  })
}

interface WorkoutScreenProps {
  readonly persona: PersonaId
  readonly onPersona: (persona: PersonaId) => void
  readonly workout: WorkoutState
  readonly fps: number
  readonly conn: ConnState
  readonly offline: boolean
  /** Mic uplink health, straight from the coach session. */
  readonly mic: MicState
  /** Track currently playing, or null. */
  readonly musicTrack: TrackId | null
  readonly summary: string | null
  readonly faultCandidate: FaultCandidate | null
  readonly utterance: Utterance | null
  readonly captionsEnabled: boolean
  readonly clip: ReferenceClipSpec | null
  readonly onDismissClip: () => void
  readonly getLandmarks: LandmarkSource
  /**
   * The camera the user chose, or null for "let the browser pick". Only used by the
   * fallback path below — the engine gets the same value directly from App.
   */
  readonly cameraDeviceId?: string | null
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
  conn,
  offline,
  mic,
  musicTrack,
  summary,
  faultCandidate,
  utterance,
  captionsEnabled,
  clip,
  onDismissClip,
  getLandmarks,
  cameraDeviceId = null,
  onVideoReady,
}: WorkoutScreenProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const ownedStreamRef = useRef<MediaStream | null>(null)
  /**
   * Read by the fallback TIMER, which fires 1200 ms after mount and must use whatever
   * camera is selected by then. A ref, not a dep: `takeOverCamera` is a dependency of the
   * claim effect below, and re-running that effect is the AbortError this file is about.
   */
  const deviceIdRef = useRef<string | null>(cameraDeviceId)
  /**
   * True once the fallback has taken the element over — i.e. the engine never claimed it.
   * Separate from `ownedStreamRef` on purpose: during a switch that ref is briefly null,
   * and a second switch arriving in that gap must still know the fallback is the owner.
   * Testing the stream instead left the stage black for the rest of the set.
   */
  const fallbackOwnsRef = useRef(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const latched = useFaultLatch(faultCandidate)

  const failCamera = useCallback((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[spotter] camera could not be started:', detail)
    setCameraError(detail)
  }, [])

  const takeOverCamera = useCallback(
    (element: HTMLVideoElement) => {
      fallbackOwnsRef.current = true
      acquireCamera(deviceIdRef.current)
        .then((opened) => {
          ownedStreamRef.current = opened.stream
          element.srcObject = opened.stream
          if (opened.fellBack) {
            console.warn('[spotter] the chosen camera is unavailable — opened the default camera instead.')
          }
          return element.play()
        })
        .catch(failCamera)
    },
    [failCamera],
  )

  useEffect(() => {
    deviceIdRef.current = cameraDeviceId
  }, [cameraDeviceId])

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
      fallbackOwnsRef.current = false
      const owned = ownedStreamRef.current
      if (owned) {
        stopStream(owned)
        ownedStreamRef.current = null
      }
    }
  }, [onVideoReady, takeOverCamera])

  /**
   * Follow the selection while WE own the stream — i.e. only in the world where the engine
   * never claimed the element. When the engine did claim it, `fallbackOwnsRef` is false and
   * this is a no-op: switching is the engine's job and two owners would fight over
   * srcObject. Stop first, then acquire, so the old camera light goes out.
   */
  useEffect(() => {
    const element = videoRef.current
    if (!element || !fallbackOwnsRef.current) return undefined

    let cancelled = false
    const owned = ownedStreamRef.current
    if (owned) {
      stopStream(owned)
      ownedStreamRef.current = null
    }
    acquireCamera(cameraDeviceId)
      .then((opened) => {
        if (cancelled) {
          // Superseded by a newer choice: stop what we opened rather than leave it live.
          stopStream(opened.stream)
          return undefined
        }
        ownedStreamRef.current = opened.stream
        element.srcObject = opened.stream
        return element.play()
      })
      .catch((error: unknown) => {
        if (!cancelled) failCamera(error)
      })

    return () => {
      cancelled = true
    }
  }, [cameraDeviceId, failCamera])

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
            conn={conn}
            offline={offline}
            inFrame={workout.inFrame}
            mic={mic}
            musicTrack={musicTrack}
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
