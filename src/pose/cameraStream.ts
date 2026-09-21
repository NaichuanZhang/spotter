/**
 * Opening a camera, in the parts that are DECISIONS rather than DOM.
 *
 * `poseEngine.ts` stays the only file that touches a `<video>` element; everything here
 * is constraint building, failure classification, one-shot fallback and switch ordering,
 * so all of it can be driven by an injected `getUserMedia` in a test. The engine's own
 * shell (srcObject, play(), requestAnimationFrame) remains browser-only.
 *
 * FOUR THINGS THAT WILL BITE, all of them specific to letting the user CHOOSE a camera:
 *
 * 1. `deviceId: {exact: id}` FAILS HARD when that device is gone — a remembered iPhone
 *    Continuity Camera is gone the moment the phone sleeps or leaves the room. So a pinned
 *    request retries ONCE without the pin (`openCameraStream`), reports `fellBack`, and the
 *    caller says so out loud. A camera the user picked yesterday must not brick startup.
 * 2. A DENIAL IS NOT A MISSING DEVICE. `NotAllowedError` must never be retried: dropping
 *    the pin and asking again would either re-prompt or, worse, succeed on a DIFFERENT
 *    camera than the one the user chose. Only the "that device is not here" family retries.
 * 3. WHAT OPENED IS NOT WHAT WAS ASKED FOR. `deviceId` is read back from the live track's
 *    `getSettings()`, never from the request, because after a fallback those two differ and
 *    the UI must show reality.
 * 4. TWO CLICKS IN A ROW MUST NOT LEAVE TWO STREAMS LIVE. `getUserMedia` is slow enough for
 *    a user to out-click it. `createCameraOwner` stops the old tracks BEFORE it acquires,
 *    stamps every request with a sequence number, and the loser of a race stops the stream
 *    it just opened rather than attaching it — otherwise the camera light stays on for a
 *    stream nothing is reading.
 *
 * The structural `CameraStream` / `CameraTrack` types are the slice of `MediaStream` used
 * here. Real `MediaStream` satisfies them, and so does a plain object in a test, which is
 * why this module needs no DOM.
 */

/** Tunables and the error-name tables. Recalibrate here, nowhere else. */
export const CAMERA_STREAM = {
  /**
   * DOMException names meaning "the device you pinned is not available", as opposed to
   * "the camera is unusable". Each is a legitimate answer to `deviceId: {exact}` and each
   * is worth ONE retry on the default camera:
   *   OverconstrainedError / ConstraintNotSatisfiedError — no device matches the pin
   *   NotFoundError  — the device is gone (iPhone asleep, webcam unplugged)
   *   NotReadableError — the device is there but another app holds it
   */
  unavailableNames: [
    'OverconstrainedError',
    'ConstraintNotSatisfiedError',
    'NotFoundError',
    'DevicesNotFoundError',
    'NotReadableError',
    'TrackStartError',
  ] as readonly string[],
  /** Permission failures. NEVER retried — see trap 2 in the file header. */
  deniedNames: ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'] as readonly string[],
  /** The constraint an OverconstrainedError names when the pin is what failed. */
  deviceConstraint: 'deviceId',
} as const

// ------------------------------------------------------------- structural types

export interface CameraTrack {
  readonly kind?: string
  getSettings(): { readonly deviceId?: string }
  stop(): void
  addEventListener(type: 'ended', listener: () => void): void
  removeEventListener(type: 'ended', listener: () => void): void
}

export interface CameraStream {
  getTracks(): readonly CameraTrack[]
}

export type GetUserMedia<S extends CameraStream> = (constraints: MediaStreamConstraints) => Promise<S>

export type CameraFailure = 'denied' | 'device_unavailable' | 'failed'

export interface OpenedCamera<S extends CameraStream> {
  readonly stream: S
  /** Read back from the LIVE track, not from the request. Null when the browser withholds it. */
  readonly deviceId: string | null
  /** What was asked for, kept so a caller can say which camera it could not open. */
  readonly requestedDeviceId: string | null
  /** True when the pinned device was unavailable and the default camera opened instead. */
  readonly fellBack: boolean
}

// -------------------------------------------------------------------- pure bits

/**
 * `base` plus the pin. When a device is pinned, `facingMode` is DROPPED: it exists to pick
 * a camera, the pin has already picked one, and an advisory front/back preference that
 * disagrees with the user's explicit choice can only lower that device's fitness score.
 */
export function videoConstraints(base: MediaTrackConstraints, deviceId: string | null): MediaStreamConstraints {
  if (!deviceId) return { video: { ...base }, audio: false }
  const { facingMode: _dropped, ...rest } = base
  return { video: { ...rest, deviceId: { exact: deviceId } }, audio: false }
}

function errorName(error: unknown): string {
  if (error instanceof DOMException) return error.name
  if (error instanceof Error) return error.name
  // OverconstrainedError is not a DOMException in every engine; some report a plain object.
  if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name
  }
  return ''
}

/** True when the failure blames the pin itself rather than the camera in general. */
export function namesRequestedDevice(error: unknown, deviceId: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const detail = error as { constraint?: unknown; message?: unknown }
  if (detail.constraint === CAMERA_STREAM.deviceConstraint) return true
  return typeof detail.message === 'string' && detail.message.includes(deviceId)
}

/**
 * Three outcomes, because they need three different reactions: re-prompting is pointless
 * for a denial, a retry is right for a vanished device, and anything else is a real fault.
 */
export function classifyCameraError(error: unknown, requestedDeviceId: string | null): CameraFailure {
  const name = errorName(error)
  if (CAMERA_STREAM.deniedNames.includes(name)) return 'denied'
  if (CAMERA_STREAM.unavailableNames.includes(name)) return 'device_unavailable'
  if (requestedDeviceId !== null && namesRequestedDevice(error, requestedDeviceId)) return 'device_unavailable'
  return 'failed'
}

function videoTrack(stream: CameraStream): CameraTrack | null {
  // `kind` is optional on the structural type; an undefined kind is treated as video
  // because a fake with one track is unambiguous.
  return stream.getTracks().find((track) => track.kind === undefined || track.kind === 'video') ?? null
}

/** The deviceId actually in use. Null when the track is gone or the browser withholds it. */
export function streamDeviceId(stream: CameraStream): string | null {
  return videoTrack(stream)?.getSettings().deviceId ?? null
}

export function stopStream(stream: CameraStream): void {
  for (const track of stream.getTracks()) track.stop()
}

// ------------------------------------------------------------------ acquisition

export interface OpenCameraRequest<S extends CameraStream> {
  readonly base: MediaTrackConstraints
  readonly deviceId: string | null
  readonly getUserMedia: GetUserMedia<S>
}

/**
 * Acquire a stream, retrying ONCE without the pin when the pinned device is unavailable.
 *
 * Failures are re-thrown raw and unwrapped — mapping them onto a user-facing error is the
 * engine's job, and this module has no vocabulary for it. Nothing is swallowed, and the
 * retry is deliberately not recursive: one fallback, then the failure stands.
 */
export async function openCameraStream<S extends CameraStream>(
  request: OpenCameraRequest<S>,
): Promise<OpenedCamera<S>> {
  const requested = request.deviceId ?? null
  try {
    const stream = await request.getUserMedia(videoConstraints(request.base, requested))
    return { stream, deviceId: streamDeviceId(stream), requestedDeviceId: requested, fellBack: false }
  } catch (cause) {
    if (requested === null) throw cause
    if (classifyCameraError(cause, requested) !== 'device_unavailable') throw cause
    const stream = await request.getUserMedia(videoConstraints(request.base, null))
    return { stream, deviceId: streamDeviceId(stream), requestedDeviceId: requested, fellBack: true }
  }
}

// ----------------------------------------------------------------- the owner

export interface CameraOwnerOptions<S extends CameraStream> {
  readonly base: MediaTrackConstraints
  readonly getUserMedia: GetUserMedia<S>
  /** Put the stream on screen. Runs only after the previous stream has been stopped. */
  readonly attach: (stream: S) => Promise<void> | void
  /** The live track ended on its own: the phone slept, the USB cable moved. */
  readonly onTrackEnded?: (deviceId: string | null) => void
}

export interface CameraOwner<S extends CameraStream> {
  /**
   * Stop whatever is live, open `deviceId` (null = browser default) and attach it.
   * Resolves null when a LATER request superseded this one — the loser's stream is
   * stopped, never attached. Rejects with the raw `getUserMedia` failure.
   */
  acquire(deviceId: string | null): Promise<OpenedCamera<S> | null>
  /** Stop the live stream and invalidate anything in flight. */
  release(): void
  current(): S | null
  /** deviceId of the live stream, read back from its track. */
  deviceId(): string | null
}

export function createCameraOwner<S extends CameraStream>(options: CameraOwnerOptions<S>): CameraOwner<S> {
  let live: S | null = null
  let liveDeviceId: string | null = null
  let unwatch: (() => void) | null = null
  /**
   * Monotonic request stamp. Bumped SYNCHRONOUSLY at the top of every acquire, which is
   * what makes "the last request wins" true: a request that finds the stamp changed knows
   * a newer one started, and cannot have attached after it.
   */
  let sequence = 0

  function releaseLive(): void {
    unwatch?.()
    unwatch = null
    if (live) stopStream(live)
    live = null
    liveDeviceId = null
  }

  function watchEnded(stream: S, deviceId: string | null, token: number): () => void {
    const track = videoTrack(stream)
    if (!track) return () => undefined
    const handler = (): void => {
      // A stale track's `ended` is not news: that stream is already stopped and replaced.
      if (token !== sequence) return
      options.onTrackEnded?.(deviceId)
    }
    track.addEventListener('ended', handler)
    return () => track.removeEventListener('ended', handler)
  }

  async function acquire(deviceId: string | null): Promise<OpenedCamera<S> | null> {
    const token = ++sequence
    // OLD TRACKS FIRST. Two live streams mean two camera lights and, on macOS, a
    // Continuity iPhone that refuses the second open because it is already in use.
    releaseLive()

    const opened = await openCameraStream({ base: options.base, deviceId, getUserMedia: options.getUserMedia })
    if (token !== sequence) {
      stopStream(opened.stream)
      return null
    }

    try {
      await options.attach(opened.stream)
    } catch (cause) {
      stopStream(opened.stream)
      // A failure that happened BECAUSE this request was superseded is not news worth
      // reporting: the winner reassigning srcObject is exactly what aborts a pending
      // play(), and surfacing that as "could not switch cameras" would put an error on
      // screen about a camera that is working.
      if (token !== sequence) return null
      throw cause
    }
    if (token !== sequence) {
      // Superseded while attaching. The winner started after this token check, so it will
      // attach its own stream; ours is nobody's, and only we can stop it.
      stopStream(opened.stream)
      return null
    }

    live = opened.stream
    liveDeviceId = opened.deviceId
    unwatch = watchEnded(opened.stream, opened.deviceId, token)
    return opened
  }

  return {
    acquire,
    release(): void {
      // Bumping the stamp is what makes an in-flight acquire stop its own stream instead
      // of attaching it to an element the caller has already finished with.
      sequence += 1
      releaseLive()
    },
    current: () => live,
    deviceId: () => liveDeviceId,
  }
}
