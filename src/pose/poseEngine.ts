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
 * TUNABLES LIVE IN: `ENGINE_CONFIG` (this file).
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { CameraView, CoachEvent, FaultType, RepMetrics, WorkoutState } from '../types/events'
import type { PoseAngles } from './angles'
import { measureAngles } from './angles'
import type { FaultCandidate, GateState } from './faults'
import {
  createGateState,
  evaluateFaults,
  evaluateRepFaults,
  gate,
  noteUtterance,
  UTTERANCE_RANK,
} from './faults'
import type { Landmark } from './landmarks'
import { inFrame } from './landmarks'
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
  /** Consecutive unmeasurable frames before announcing the user is gone. */
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
  /** Demo-day hotkey: score a rep the camera did not see. */
  injectSyntheticRep(overrides?: Partial<RepMetrics>): void
  isRunning(): boolean
}

// ------------------------------------------------------------------- media setup

async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new PoseEngineError(
      'unsupported_browser',
      'This browser exposes no camera API. A secure context (https or localhost) is required.',
    )
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: ENGINE_CONFIG.video, audio: false })
  } catch (cause) {
    const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
    throw new PoseEngineError(
      denied ? 'camera_denied' : 'camera_failed',
      denied ? 'Camera permission was denied.' : 'Could not open the camera.',
      { cause },
    )
  }
  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play().catch((cause: unknown) => {
    stream.getTracks().forEach((t) => t.stop())
    throw new PoseEngineError('camera_failed', 'The video element refused to play.', { cause })
  })
  return stream
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
  let stream: MediaStream | null = null
  let rafId: number | null = null
  let running = false
  let lastVideoTime = -1

  let reps: RepMachineState = createRepMachineState()
  let windows: AngleWindows = createAngleWindows()
  let gateState: GateState = createGateState()
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
   * evaluation must use `ok` from this frame: while the legs are leaving the frame,
   * MediaPipe still reports hallucinated hip and ankle positions at low confidence,
   * and the fault gate could fire a sag off that garbage before the debounce trips.
   */
  function handleFraming(
    landmarks: readonly Landmark[] | null,
    t: number,
  ): { events: CoachEvent[]; ok: boolean } {
    const check = inFrame(landmarks)
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
      evaluateFaults({ angles, phase: reps.phase, view, inFrame: measurable }),
      t,
      'frame',
    )
    return [...repEvents, ...frameEvents]
  }

  // ----------------------------------------------------------------- the loop

  /**
   * Note that reps keep counting when only the LEGS leave the frame: the arm chain is
   * still measurable, and freezing the counter because someone's feet drifted out
   * would read as broken. Faults are suppressed instead, which is the half that would
   * otherwise be wrong.
   */
  function processFrame(landmarks: readonly Landmark[] | null, t: number): CoachEvent[] {
    const framing = handleFraming(landmarks, t)
    const raw = measureAngles(landmarks)
    // An unmeasurable frame is dropped entirely rather than coerced to zeros:
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

  async function start(): Promise<void> {
    if (running) return
    landmarker = await createLandmarker(assets)
    try {
      stream = await openCamera(options.video)
    } catch (error) {
      landmarker.close()
      landmarker = null
      throw error
    }
    running = true
    const t = performance.now()
    resetSession(t)
    emit([{ kind: 'set_started', at: t, target }])
    rafId = requestAnimationFrame(tick)
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

    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    options.video.srcObject = null
    landmarker?.close()
    landmarker = null
  }

  return {
    start,
    stop,
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
      const t = performance.now()
      const result = syntheticRep(reps, t, overrides)
      reps = result.state
      gateState = noteUtterance(gateState, t, UTTERANCE_RANK.routine)
      emit(result.events)
    },
    isRunning: () => running,
  }
}
