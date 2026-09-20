/**
 * The browser half of POST /api/verdict.
 *
 * The route takes STATS and templates the words itself — it never accepts text — so
 * this module's whole job is to turn a `SetSummary` into those nine scalars, and to
 * turn every possible answer into something the ending screen can render. Two calls,
 * deliberately different in cost:
 *
 *   fetchVerdictWords  — `preview: true`. ~55 ms, no render, no credits. This is what
 *                        makes the screen COMPLETE before any video exists.
 *   fetchVerdictVideo  — the real render. Measured 22-31 s wall clock for a ~250
 *                        character line (render ~= driving audio + 9 s); the "12 s"
 *                        figure elsewhere in this repo was for the short baked intros.
 *
 * EVERY FAILURE IS NORMAL HERE, and none of them may throw at the caller: the render
 * is one concurrent job server-wide (409 when busy), it is rate limited (429), and it
 * can fail upstream (502/504). The route answers every one of those with JSON that
 * still carries `text`, so a failed render degrades to the coach's real closing words
 * rather than to nothing.
 */
import type { PersonaId } from '../types/tools'
import type { FaultType } from '../types/events'
import type { SetSummary } from './setSummary'

export const VERDICT_ROUTE = '/api/verdict'

/** Exactly the fields server/verdictText.mjs accepts. Anything else is a 400. */
export interface VerdictRequest {
  readonly persona: PersonaId
  readonly reps: number
  readonly cleanReps: number
  readonly partialReps: number
  readonly faults: readonly FaultType[]
  readonly elapsedSec: number
  readonly bestDepthPct: number
  readonly bodyLineSeen: boolean
}

/**
 * `bodyLineSeen` is true ONLY for full coverage. A set where one rep's feet drifted
 * out of shot buys no licence to talk about the back — see setSummary.ts.
 */
export function verdictRequestFrom(summary: SetSummary, persona: PersonaId): VerdictRequest {
  return {
    persona,
    reps: summary.reps,
    cleanReps: summary.cleanReps,
    partialReps: summary.partialReps,
    faults: summary.faults,
    elapsedSec: Math.round(summary.elapsedSec),
    bestDepthPct: summary.bestDepthPct,
    bodyLineSeen: summary.coverage === 'seen',
  }
}

export interface VerdictMeta {
  /** 'miss' paid for this render, 'hit' reused one, 'shared' joined one in flight. */
  readonly cache: string
  readonly jobId: string
  readonly voice: string
  readonly persona: string
  /** What the avatar actually says. Same words the preview returned. */
  readonly text: string
  readonly notes: readonly string[]
  readonly renderMs: number
  readonly polls: number
}

export type VerdictOutcome =
  | { readonly kind: 'video'; readonly blob: Blob; readonly meta: VerdictMeta }
  | { readonly kind: 'words'; readonly text: string; readonly voice: string; readonly notes: readonly string[] }
  /** The screen stays complete: `text` is the coach's real line when we got that far. */
  | {
      readonly kind: 'unavailable'
      readonly code: string
      readonly message: string
      readonly retryable: boolean
      readonly text: string | null
    }
  | { readonly kind: 'aborted' }

interface CallOptions {
  readonly signal?: AbortSignal
  /** Injected in tests, which have no server. */
  readonly fetchImpl?: typeof fetch
}

function splitNotes(raw: string | null): readonly string[] {
  if (!raw) return []
  return raw
    .split('|')
    .map((note) => note.trim())
    .filter((note) => note.length > 0)
}

function readNumber(raw: string | null): number {
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function metaFrom(response: Response): VerdictMeta {
  const header = (name: string) => response.headers.get(name)
  return {
    cache: header('X-Verdict-Cache') ?? 'unknown',
    jobId: header('X-Verdict-Job-Id') ?? 'none',
    voice: header('X-Verdict-Voice') ?? 'unknown',
    persona: header('X-Verdict-Persona') ?? 'unknown',
    text: header('X-Verdict-Text') ?? '',
    notes: splitNotes(header('X-Verdict-Notes')),
    renderMs: readNumber(header('X-Verdict-Render-Ms')),
    polls: readNumber(header('X-Verdict-Polls')),
  }
}

/** A proxy or a dead server answers HTML, so the body is never trusted to be JSON. */
async function readErrorBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function failureFrom(response: Response): Promise<VerdictOutcome> {
  const body = await readErrorBody(response)
  const text = typeof body.text === 'string' && body.text.length > 0 ? body.text : null
  return {
    kind: 'unavailable',
    code: typeof body.error === 'string' ? body.error : `http_${response.status}`,
    message: typeof body.message === 'string' ? body.message : `${VERDICT_ROUTE} answered ${response.status}`,
    retryable: body.retryable === true,
    text,
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : false
}

async function post(request: VerdictRequest, preview: boolean, options: CallOptions): Promise<Response> {
  const call = options.fetchImpl ?? fetch
  return call(VERDICT_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preview ? { ...request, preview: true } : request),
    signal: options.signal,
  })
}

/** Words only. No render, no credits — call this first, always. */
export async function fetchVerdictWords(request: VerdictRequest, options: CallOptions = {}): Promise<VerdictOutcome> {
  try {
    const response = await post(request, true, options)
    if (!response.ok) return failureFrom(response)
    const body = (await response.json()) as { text?: unknown; voice?: unknown; notes?: unknown }
    if (typeof body.text !== 'string' || body.text.length === 0) {
      return { kind: 'unavailable', code: 'empty_preview', message: 'The verdict preview carried no text.', retryable: false, text: null }
    }
    return {
      kind: 'words',
      text: body.text,
      voice: typeof body.voice === 'string' ? body.voice : 'unknown',
      notes: Array.isArray(body.notes) ? body.notes.filter((note): note is string => typeof note === 'string') : [],
    }
  } catch (error) {
    if (isAbort(error)) return { kind: 'aborted' }
    return {
      kind: 'unavailable',
      code: 'network',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      text: null,
    }
  }
}

/** The 22-31 s render. Never awaited by anything the screen needs to be readable. */
export async function fetchVerdictVideo(request: VerdictRequest, options: CallOptions = {}): Promise<VerdictOutcome> {
  try {
    const response = await post(request, false, options)
    if (!response.ok) return failureFrom(response)
    const blob = await response.blob()
    if (blob.size === 0) {
      return { kind: 'unavailable', code: 'empty_video', message: 'The render returned no bytes.', retryable: true, text: null }
    }
    return { kind: 'video', blob, meta: metaFrom(response) }
  } catch (error) {
    if (isAbort(error)) return { kind: 'aborted' }
    return {
      kind: 'unavailable',
      code: 'network',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      text: null,
    }
  }
}
