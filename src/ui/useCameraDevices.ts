/**
 * The live device list behind the picker.
 *
 * WHY THIS IS A SUBSCRIPTION AND NOT A ONE-SHOT READ: a Continuity iPhone is not a
 * fixed part of the machine. It appears when the phone wakes near the Mac and vanishes
 * when it sleeps or leaves the room, so a list read once at mount is the list of the
 * cameras that happened to exist at mount. Every consumer here re-lists off
 * `onCameraChange`, which is the only reason the camera the user wants is in the list
 * they are looking at.
 *
 * ENUMERATING IS FREE, PREVIEWING IS NOT. `listCameras()` turns no camera on and
 * lights no indicator, so this hook runs whether or not the picker is open — the
 * collapsed strip has to be able to name the selected camera, and an iPhone arriving
 * has to be noticeable before the user opens anything. The camera itself is only ever
 * opened by useCameraPreview, and only while the picker is open.
 *
 * WITHHELD LABELS ARE A STATE, NOT AN ERROR. Before a successful getUserMedia the
 * browser hands back entries with no usable name, which is why `requestLabels` exists:
 * it takes a grant, stops the tracks it was given immediately (the grant outlives the
 * stream; a camera light does not need to), then re-lists so the names arrive.
 *
 * DEBOUNCED ON PURPOSE. One iPhone waking up fires `devicechange` several times in a
 * few hundred milliseconds. Re-listing on each one produces a list that visibly
 * flickers, and — worse — an arrival diff computed against a half-built list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CameraDevice } from '../pose/cameras'
import { CAMERA_PICKER, listCameras, onCameraChange } from '../pose/cameras'
import { CAMERA_PICKER_COPY, CAMERA_PICKER_UI, arrivalNote, arrivedIds } from './cameraPickerView'

/**
 * Distinguishes "no camera API" from "no cameras", which `listCameras()` deliberately
 * flattens to the same empty array. The two need different sentences.
 */
export function cameraApiAvailable(): boolean {
  if (typeof navigator === 'undefined') return false
  const media = navigator.mediaDevices as MediaDevices | undefined
  return typeof media?.enumerateDevices === 'function'
}

/** What just changed, held together so one timer can clear both. */
interface Arrival {
  readonly ids: readonly string[]
  readonly note: string | null
}

export interface CameraDevicesState {
  readonly cameras: readonly CameraDevice[]
  readonly apiAvailable: boolean
  /** True until the first list resolves, so the UI can avoid claiming "no cameras". */
  readonly listing: boolean
  readonly grantError: string | null
  /** Ids that appeared on the last refresh — marked briefly, then forgotten. */
  readonly freshIds: readonly string[]
  /** A sentence about the arrival, for the live region. Null most of the time. */
  readonly arrival: string | null
  readonly refresh: () => void
  /** Take a camera grant so the browser stops withholding device names. */
  readonly requestLabels: () => void
}

/**
 * Takes a grant and gives the camera straight back. The permission is what we want;
 * the stream is not, and leaving it open would light the indicator for nothing.
 */
async function earnLabelGrant(): Promise<void> {
  const media = navigator.mediaDevices as MediaDevices | undefined
  if (typeof media?.getUserMedia !== 'function') throw new Error(CAMERA_PICKER_COPY.unsupported)
  const stream = await media.getUserMedia({ video: true, audio: false })
  for (const track of stream.getTracks()) track.stop()
}

export function useCameraDevices(): CameraDevicesState {
  const [cameras, setCameras] = useState<readonly CameraDevice[]>([])
  /**
   * Starts true only when there is an API to wait for. With no API the answer is known
   * before the first effect runs, and "looking for cameras" would be a lie told in the
   * one state where the search is over before it starts.
   */
  const [listing, setListing] = useState(cameraApiAvailable)
  const [grantError, setGrantError] = useState<string | null>(null)
  const [arrival, setArrival] = useState<Arrival | null>(null)
  /** The list the last diff was taken against. A ref, so refresh stays stable. */
  const known = useRef<readonly CameraDevice[]>([])
  const alive = useRef(true)
  const apiAvailable = cameraApiAvailable()

  const apply = useCallback((next: readonly CameraDevice[]) => {
    const previous = known.current
    known.current = next
    const ids = arrivedIds(previous, next)
    const note = arrivalNote(previous, next)
    if (ids.length > 0 || note) setArrival({ ids, note })
    setCameras(next)
    setListing(false)
  }, [])

  const refresh = useCallback(() => {
    if (!cameraApiAvailable()) {
      setListing(false)
      return
    }
    listCameras()
      .then((next) => {
        if (alive.current) apply(next)
      })
      .catch((error: unknown) => {
        // listCameras() is documented never to throw; if that ever changes, a broken
        // list must not take the intro screen down with it.
        console.warn('[spotter] could not list cameras', error)
        if (alive.current) setListing(false)
      })
  }, [apply])

  useEffect(() => {
    alive.current = true
    refresh()

    let debounce: number | null = null
    const stop = onCameraChange(() => {
      if (debounce !== null) window.clearTimeout(debounce)
      // The device layer owns this number: it is a property of how the OS publishes a
      // camera, not of how this screen feels.
      debounce = window.setTimeout(refresh, CAMERA_PICKER.REFRESH_DEBOUNCE_MS)
    })

    return () => {
      alive.current = false
      if (debounce !== null) window.clearTimeout(debounce)
      stop()
    }
  }, [refresh])

  // The mark is a moment, not a state: a row that stayed highlighted would read as a
  // permanent property of that camera rather than as "this just showed up".
  useEffect(() => {
    if (!arrival) return undefined
    const timer = window.setTimeout(() => setArrival(null), CAMERA_PICKER_UI.arrivalMarkMs)
    return () => window.clearTimeout(timer)
  }, [arrival])

  const requestLabels = useCallback(() => {
    setGrantError(null)
    earnLabelGrant()
      .then(refresh)
      .catch((error: unknown) => {
        console.warn('[spotter] camera label grant refused', error)
        if (alive.current) setGrantError(CAMERA_PICKER_COPY.grantRefused)
      })
  }, [refresh])

  return {
    cameras,
    apiAvailable,
    listing,
    grantError,
    freshIds: arrival?.ids ?? [],
    arrival: arrival?.note ?? null,
    refresh,
    requestLabels,
  }
}
