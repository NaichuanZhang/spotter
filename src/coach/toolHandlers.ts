/**
 * The six tools, executing in the browser. Dependencies are injected rather than
 * imported so a handler can be unit-tested with three lines of fakes and never
 * touches React state directly.
 *
 * Three invariants, the first two because the model blocks forever otherwise:
 *   1. No handler throws. Every one returns a ToolResult, `{ error }` included — and
 *      since play_music is async, no handler REJECTS either. `guard` covers both.
 *   2. Arguments arrive from a language model, so they are untrusted input and get
 *      validated at this boundary before anything downstream sees them.
 *   3. A result says what HAPPENED, never what was requested. The coach speaks from
 *      it, so an optimistic result is a coach telling the user something untrue.
 */

import { FAULT_LABEL, FAULT_VIEW_RELIABILITY } from '../types/events'
import type { CameraView, FaultType, WorkoutState } from '../types/events'
import { isPersonaId } from './personas'
import { isTrackId, MUSIC_CONFIG, TRACK_IDS } from './musicPlayer'
import type { MusicController } from './musicControl'
import type {
  GetHeartRateResult,
  GetWorkoutStateResult,
  LogSetArgs,
  LogSetResult,
  MusicAction,
  PersonaId,
  PlayMusicResult,
  SetPersonaResult,
  ShowReferenceResult,
  ToolErrorResult,
  ToolHandler,
  ToolRegistry,
} from '../types/tools'

/** Faults we have a reference clip for — everything the tool enum can ask for. */
export type ReferenceFault = Exclude<FaultType, 'out_of_frame'>

export const REFERENCE_CONFIG = {
  /**
   * Self-shot clips live in public/clips/<fault>-<view>.mp4 — the same directory
   * public/clips/manifest.json describes and the server caches as immutable.
   * `public/clips/` is tracked in git on purpose; do not move it to /reference.
   */
  dir: '/clips',
  /** The tool description asks the model for 20s; we enforce it so the UI cannot flicker. */
  cooldownMs: 20_000,
} as const

interface ClipSpec {
  /** Views actually shot. Resolution falls back within this list. */
  readonly views: readonly CameraView[]
  /** A real sentence — the model reads this and talks about the clip. */
  readonly description: string
}

/**
 * The manifest. A typed constant rather than a fetched clips.json: it cannot 404
 * mid-demo, and tsc proves every FaultType is covered.
 */
export const REFERENCE_CLIPS: Readonly<Record<ReferenceFault, ClipSpec>> = Object.freeze({
  sagging_hips: {
    views: ['side'],
    description:
      'The hips sink below the shoulder-to-heel line, then the lifter braces the glutes and abs and the body holds one straight line.',
  },
  piked_hips: {
    views: ['side'],
    description:
      'The hips ride up into a tent shape, then settle until shoulders, hips and heels are level with each other.',
  },
  partial_depth: {
    views: ['side'],
    description:
      'First a shallow half rep, then a full one where the chest comes within a fist of the floor and the elbows fold well past ninety degrees.',
  },
  no_lockout: {
    views: ['side'],
    description:
      'The lifter stops short at the top with bent arms, then presses all the way to straight elbows and holds it for a beat.',
  },
  craned_neck: {
    views: ['side'],
    description:
      'The chin pokes forward toward the floor, then the head tucks back so the neck stays in line with the spine.',
  },
  flared_elbows: {
    views: ['front', 'side'],
    description:
      'The elbows swing out level with the shoulders, then tuck to roughly forty five degrees from the ribs.',
  },
})

/** Bonus asset for the UI; no tool can request it, so it lives outside the manifest. */
export const GOOD_REP_CLIP = `${REFERENCE_CONFIG.dir}/good_rep-side.mp4`

export interface ReferenceClip {
  fault: ReferenceFault
  view: CameraView
  /** Path under public/, ready for a <video src>. */
  src: string
  description: string
}

export interface ToolHandlerDeps {
  /** Live pose state. Null before the first frame or if the camera died. */
  getWorkoutState: () => WorkoutState | null
  /** Simulated HR. `simulated: true` is stamped here, not by the caller. */
  getHeartRate: () => Omit<GetHeartRateResult, 'simulated'> | null
  /** Swap the coach. Return false if the swap could not be applied. */
  setPersona: (persona: PersonaId) => boolean | void
  /** Render the reference card. Return false if the UI refused. */
  showReference: (clip: ReferenceClip) => boolean | void
  /** Close the set and show the summary card. Return false if it could not log. */
  logSet: (args: Required<LogSetArgs>) => boolean | void
  /**
   * Music. The narrow controller view, not the player — this handler must never be
   * able to touch the duck level, which belongs to the session.
   */
  music: MusicController
  /** Injected clock so the cooldown is testable. */
  now?: () => number
}

export function createToolHandlers(deps: ToolHandlerDeps): ToolRegistry {
  const now = deps.now ?? (() => Date.now())
  let lastReferenceAt = Number.NEGATIVE_INFINITY

  const showReference: ToolHandler = (rawArgs) => {
    const args = asRecord(rawArgs)
    const fault = readFault(args.fault)
    if (!fault) {
      return { error: `unknown fault "${String(args.fault)}"; expected one of ${referenceFaults().join(', ')}` }
    }
    const spec = REFERENCE_CLIPS[fault]
    const view = resolveView(fault, args.view)
    const clip: ReferenceClip = {
      fault,
      view,
      src: `${REFERENCE_CONFIG.dir}/${fault}-${view}.mp4`,
      description: spec.description,
    }

    const elapsed = now() - lastReferenceAt
    if (elapsed < REFERENCE_CONFIG.cooldownMs) {
      const wait = Math.ceil((REFERENCE_CONFIG.cooldownMs - elapsed) / 1000)
      return {
        shown: false,
        clip: clip.src,
        description: `${clip.description} (Already on screen — do not show another for ${wait} seconds. Coach the fault with words instead.)`,
      } satisfies ShowReferenceResult
    }

    lastReferenceAt = now()
    const accepted = deps.showReference(clip) !== false
    return { shown: accepted, clip: clip.src, description: clip.description } satisfies ShowReferenceResult
  }

  const setPersona: ToolHandler = (rawArgs) => {
    const args = asRecord(rawArgs)
    if (!isPersonaId(args.persona)) {
      return { error: `unknown persona "${String(args.persona)}"; expected mean, nice or sarcastic` }
    }
    const persona = args.persona
    const ok = deps.setPersona(persona) !== false
    return { persona, ok } satisfies SetPersonaResult
  }

  const getWorkoutState: ToolHandler = () => {
    const state = deps.getWorkoutState()
    if (!state) return { error: 'the camera is not tracking yet, so there is no set to report on' }
    return {
      reps: state.totalReps,
      target: state.target,
      cleanReps: state.cleanReps,
      lastRepDepthPct: state.lastRep ? Math.round(state.lastRep.depthPct) : null,
      activeFaults: [...state.activeFaults],
      setElapsedSec: Math.round(state.setElapsedSec),
      phase: state.phase,
    } satisfies GetWorkoutStateResult
  }

  const getHeartRate: ToolHandler = () => {
    const reading = deps.getHeartRate()
    if (!reading) return { error: 'the heart rate estimate is not running yet' }
    return {
      bpm: Math.round(reading.bpm),
      zone: reading.zone,
      trend: reading.trend,
      simulated: true,
    } satisfies GetHeartRateResult
  }

  const logSet: ToolHandler = (rawArgs) => {
    const args = asRecord(rawArgs)
    const reps = readCount(args.reps)
    if (reps === null) return { error: 'reps must be a number of completed reps' }
    const rawClean = readCount(args.cleanReps)
    if (rawClean === null) return { error: 'cleanReps must be a number' }
    // The model routinely reports more clean reps than total; clamp rather than reject.
    const cleanReps = Math.min(rawClean, reps)
    const faults = readFaults(args.faults)

    const logged = deps.logSet({ reps, cleanReps, faults }) !== false
    return { logged, summary: summarise(reps, cleanReps, faults) } satisfies LogSetResult
  }

  /**
   * The one async handler. It has to be: starting audio can be REFUSED by the
   * browser's autoplay policy (a tool call triggered by speech is not a click), and
   * reporting "playing: true" before the browser has agreed would have the coach
   * announce a track that never arrives.
   */
  const playMusic: ToolHandler = async (rawArgs) => {
    const args = asRecord(rawArgs)
    const action = readAction(args.action)
    if (!action) {
      return { error: `action must be "play" or "stop", not "${String(args.action)}"` }
    }
    if (action === 'stop') return stopMusic()

    // Validated before the player sees it: an unknown id must come back as advice the
    // model can act on, not as a thrown "unknown track" from inside musicPlayer.
    if (args.track !== undefined && args.track !== null && !isTrackId(args.track)) {
      return { error: `unknown track "${String(args.track)}"; the only tracks are ${TRACK_IDS.join(', ')}` }
    }
    const requested = isTrackId(args.track) ? args.track : undefined
    try {
      const playing = await deps.music.play(requested)
      return {
        action,
        playing: true,
        track: playing.track,
        label: playing.label,
        approxSec: playing.approxSec,
        detail: `${playing.label} is playing now, about ${playing.approxSec} seconds of it.`,
      } satisfies PlayMusicResult
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      // Truthful failure, phrased for the model to relay: it must not claim a track
      // is on, and it must not silently retry.
      return {
        action,
        playing: false,
        track: null,
        label: null,
        approxSec: null,
        detail: `The music did not start: ${detail}. Tell the user it would not play and keep coaching.`,
      } satisfies PlayMusicResult
    }
  }

  function stopMusic(): PlayMusicResult {
    const wasPlaying = deps.music.isPlaying()
    // Read BEFORE stopping: musicPlayer clears currentTrack() as it tears the graph
    // down, so afterwards there is nothing left to name.
    const track = deps.music.currentTrack()
    deps.music.stop()
    const label = track ? MUSIC_CONFIG.tracks[track].label : null
    return {
      action: 'stop',
      playing: false,
      track,
      label,
      approxSec: null,
      detail: wasPlaying && label ? `${label} is stopped.` : 'There was no music playing.',
    }
  }

  return {
    show_reference: guard('show_reference', showReference),
    set_persona: guard('set_persona', setPersona),
    get_workout_state: guard('get_workout_state', getWorkoutState),
    get_heart_rate: guard('get_heart_rate', getHeartRate),
    log_set: guard('log_set', logSet),
    play_music: guard('play_music', playMusic),
  }
}

/**
 * Last line of defence. A UI callback that throws must still produce a reply, or
 * the coach waits on a tool result that never comes and goes silent for good.
 *
 * Both failure shapes are caught, and that is not belt-and-braces: a sync handler
 * THROWS and an async one REJECTS, and a rejection sails straight through a
 * try/catch around a call that merely returns a promise.
 */
function guard(name: string, handler: ToolHandler): ToolHandler {
  return (args) => {
    try {
      const outcome = handler(args)
      return outcome instanceof Promise ? outcome.catch((cause) => failed(name, cause)) : outcome
    } catch (cause) {
      return failed(name, cause)
    }
  }
}

function failed(name: string, cause: unknown): ToolErrorResult {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return { error: `${name} failed: ${detail}` }
}

export function summarise(reps: number, cleanReps: number, faults: readonly FaultType[]): string {
  const pct = reps > 0 ? Math.round((cleanReps / reps) * 100) : 0
  const head = `${reps} rep${reps === 1 ? '' : 's'}, ${cleanReps} clean (${pct}%)`
  if (faults.length === 0) return `${head}. No form faults.`
  const named = faults.map((fault) => FAULT_LABEL[fault].toLowerCase()).join(', ')
  return `${head}. Faults seen: ${named}.`
}

// ------------------------------------------------------------------- validation

function referenceFaults(): ReferenceFault[] {
  return Object.keys(REFERENCE_CLIPS) as ReferenceFault[]
}

function readFault(value: unknown): ReferenceFault | null {
  if (typeof value !== 'string') return null
  return Object.prototype.hasOwnProperty.call(REFERENCE_CLIPS, value)
    ? (value as ReferenceFault)
    : null
}

function isCameraView(value: unknown): value is CameraView {
  return value === 'side' || value === 'front'
}

/**
 * Honour the requested view when we shot it; otherwise fall back to the view the
 * contract says this fault is even measurable from (flared elbows need the front).
 */
function resolveView(fault: ReferenceFault, requested: unknown): CameraView {
  const spec = REFERENCE_CLIPS[fault]
  if (isCameraView(requested) && spec.views.includes(requested)) return requested
  const reliable = FAULT_VIEW_RELIABILITY[fault].find((view) => spec.views.includes(view))
  if (reliable) return reliable
  return spec.views.length > 0 ? spec.views[0] : 'side'
}

/**
 * Tolerant on case and whitespace only. "start"/"begin"/"kill" are deliberately NOT
 * accepted: the enum is in the tool schema, and quietly guessing at a word outside it
 * means the model never learns it sent the wrong one.
 */
function readAction(value: unknown): MusicAction | null {
  if (typeof value !== 'string') return null
  const normalised = value.trim().toLowerCase()
  return normalised === 'play' || normalised === 'stop' ? normalised : null
}

function readCount(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

function readFaults(value: unknown): FaultType[] {
  if (!Array.isArray(value)) return []
  const known = new Set(Object.keys(FAULT_LABEL))
  const seen = new Set<FaultType>()
  for (const entry of value) {
    if (typeof entry === 'string' && known.has(entry)) seen.add(entry as FaultType)
  }
  return [...seen]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
