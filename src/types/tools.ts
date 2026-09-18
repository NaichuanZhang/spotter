/**
 * Tool definitions handed to Higgs Realtime, plus the result shapes our handlers
 * return. All six handlers execute IN THE BROWSER — the state they read is owned by
 * the pose engine or the browser's own audio graph, so none makes a network call.
 *
 * Protocol rules verified against the live API (see plan):
 *   - After sending function_call_output you MUST send response.create, or the
 *     model goes silently mute with no error event.
 *   - `output` must be a JSON *string*, not an object.
 *   - Every call is announced twice (function_call_arguments.done AND
 *     response.done.output) — dedupe on call_id.
 *
 * ── CONTRACT AMENDMENT LOG ──────────────────────────────────────────────────
 * This file is the frozen contract: it was written before the implementation so
 * four parallel agents could not drift apart, and it is changed by deliberate
 * amendment, never by convenience. Amendments get recorded here.
 *
 * 1. `play_music` added (mic-uplink pass). The session was one-way — it advertised
 *    audio input and server_vad but nothing ever sent a byte upstream — so every
 *    tool here was reachable only from a pose event. Once the mic uplink exists the
 *    user can actually ASK for something, and "put a song on" is the first request
 *    that needs an effect the model cannot produce by talking. It ships as a tool
 *    rather than a UI button because the coach, not the user, is the interface.
 *
 *    Two knock-on changes came with it, both forced rather than chosen:
 *      - `ToolHandler` may now return a Promise. Starting audio is asynchronous and
 *        can be REFUSED by the browser's autoplay policy, and the result has to say
 *        what actually happened, so the handler has to be able to wait for the
 *        answer. Callers must therefore await the return value.
 *      - The track id enum in TOOL_DEFS is generated from musicPlayer's TRACK_IDS,
 *        which is why this file now imports from ../coach. A hand-copied list here
 *        would be a second source of truth for what is on disk in public/music/,
 *        and the kind of runtime-string drift that cost this repo four bugs already.
 */

import { TRACK_IDS } from '../coach/musicPlayer'
import type { TrackId } from '../coach/musicPlayer'
import type { FaultType, CameraView } from './events'

export type PersonaId = 'mean' | 'nice' | 'sarcastic'

export type ToolName =
  | 'show_reference'
  | 'set_persona'
  | 'get_workout_state'
  | 'get_heart_rate'
  | 'log_set'
  | 'play_music'

/** JSON-Schema tool declarations, sent verbatim in session.update. */
export const TOOL_DEFS = [
  {
    type: 'function',
    name: 'show_reference',
    description:
      'Display a short reference video of correct pushup form on the user screen. Call this whenever you criticise a specific form fault, so the user can see what good form looks like. Do not call it more than once every 20 seconds.',
    parameters: {
      type: 'object',
      properties: {
        fault: {
          type: 'string',
          enum: [
            'sagging_hips',
            'piked_hips',
            'partial_depth',
            'no_lockout',
            'craned_neck',
            'flared_elbows',
          ],
          description: 'Which fault the reference clip should demonstrate the fix for.',
        },
        view: {
          type: 'string',
          enum: ['side', 'front'],
          description: 'Camera angle of the reference clip. Defaults to side.',
        },
      },
      required: ['fault'],
    },
  },
  {
    type: 'function',
    name: 'set_persona',
    description:
      'Switch which coach personality is active. Call this when the user asks for a different coach, or asks you to be nicer or meaner.',
    parameters: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          enum: ['mean', 'nice', 'sarcastic'],
          description: 'Which personality to switch to.',
        },
      },
      required: ['persona'],
    },
  },
  {
    type: 'function',
    name: 'get_workout_state',
    description:
      'Get the current rep count, form quality and active faults. Call this when the user asks how they are doing, how many reps they have done, or how their form looks.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_heart_rate',
    description:
      'Get the user current heart rate. NOTE: this value is simulated, not from a real sensor. Never claim it came from a real device.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'log_set',
    description:
      'Close out the current set and show the user a summary card. Call this when the user says they are done, or when they reach the target rep count.',
    parameters: {
      type: 'object',
      properties: {
        reps: { type: 'number', description: 'Total reps completed in the set.' },
        cleanReps: { type: 'number', description: 'How many reps had no form fault.' },
        faults: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fault types seen during the set.',
        },
      },
      required: ['reps', 'cleanReps'],
    },
  },
  /**
   * THE DESCRIPTION IS LOAD-BEARING, and that is a measurement, not a style note.
   * With the tool rules framed as background prose the live model called ZERO tools
   * across six runs on this same TOOL_DEFS — it answered "what's my heart rate?" by
   * inventing a number rather than calling the tool that had one. What fixed it was
   * naming the user's ACTUAL WORDS and making the call an order.
   *
   * So this description lists real phrasings instead of describing a category, and it
   * says outright that speaking is not acting: a realtime voice model's default
   * failure is to ANSWER "sure, putting some music on" and call nothing, which leaves
   * the coach lying to the user in a demo.
   */
  {
    type: 'function',
    name: 'play_music',
    description:
      'Start or stop the workout music through the app speakers. Call this the instant the user asks for music in ANY wording — "give me some music", "put on a song", "play something", "play a track", "I need a beat", "hype me up", "I need some energy", "got any tunes?" — and call it with action "stop" just as fast for "stop the music", "kill the music", "turn it off", "no more music", "the music is too loud". You may also start it unprompted when a set has gone quiet and the user needs lifting. SAYING you will put music on plays nothing: the tool call is the only thing that makes sound. Call it first, then speak. Do not claim music is playing until the tool tells you it is, and do not call it again while a track is already playing unless the user asks for a different one.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'stop'],
          description: 'Use "play" to start a track, "stop" to stop whatever is playing.',
        },
        track: {
          type: 'string',
          // Generated, never hand-listed: these ids have to match the files actually
          // sitting in public/music/, and MUSIC_CONFIG.tracks is the side that knows.
          enum: [...TRACK_IDS],
          description: `Which track to start. Ignored when action is "stop". Defaults to "${TRACK_IDS[0]}".`,
        },
      },
      required: ['action'],
    },
  },
] as const

// ---------------------------------------------------------------- result shapes

export interface ShowReferenceArgs {
  fault: Exclude<FaultType, 'out_of_frame'>
  view?: CameraView
}
export interface ShowReferenceResult {
  shown: boolean
  clip: string
  /** One-line description of what the clip demonstrates, so the model can talk about it. */
  description: string
}

export interface SetPersonaArgs {
  persona: PersonaId
}
export interface SetPersonaResult {
  persona: PersonaId
  ok: boolean
}

export interface GetWorkoutStateResult {
  reps: number
  target: number
  cleanReps: number
  lastRepDepthPct: number | null
  activeFaults: FaultType[]
  setElapsedSec: number
  phase: 'top' | 'bottom'
}

export interface GetHeartRateResult {
  bpm: number
  zone: 'rest' | 'warmup' | 'aerobic' | 'threshold' | 'max'
  trend: 'rising' | 'steady' | 'falling'
  /** Always true. Lives in the RESULT, not just the UI, so the model cannot
   *  claim this came from a real sensor even if it wanted to. */
  simulated: true
}

export interface LogSetArgs {
  reps: number
  cleanReps: number
  faults?: FaultType[]
}
export interface LogSetResult {
  logged: boolean
  summary: string
}

export type MusicAction = 'play' | 'stop'

export interface PlayMusicArgs {
  action: MusicAction
  /** Untyped on purpose: it arrives from a language model and is validated at the handler. */
  track?: string
}

/**
 * Shaped so the coach can only say true things. `playing` is the state AFTER the
 * call, not a request acknowledgement, and every field is nullable because "the
 * browser refused to start audio" is a real and common outcome (autoplay policy: a
 * tool call triggered by speech is not a click). `detail` is the one field written
 * for the model to speak from — the others are for it to reason with.
 */
export interface PlayMusicResult {
  action: MusicAction
  /** True only if audio is actually running now. A successful `stop` reports false. */
  playing: boolean
  track: TrackId | null
  /** Human name of the track, safe to say out loud. */
  label: string | null
  /** Roughly how long the track runs, so the coach never promises a length it invented. */
  approxSec: number | null
  detail: string
}

export interface ToolErrorResult {
  error: string
}

export type ToolResult =
  | ShowReferenceResult
  | SetPersonaResult
  | GetWorkoutStateResult
  | GetHeartRateResult
  | LogSetResult
  | PlayMusicResult
  | ToolErrorResult

/**
 * A handler never throws — it returns { error } instead, or the model waits forever.
 *
 * May return a Promise (see the amendment log): play_music has to wait for the
 * browser to accept or refuse playback before it can report truthfully. Every caller
 * must therefore await the return value, and a rejected promise is as fatal as a
 * throw, so the async path needs the same guard the sync path has.
 */
export type ToolHandler = (args: any) => ToolResult | Promise<ToolResult>

export type ToolRegistry = Record<ToolName, ToolHandler>
