/**
 * The picker's live preview stream. A list of device names cannot answer the only
 * question the user actually has — "which of these is pointing at the floor?" — so the
 * picker shows the picture. This hook owns that stream and nothing else.
 *
 * FOUR RULES, each of them a bug that happens the moment it is broken.
 *
 * 1. ONE STREAM AT A TIME, OLD TRACKS STOPPED BEFORE THE NEW srcObject. The effect's
 *    cleanup runs before the next effect body, so switching deviceId stops the previous
 *    camera first. Assigning a second srcObject over a live one makes the browser abort
 *    the play() of the first — the AbortError this codebase already paid for once.
 * 2. AN AbortError WITH FRAMES ON SCREEN IS NOT A FAILURE. React 19 StrictMode
 *    double-invokes effects in dev, and a superseded load rejects the play() of a
 *    stream that is nonetheless painting. So a rejected play() is only reported when
 *    the element has not reached HAVE_CURRENT_DATA.
 * 3. A TRACK CAN END UNDER YOU. If the previewed iPhone sleeps, the track fires `ended`
 *    and the element holds a frozen frame with no error anywhere. That is indis-
 *    tinguishable from a working preview, which is why `ended` is subscribed and
 *    surfaced as a status of its own, and why `onLost` exists — the caller re-lists,
 *    because the device is on its way out of the list too.
 * 4. NOTHING KEEPS THE CAMERA OPEN AFTER THE UI IS GONE. `enabled` false, an unmount,
 *    or a deviceId change all stop every track. A camera indicator still lit after the
 *    user has moved on is conspicuous, and on this screen it would be lit while the
 *    user reads about privacy.
 *
 * The status is deliberately five-valued rather than a boolean plus an error: 'off' and
 * 'starting' look identical in a boolean and must not look identical on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { PreviewStatus } from './cameraPickerView'
import { CAMERA_PICKER_COPY, CAMERA_PICKER_UI, previewConstraints, previewFailure } from './cameraPickerView'

export interface CameraPreview {
  readonly videoRef: RefObject<HTMLVideoElement | null>
  readonly status: PreviewStatus
  /** A sentence, or null. Set for 'lost' as well as 'failed'. */
  readonly error: string | null
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/** Muted and explicit: no autoPlay attribute anywhere near a stream this app owns. */
function attach(element: HTMLVideoElement, stream: MediaStream): void {
  element.muted = true
  element.srcObject = stream
  void element.play().catch((error: unknown) => {
    // Rule 2: frames are flowing, so whatever was aborted did not matter.
    if (element.readyState >= CAMERA_PICKER_UI.canPaint) return
    console.warn('[spotter] camera preview play refused', error)
  })
}

function detach(element: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (stream) stopStream(stream)
  if (element && element.srcObject) element.srcObject = null
}

export function useCameraPreview(
  deviceId: string | null,
  enabled: boolean,
  onLost?: () => void,
): CameraPreview {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('off')
  const [error, setError] = useState<string | null>(null)
  /** Held in a ref so a caller's inline callback cannot restart the camera. */
  const lost = useRef(onLost)
  useEffect(() => {
    lost.current = onLost
  }, [onLost])

  const fail = useCallback((message: string) => {
    setStatus('failed')
    setError(message)
  }, [])

  useEffect(() => {
    const element = videoRef.current
    if (!enabled || !element) {
      detach(element, streamRef.current)
      streamRef.current = null
      setStatus('off')
      setError(null)
      return undefined
    }

    const media = navigator.mediaDevices as MediaDevices | undefined
    if (typeof media?.getUserMedia !== 'function') {
      fail(CAMERA_PICKER_COPY.previewUnsupported)
      return undefined
    }

    let cancelled = false
    setStatus('starting')
    setError(null)

    const handleEnded = () => {
      if (cancelled) return
      console.warn('[spotter] camera preview track ended')
      setStatus('lost')
      setError(CAMERA_PICKER_COPY.previewLost)
      lost.current?.()
    }

    media
      .getUserMedia({ video: previewConstraints(deviceId), audio: false })
      .then((stream) => {
        if (cancelled) {
          stopStream(stream)
          return
        }
        // Rule 1: whatever was there goes first, even if a previous cleanup already
        // did it — stopping a stopped track is a no-op, opening two is not.
        detach(element, streamRef.current)
        streamRef.current = stream
        for (const track of stream.getTracks()) {
          track.addEventListener('ended', handleEnded, { once: true })
        }
        attach(element, stream)
        setStatus('live')
      })
      .catch((error_: unknown) => {
        if (cancelled) return
        console.warn('[spotter] camera preview could not open', error_)
        fail(previewFailure(error_))
      })

    return () => {
      cancelled = true
      detach(element, streamRef.current)
      streamRef.current = null
    }
  }, [deviceId, enabled, fail])

  return { videoRef, status, error }
}
