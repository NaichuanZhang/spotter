/**
 * The only impure file in this package: camera, MediaPipe, requestAnimationFrame.
 *
 * It owns no measurement logic. Every decision is delegated to the pure modules and
 * threaded through immutably:
 *
 *     landmarks -> measureAngles -> median smoothing -> repMachine -> faults -> gate -> emit
 *
 * THE INVERSION: this engine INITIATES. It decides what is worth saying and pushes a
 * `CoachEvent` out; the model reacts. Nothing here ever asks the model a question.
 *
 * TWO THINGS THAT WILL BITE:
 *
 * 1. `detectForVideo(video, timestamp)` — the timestamp is REQUIRED in all four
 *    shipped overloads, even though Google's own sample omits it. Omitting it does
 *    not throw; it silently returns garbage landmarks. There is no error to catch,
 *    so there is nothing to notice until the rep counter is simply wrong.
 * 2. Assets are loaded from LOCAL `/vendor/` paths, never a CDN. Venue wifi is the
 *    single most likely thing to break this demo, and a CDN fetch inside
 *    `FilesetResolver` is an unrecoverable startup failure.
 *
 * Clock: `performance.now()` throughout, so every `at` in every event and every
 * duration shares one monotonic timeline. Do not mix in `Date.now()` — a clock
 * adjustment mid-set would produce negative tempos.
 *
 * WHICH CAMERA: `options.deviceId` pins one (a propped-up iPhone sees a person on the
 * floor; a laptop lid does not), and `switchCamera` changes it mid-set without touching
 * the PoseLandmarker — the model costs seconds to build and knows nothing about which
 * camera fed it. Everything about choosing, falling back and racing lives in
 * `cameraStream.ts`, which is testable; what stays here is the `<video>` element.
 *
 * TUNABLES LIVE IN: `ENGINE_CONFIG` (this file), `CAMERA_STREAM` (cameraStream.ts).
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { CameraOwner, OpenedCamera } from './cameraStream'
import { classifyCameraError, createCameraOwner } from './cameraStream'
import type { CameraView, CoachEvent, FaultType, RepMetrics, WorkoutState } from '../types/events'
import type { PoseAngles } from './angles'
import { measureAngles } from './angles'
import type { FaultCandidate, GateState } from './faults'
import {
  canSpeak,
  createGateState,
  evaluateFaults,
  evaluateRepFaults,
  gate,
  noteUtterance,
  UTTERANCE_RANK,
} from './faults'
import type { Landmark } from './landmarks'
import { bodyLineInFrame, countingInFrame } from './landmarks'
import type { ObservabilityState } from './observability'
import { createObservabilityState, OBSERVABILITY, stepObservability } from './observability'
import type { RepMachineState } from './repMachine'
import { createRepMachineState, step, syntheticRep } from './repMachine'
import type { AngleWindows } from './smoothing'
import { createAngleWindows, pushAngles, smoothedAngles } from './smoothing'

export const ENGINE_CONFIG = {
  /**
   * Vendored MediaPipe assets, served by Vite from `public/`. `wasmBase` is the
   * directory holding `vision_wasm_internal.js` + `.wasm`; `modelPath` is the
   * `.task` bundle. This is the contract with `scripts/fetch-mediapipe.mjs`.
   *
   * These two strings MUST match what `npm run vendor:mediapipe` writes, and
   * nothing in the type system or the bundler can check that for you — a wrong
   * path here fails at runtime inside `FilesetResolver`, which is an
   * unrecoverable startup failure. The script writes:
   *     public/vendor/pose_landmarker_full.task   (the FULL model, byte-verified)
   *     public/vendor/wasm/<6 files>
   * so there is no `mediapipe/` segment and the model is `full`, not `lite`.
   */
  assets: {
    wasmBase: '/vendor/wasm',
    modelPath: '/vendor/pose_landmarker_full.task',
  },
  /** Requested capture size. A whole body must fit, so wide beats tall. */
  video: { width: 960, height: 720, facingMode: 'user' as const },
  landmarker: {
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  },
  defaultTarget: 20,
  defaultView: 'side' as CameraView,
  /**
   * Consecutive frames without the COUNTING joints before announcing the user is gone.
   *
   * Counting joints, not all of them: losing the feet is not leaving the frame. That
   * situation has its own signal — see `OBSERVABILITY` and `form_unobservable` — because
   * "back up, I cannot see your hips" and "come back, I cannot see you" are different
   * sentences and only one of them is true when a phone on the floor crops the ankles.
   */
  outOfFrameFrames: 10,
  /** Consecutive good frames before announcing they are back. Higher = less flapping. */
  backInFrameFrames: 5,
  /** Elbow movement below this (degrees between frames) does not count as moving. */
  idleMotionDeg: 3,
  /** Stillness before the first `idle` event. */
  idleMs: 8000,
  /** ...and before each repeat, so the coach can nag without spamming. */
  idleRepeatMs: 15000,
  /** Sliding window for the fps readout. */
  fpsWindowMs: 1000,
} as const

export type PoseEngineErrorCode =
  | 'unsupported_browser'
  | 'camera_denied'
  | 'camera_failed'
  /**
   * The chosen camera was not available, so the DEFAULT one opened instead. Not fatal —
   * frames are flowing — but the user is watching a different camera than the one they
   * picked, and a remembered iPhone that went home with its owner is the common cause.
   */
  | 'camera_substituted'
  /**
   * The live track ended on its own: the Continuity iPhone slept, or the webcam was
   * unplugged. THE WORST VERSION OF THIS FAILURE IS SILENCE — a dead camera holds its
   * last frame, which looks exactly like a user holding still, so the rep counter simply
   * stops with no error anywhere. Hence its own code.
   */
  | 'camera_ended'
  | 'model_load_failed'
  | 'detect_failed'
  | 'listener_failed'

/** Every failure path produces one of these — nothing is swallowed. */
export class PoseEngineError extends Error {
  readonly code: PoseEngineErrorCode
  constructor(code: PoseEngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PoseEngineError'
    this.code = code
  }
}

export interface PoseEngineOptions {
  /** The <video> element the UI already has on screen. The engine does not create one. */
  video: HTMLVideoElement
  target?: number
  view?: CameraView
  assets?: Partial<typeof ENGINE_CONFIG.assets>
  /**
   * Which `videoinput` to open. Omitted (or undefined) behaves exactly as before: the
   * browser picks. A pinned device that has vanished falls back to the default camera and
   * reports `camera_substituted` rather than failing to start.
   */
  deviceId?: string
  /** Non-fatal, per-frame failures land here. Fatal startup failures reject `start`. */
  onError?: (error: PoseEngineError) => void
}

export type EventListener = (event: CoachEvent) => void

export interface PoseEngine {
  start(): Promise<void>
  stop(): void
  /** Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void
  getState(): WorkoutState
  /**
   * Raw landmarks from the most recent detected frame, for the skeleton overlay.
   * Null before the first detection and while no pose is found. Treat as read-only —
   * it is the array MediaPipe handed back, not a copy, because cloning 33 objects
   * per frame at 30fps buys nothing.
   */
  getLandmarks(): readonly Landmark[] | null
  /** Smoothed frames per second of the detect loop. 0 before the first second. */
  getFps(): number
  setView(view: CameraView): void
  setTarget(target: number): void
  /**
   * Change camera without tearing anything else down: the PoseLandmarker, the rep count
   * and the fault history all survive, because none of them is about which lens is
   * pointing at the user. Geometry-dependent caches are reset (see `resetGeometry`).
   *
   * Overlapping calls are safe — the LAST one wins and the losers stop the streams they
   * opened. Rejects when neither the requested camera nor the default one could be opened;
   * a request for a device that is simply gone resolves after falling back, reporting
   * `camera_substituted` through `onError`.
   */
  switchCamera(deviceId: string): Promise<void>
  /**
   * The deviceId of the camera actually running, read back from the live track rather
   * than from what was requested — after a fallback those two differ. Null before `start`
   * and after `stop`, and also when the browser withholds the id (no permission yet).
   */
  activeDeviceId(): string | null
  /**
   * DEV BUILDS ONLY: score a rep the camera did not see. A no-op in a production bundle —
   * the method stays on the interface so callers need no gate of their own, but the body is
   * compiled out. See the implementation for why it is gated rather than removed.
   */
  injectSyntheticRep(overrides?: Partial<RepMetrics>): void
  isRunning(): boolean
}

// ------------------------------------------------------------------- media setup

function requireCameraApi(): MediaDevices {
  const media = navigator.mediaDevices
  if (!media?.getUserMedia) {
    throw new PoseEngineError(
      'unsupported_browser',
      'This browser exposes no camera API. A secure context (https or localhost) is required.',
    )
  }
  return media
}

/**
 * Put a stream on the element and start it. The stream is NOT stopped here on failure —
 * `createCameraOwner` owns that, and two owners stopping one stream is how a working
 * camera gets torn down by the loser of a race.
 */
async function attachStream(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play().catch((cause: unknown) => {
    // An AbortError means a NEW load request superseded this play() — the browser
    // autoplaying, another owner reassigning srcObject, or a camera SWITCH landing while
    // this play() was still pending. It is only fatal if the element actually ended up not
    // playing; when frames are flowing the rejected promise is noise and tearing the
    // stream down here would kill a working camera. Checked via readyState rather than
    // `paused`, because `paused` is already false while a play() is still pending.
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    const flowing = video.readyState >= 2 /* HAVE_CURRENT_DATA */ && !video.ended
    if (aborted && flowing) return

    throw new PoseEngineError('camera_failed', 'The video element refused to play.', { cause })
  })
}

/** Raw `getUserMedia` failure -> the engine's vocabulary. Nothing is swallowed. */
function asCameraError(cause: unknown, requestedDeviceId: string | null): PoseEngineError {
  if (cause instanceof PoseEngineError) return cause
  const failure = classifyCameraError(cause, requestedDeviceId)
  if (failure === 'denied') {
    return new PoseEngineError('camera_denied', 'Camera permission was denied.', { cause })
  }
  // A device_unavailable that reaches here already survived the one fallback attempt in
  // `openCameraStream`, so the default camera failed too — there is nothing left to try.
  return new PoseEngineError('camera_failed', 'Could not open the camera.', { cause })
}

async function createLandmarker(assets: typeof ENGINE_CONFIG.assets): Promise<PoseLandmarker> {
  try {
    const fileset = await FilesetResolver.forVisionTasks(assets.wasmBase)
    return await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assets.modelPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputSegmentationMasks: false,
      ...ENGINE_CONFIG.landmarker,
    })
  } catch (cause) {
    throw new PoseEngineError(
      'model_load_failed',
      `Could not load the pose model from ${assets.modelPath}. ` +
        'Run `npm run vendor:mediapipe` — these assets are deliberately not fetched from a CDN.',
      { cause },
    )
  }
}

// ----------------------------------------------------------------------- engine

export function createPoseEngine(options: PoseEngineOptions): PoseEngine {
  const assets = { ...ENGINE_CONFIG.assets, ...options.assets }
  const listeners = new Set<EventListener>()

  let target = options.target ?? ENGINE_CONFIG.defaultTarget
  let view = options.view ?? ENGINE_CONFIG.defaultView

  let landmarker: PoseLandmarker | null = null
  let rafId: number | null = null
  let running = false
  let lastVideoTime = -1
  /** What the user asked for. May differ from what opened — see `activeDeviceId`. */
  let requestedDeviceId: string | null = options.deviceId ?? null
  let activeDevice: string | null = null

  let reps: RepMachineState = createRepMachineState()
  let windows: AngleWindows = createAngleWindows()
  let gateState: GateState = createGateState()
  let observability: ObservabilityState = createObservabilityState()
  let activeFaults: FaultType[] = []
  const faultsSeen = new Set<FaultType>()

  let setStartedAt: number | undefined
  let framed = true
  let badFrames = 0
  let goodFrames = 0
  let lastMotionAt = 0
  let lastIdleAt: number | null = null
  let lastElbow: number | null = null
  let frameStamps: number[] = []
  let latestLandmarks: readonly Landmark[] | null = null

  const fail = (error: PoseEngineError): void => options.onError?.(error)

  /**
   * The camera, and the only thing in this file that owns a MediaStream. It stops the old
   * tracks before acquiring, so a switch can never leave two streams — and two camera
   * lights — live, and it orders overlapping switches so the last click wins.
   */
  const camera: CameraOwner<MediaStream> = createCameraOwner<MediaStream>({
    base: ENGINE_CONFIG.video,
    getUserMedia: (constraints) => requireCameraApi().getUserMedia(constraints),
    attach: (next) => attachStream(options.video, next),
    onTrackEnded: (deviceId) => handleTrackEnded(deviceId),
  })

  function emit(events: readonly CoachEvent[]): void {
    for (const event of events) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (cause) {
          // One bad subscriber must not kill the detect loop, but it is still a bug.
          fail(new PoseEngineError('listener_failed', `An event listener threw on ${event.kind}.`, { cause }))
        }
      }
    }
  }

  function trackFps(now: number): void {
    frameStamps = [...frameStamps, now].filter((t) => now - t <= ENGINE_CONFIG.fpsWindowMs)
  }

  // ------------------------------------------------------------ framing + idle

  /**
   * Returns the events AND the instantaneous verdict. The debounce counters decide
   * when to *announce* framing (a one-frame blip is not worth a sentence), but fault
   * evaluation must use `ok` from this frame: while the arm is leaving the frame,
   * MediaPipe still reports hallucinated joint positions at low confidence, and the fault
   * gate could fire off that garbage before the debounce trips.
   *
   * GATED ON THE COUNTING JOINTS ONLY. It used to be gated on `inFrame`, the full set, so a
   * cropped pair of feet announced "user out of frame", set `WorkoutState.inFrame` false and
   * suppressed EVERY fault — including `no_lockout` and `craned_neck`, which need no ankle
   * at all. The joints the body line needs are handled by `handleObservability` instead, and
   * the faults that depend on them suppress themselves through a null `hipDeviation`.
   */
  function handleFraming(
    landmarks: readonly Landmark[] | null,
    t: number,
  ): { events: CoachEvent[]; ok: boolean } {
    const check = countingInFrame(landmarks)
    if (check.inFrame) {
      badFrames = 0
      goodFrames += 1
      if (!framed && goodFrames >= ENGINE_CONFIG.backInFrameFrames) {
        framed = true
        return { events: [{ kind: 'back_in_frame', at: t }], ok: true }
      }
      return { events: [], ok: true }
    }
    goodFrames = 0
    badFrames += 1
    if (framed && badFrames >= ENGINE_CONFIG.outOfFrameFrames) {
      framed = false
      faultsSeen.add('out_of_frame')
      return { events: [{ kind: 'out_of_frame', at: t, missing: check.missing }], ok: false }
    }
    return { events: [], ok: false }
  }

  /**
   * "I can count, but I cannot see your hips." Routed through the fault gate's global
   * utterance bucket rather than a bucket of its own, so it cannot talk over a form fault,
   * and debounced by `OBSERVABILITY` so it is said once rather than thirty times a second.
   *
   * `missing` comes from the either-side in-frame check while measurability comes from the
   * measured side, so a frame can be unmeasurable with nothing named (the ankle is visible
   * on the other side only). That falls back to the body-line joint names, which is what the
   * user has to reframe either way.
   */
  function handleObservability(
    landmarks: readonly Landmark[] | null,
    angles: PoseAngles,
    t: number,
  ): CoachEvent[] {
    const measurable = angles.hipDeviation !== null
    const check = bodyLineInFrame(landmarks)
    const missing = check.missing.length > 0 ? check.missing : bodyLineInFrame(null).missing
    const result = stepObservability(observability, {
      measurable,
      missing,
      t,
      canSpeak: canSpeak(gateState, t, OBSERVABILITY.rank),
    })
    observability = result.state
    if (result.events.length > 0) gateState = noteUtterance(gateState, t, OBSERVABILITY.rank)
    return result.events
  }

  function handleIdle(angles: PoseAngles, t: number): CoachEvent[] {
    const moved = lastElbow === null || Math.abs(angles.elbow - lastElbow) >= ENGINE_CONFIG.idleMotionDeg
    lastElbow = angles.elbow
    if (moved) {
      lastMotionAt = t
      lastIdleAt = null
      return []
    }
    const stillFor = t - lastMotionAt
    if (stillFor < ENGINE_CONFIG.idleMs) return []
    if (lastIdleAt !== null && t - lastIdleAt < ENGINE_CONFIG.idleRepeatMs) return []
    lastIdleAt = t
    return [{ kind: 'idle', at: t, sinceMs: stillFor }]
  }

  // ------------------------------------------------------------- reps + faults

  function handleReps(angles: PoseAngles, t: number): CoachEvent[] {
    const result = step(reps, { angles, t })
    reps = result.state
    if (result.events.length > 0) {
      // A rep callout occupies the global bucket at `routine` rank, so any real
      // fault can still interrupt it — but two rep callouts cannot stack up.
      gateState = noteUtterance(gateState, t, UTTERANCE_RANK.routine)
    }
    return result.events
  }

  function runGate(candidates: readonly FaultCandidate[], t: number, mode: 'frame' | 'immediate'): CoachEvent[] {
    const result = gate(gateState, { candidates, t, mode })
    gateState = result.state
    if (mode === 'frame') activeFaults = result.active
    result.active.forEach((f) => faultsSeen.add(f))
    return result.events
  }

  function handleFaults(
    angles: PoseAngles,
    t: number,
    completed: RepMetrics | undefined,
    measurable: boolean,
  ): CoachEvent[] {
    // Per-rep faults first: right after a rep is when "that one was short" lands.
    const repEvents = completed ? runGate(evaluateRepFaults(completed, view), t, 'immediate') : []
    const frameEvents = runGate(
      // `topMaxElbow` is the best elbow of the current top phase, which is what `no_lockout`
      // must be scored on rather than this frame's angle. See `FaultContext.topElbow`.
      evaluateFaults({
        angles,
        phase: reps.phase,
        view,
        inFrame: measurable,
        topElbow: reps.topMaxElbow,
      }),
      t,
      'frame',
    )
    return [...repEvents, ...frameEvents]
  }

  // ----------------------------------------------------------------- the loop

  /**
   * Reps keep counting when only the LEGS leave the frame: the arm chain is still
   * measurable, and freezing the counter because someone's feet drifted out would read as
   * broken. What stops instead is exactly the judgement those joints carried — `measureAngles`
   * returns a null `hipDeviation`, `hipCandidates` therefore proposes nothing, and
   * `handleObservability` tells the user why.
   */
  function processFrame(landmarks: readonly Landmark[] | null, t: number): CoachEvent[] {
    const framing = handleFraming(landmarks, t)
    const raw = measureAngles(landmarks)
    // An uncountable frame is dropped entirely rather than coerced to zeros:
    // zero angles read as a maximally deep rep and would fabricate reps.
    if (!raw) return framing.events

    windows = pushAngles(windows, raw)
    const angles = smoothedAngles(windows, raw)
    if (!angles) return framing.events

    const repEvents = handleReps(angles, t)
    const completed = repEvents.length > 0 ? reps.lastRep : undefined
    return [
      ...framing.events,
      ...repEvents,
      ...handleFaults(angles, t, completed, framing.ok),
      // After the faults: a real fault outranks "I cannot see your hips" for the frame's one
      // utterance slot, and the gate's bucket is what enforces that ordering.
      ...handleObservability(landmarks, angles, t),
      ...handleIdle(angles, t),
    ]
  }

  function tick(): void {
    if (!running || !landmarker) return
    rafId = requestAnimationFrame(tick)

    const video = options.video
    // Same decoded frame twice would double-count it in the persistence windows.
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return
    lastVideoTime = video.currentTime

    const now = performance.now()
    trackFps(now)
    try {
      // The timestamp is mandatory. See the file header.
      const result = landmarker.detectForVideo(video, now)
      latestLandmarks = result.landmarks[0] ?? null
      emit(processFrame(latestLandmarks, now))
    } catch (cause) {
      fail(new PoseEngineError('detect_failed', 'Pose detection failed on a frame.', { cause }))
    }
  }

  // --------------------------------------------------------------- public API

  function resetSession(t: number): void {
    reps = createRepMachineState()
    windows = createAngleWindows()
    gateState = createGateState()
    observability = createObservabilityState()
    activeFaults = []
    faultsSeen.clear()
    framed = true
    badFrames = 0
    goodFrames = 0
    lastElbow = null
    lastIdleAt = null
    lastMotionAt = t
    lastVideoTime = -1
    frameStamps = []
    latestLandmarks = null
    setStartedAt = t
  }

  /**
   * Everything a frame-space measurement assumed about the OLD camera. A lid camera at
   * 1280x720 and an iPhone at 1920x1080 letterbox differently and sit at different
   * heights, so normalised landmarks — and therefore every angle in the median windows —
   * mean something different after a switch.
   *
   * What deliberately SURVIVES: the rep count, the clean count, `faultsSeen`, the
   * utterance bucket and `setStartedAt`. The user did those reps; changing camera is not
   * a new set, and resetting the gate would let the coach repeat a fault it just called.
   */
  function resetGeometry(t: number): void {
    windows = createAngleWindows()
    latestLandmarks = null
    // Forces the next decoded frame through: `currentTime` restarts near zero on a new
    // stream and would otherwise compare equal to the old camera's last timestamp.
    lastVideoTime = -1
    frameStamps = []
    badFrames = 0
    goodFrames = 0
    // Null, not the last angle: the first frame of a new camera is not a movement.
    lastElbow = null
    lastIdleAt = null
    lastMotionAt = t
  }

  /** Record what actually opened, and say so when it is not what was asked for. */
  function adoptCamera(opened: OpenedCamera<MediaStream>): void {
    activeDevice = opened.deviceId
    if (!opened.fellBack) return
    fail(
      new PoseEngineError(
        'camera_substituted',
        'The camera you chose is no longer available, so the default camera opened instead.',
      ),
    )
  }

  /**
   * A dead camera looks exactly like a still user, so this never stays quiet: it reports,
   * then tries the default camera. If the iPhone is the one that slept, the lid camera is
   * a worse view but an infinitely better one than a frozen frame.
   */
  function handleTrackEnded(deviceId: string | null): void {
    if (!running) return
    fail(
      new PoseEngineError(
        'camera_ended',
        `The camera stopped sending frames${deviceId ? ` (device ${deviceId})` : ''}. Falling back to the default camera.`,
      ),
    )
    void recoverDefaultCamera()
  }

  async function recoverDefaultCamera(): Promise<void> {
    try {
      const opened = await camera.acquire(null)
      // Null means a real switch — or `stop()` — raced this recovery and won. Either way
      // that request stopped this stream for us and owns whatever is live now.
      if (!opened || !running) return
      adoptCamera(opened)
      resetGeometry(performance.now())
    } catch (cause) {
      // Nothing left to fall back to. Reported, not thrown: nobody awaits this.
      fail(asCameraError(cause, null))
    }
  }

  async function start(): Promise<void> {
    if (running) return
    // Before the expensive part: a browser with no camera API must not pay for a model.
    requireCameraApi()
    landmarker = await createLandmarker(assets)
    try {
      const opened = await camera.acquire(requestedDeviceId)
      if (!opened) throw new PoseEngineError('camera_failed', 'The camera was released while starting.')
      adoptCamera(opened)
    } catch (cause) {
      landmarker.close()
      landmarker = null
      throw asCameraError(cause, requestedDeviceId)
    }
    running = true
    const t = performance.now()
    resetSession(t)
    emit([{ kind: 'set_started', at: t, target }])
    rafId = requestAnimationFrame(tick)
  }

  /**
   * The detect loop and the PoseLandmarker are untouched on purpose: the model takes
   * seconds to build, knows nothing about which camera fed it, and `tick` already skips
   * frames while `readyState` is below HAVE_CURRENT_DATA — which is exactly the gap
   * between assigning a new srcObject and the first frame of the new camera.
   */
  async function switchCamera(deviceId: string): Promise<void> {
    requestedDeviceId = deviceId
    // Not running yet: the choice is recorded and `start` will honour it. Acquiring now
    // would turn a camera light on for a set that has not begun.
    if (!running) return
    let opened: OpenedCamera<MediaStream> | null
    try {
      opened = await camera.acquire(deviceId)
    } catch (cause) {
      throw asCameraError(cause, deviceId)
    }
    // A later switch superseded this one and owns the camera; it will adopt its own.
    if (!opened) return
    adoptCamera(opened)
    resetGeometry(performance.now())
  }

  function stop(): void {
    if (!running) return
    running = false
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null

    const t = performance.now()
    emit([
      {
        kind: 'set_ended',
        at: t,
        totalReps: reps.totalReps,
        cleanReps: reps.cleanReps,
        faults: [...faultsSeen],
      },
    ])

    // release() also invalidates any switch still in flight, so a stream that arrives
    // after the set is over stops itself instead of lighting the camera back up.
    camera.release()
    activeDevice = null
    options.video.srcObject = null
    landmarker?.close()
    landmarker = null
  }

  return {
    start,
    stop,
    switchCamera,
    activeDeviceId: () => activeDevice,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState(): WorkoutState {
      return {
        target,
        totalReps: reps.totalReps,
        cleanReps: reps.cleanReps,
        phase: reps.phase,
        lastRep: reps.lastRep,
        activeFaults,
        setStartedAt,
        setElapsedSec: setStartedAt === undefined ? 0 : (performance.now() - setStartedAt) / 1000,
        inFrame: framed,
        // The announced state, not this frame's: a UI reading a per-frame flag would strobe
        // on an ankle flickering across the visibility gate. `stepObservability` already
        // debounces, so `announced` is the stable answer.
        bodyLineObservable: !observability.announced,
      }
    },
    getLandmarks: () => latestLandmarks,
    getFps(): number {
      if (frameStamps.length < 2) return 0
      return frameStamps.length / (ENGINE_CONFIG.fpsWindowMs / 1000)
    },
    setView(next) {
      view = next
    },
    setTarget(next) {
      target = next
    },
    injectSyntheticRep(overrides) {
      /*
       * THE PRODUCTION GATE. A keystroke that adds a pushup the user did not do must not
       * exist in a shipped build, and the counts it fabricates flow straight into the set
       * ledger and the coach's mouth. `import.meta.env.DEV` is a literal `false` after
       * Vite's define pass, so everything below is unreachable and tree-shaken out of the
       * bundle along with `syntheticRep` and `SYNTHETIC_REP`.
       *
       * NOT deleted, on purpose: headless Chromium has no camera, so the browser test has
       * no other way to reach the ending screen. `vitest` runs with DEV true, so unit tests
       * see the real body. See the block comment above `SYNTHETIC_REP` in `repMachine.ts`.
       */
      if (!import.meta.env.DEV) return

      const t = performance.now()
      const result = syntheticRep(reps, t, overrides)
      reps = result.state
      gateState = noteUtterance(gateState, t, UTTERANCE_RANK.routine)
      emit(result.events)
    },
    isRunning: () => running,
  }
}
