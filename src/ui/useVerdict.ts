/**
 * Stage 2 of the ending, as a hook: ask for the words, then ask for the video.
 *
 * THE SCREEN NEVER WAITS FOR THIS. The words come back in ~55 ms and are the coach's
 * real closing line, which is what makes the ending complete on its own; the video is
 * 22-31 s away and arrives as a bonus beat. Nothing here is on the critical path, and
 * `phase` exists so the screen can show a quiet, one-line hint rather than a spinner
 * standing in for content.
 *
 * NO RETRY, on purpose. A 409 means another render is in flight and this one was NOT
 * queued; a retry would land after the rest period it was supposed to fill, and the
 * screen is already complete. The failure is logged with its code and left visible to
 * nobody — see EndingScreen.tsx for why a dead video says nothing on screen.
 *
 * TWO THINGS MUST BE RELEASED and both are easy to leak: the fetch (aborted, so a
 * 30-second render does not hold a connection open after the user has gone again) and
 * the blob URL (revoked, or the mp4 stays in memory for the life of the page).
 */
import { useEffect, useRef, useState } from 'react'
import { fetchVerdictVideo, fetchVerdictWords } from './verdictClient'
import type { VerdictMeta, VerdictRequest } from './verdictClient'

export const VERDICT_CLIENT = {
  /**
   * Client-side ceiling on the whole exchange. The server's own render deadline is
   * 90 s and measured renders are 22-31 s, so this only fires when something has
   * genuinely hung — and when it does, the ending screen is already readable.
   */
  deadlineMs: 120_000,
} as const

export type VerdictPhase = 'idle' | 'working' | 'ready' | 'unavailable'

export interface VerdictState {
  /** The coach's closing words. Present long before any video. */
  readonly words: string | null
  /** Server-side notes (e.g. a hip fault ignored because the line was unseen). */
  readonly notes: readonly string[]
  /** Blob URL of the rendered mp4, or null. Revoked on unmount. */
  readonly clip: string | null
  readonly meta: VerdictMeta | null
  readonly phase: VerdictPhase
}

const IDLE: VerdictState = Object.freeze({
  words: null,
  notes: Object.freeze([]),
  clip: null,
  meta: null,
  phase: 'idle',
})

type Patch = (previous: VerdictState) => VerdictState

/**
 * Words, then video, in that order and never in parallel: the render is one job
 * server-wide, and a preview that arrived after the render would be pointless.
 */
async function runVerdict(
  request: VerdictRequest,
  signal: AbortSignal,
  apply: (patch: Patch) => void,
  publishClip: (blob: Blob) => string | null,
): Promise<void> {
  const words = await fetchVerdictWords(request, { signal })
  if (words.kind === 'words') {
    apply((previous) => ({ ...previous, words: words.text, notes: words.notes }))
  } else if (words.kind === 'unavailable') {
    console.error(`[spotter] verdict words unavailable (${words.code}): ${words.message}`)
  }
  if (signal.aborted) return

  const video = await fetchVerdictVideo(request, { signal })
  if (video.kind === 'aborted') return
  if (video.kind === 'unavailable') {
    console.error(`[spotter] verdict video unavailable (${video.code}): ${video.message}`)
    // The route hands back the real closing line even on a failure, so a screen that
    // never got the preview still ends up with words.
    apply((previous) => ({
      ...previous,
      words: previous.words ?? video.text,
      phase: 'unavailable',
    }))
    return
  }
  if (video.kind !== 'video') return

  const url = publishClip(video.blob)
  if (url === null) return
  apply((previous) => ({
    ...previous,
    clip: url,
    meta: video.meta,
    // The header text is what the avatar actually says; prefer it over the preview.
    words: video.meta.text.length > 0 ? video.meta.text : previous.words,
    notes: video.meta.notes.length > 0 ? video.meta.notes : previous.notes,
    phase: 'ready',
  }))
}

/**
 * Pass null while there is no set to report. The request object's IDENTITY is the
 * trigger, so build it with useMemo keyed on the summary — a fresh object every render
 * would re-render the avatar once per commit.
 */
export function useVerdict(request: VerdictRequest | null): VerdictState {
  const [state, setState] = useState<VerdictState>(IDLE)
  const clipRef = useRef<string | null>(null)

  useEffect(() => {
    if (!request) {
      setState(IDLE)
      return undefined
    }

    let live = true
    const controller = new AbortController()
    const deadline = window.setTimeout(() => controller.abort(), VERDICT_CLIENT.deadlineMs)

    const publishClip = (blob: Blob): string | null => {
      const url = URL.createObjectURL(blob)
      // Lost the race with an unmount: revoke immediately rather than leak the mp4.
      if (!live) {
        URL.revokeObjectURL(url)
        return null
      }
      clipRef.current = url
      return url
    }

    setState({ ...IDLE, phase: 'working' })
    void runVerdict(request, controller.signal, (patch) => {
      if (live) setState(patch)
    }, publishClip).catch((error: unknown) => {
      // runVerdict handles its own failures; a throw here is a bug, not a bad render.
      console.error('[spotter] verdict flow crashed:', error)
      if (live) setState((previous) => ({ ...previous, phase: 'unavailable' }))
    })

    return () => {
      live = false
      window.clearTimeout(deadline)
      controller.abort()
      if (clipRef.current) {
        URL.revokeObjectURL(clipRef.current)
        clipRef.current = null
      }
    }
  }, [request])

  return state
}
