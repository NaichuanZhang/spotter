/**
 * Tool definitions handed to Higgs Realtime, plus the result shapes our handlers
 * return. All five handlers execute IN THE BROWSER — the state they read is owned
 * by the pose engine, so none of them makes a network call.
 *
 * Protocol rules verified against the live API (see plan):
 *   - After sending function_call_output you MUST send response.create, or the
 *     model goes silently mute with no error event.
 *   - `output` must be a JSON *string*, not an object.
 *   - Every call is announced twice (function_call_arguments.done AND
 *     response.done.output) — dedupe on call_id.
 */

import type { FaultType, CameraView } from './events'

export type PersonaId = 'mean' | 'nice' | 'sarcastic'

export type ToolName =
  | 'show_reference'
  | 'set_persona'
  | 'get_workout_state'
  | 'get_heart_rate'
  | 'log_set'

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

export interface ToolErrorResult {
  error: string
}

export type ToolResult =
  | ShowReferenceResult
  | SetPersonaResult
  | GetWorkoutStateResult
  | GetHeartRateResult
  | LogSetResult
  | ToolErrorResult

/** A handler never throws — it returns { error } instead, or the model waits forever. */
export type ToolHandler = (args: any) => ToolResult

export type ToolRegistry = Record<ToolName, ToolHandler>
