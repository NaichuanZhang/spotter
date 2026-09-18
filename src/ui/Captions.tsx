/**
 * Live captions for whatever the coach is saying right now.
 *
 * One utterance at a time, no container, over the bottom scrim. Captions must
 * NEVER accumulate: the moment they become a scrollback they become the focus of
 * the screen, and the focus belongs to the person doing pushups.
 *
 * Lifecycle: chunks fade in as they arrive -> the utterance is marked final ->
 * hold -> fade out -> gone.
 */
import { useEffect, useState } from 'react'
import type { PersonaId } from '../types/tools'

/** Caption timings. Recalibrate here, nowhere else. */
export const CAPTION_TIMING = {
  /** How long a finished utterance stays up before it starts fading. */
  HOLD_MS: 1200,
  /** Fade-out duration. Mirrored by the .captions--fading transition. */
  FADE_MS: 240,
} as const

export interface Utterance {
  /** Bumped per utterance; a change resets the hold/fade clock. */
  readonly id: number
  readonly chunks: readonly string[]
  readonly final: boolean
}

type Phase = 'live' | 'fading' | 'gone'

interface CaptionsProps {
  readonly utterance: Utterance | null
  readonly persona: PersonaId
  /** The C hotkey turns captions off entirely. */
  readonly enabled: boolean
}

export default function Captions({ utterance, persona, enabled }: CaptionsProps) {
  const id = utterance?.id ?? -1
  const final = utterance?.final ?? false
  const [phase, setPhase] = useState<Phase>('gone')

  useEffect(() => {
    setPhase(id < 0 ? 'gone' : 'live')
  }, [id])

  useEffect(() => {
    if (!final || id < 0) return undefined
    const toFading = window.setTimeout(() => setPhase('fading'), CAPTION_TIMING.HOLD_MS)
    const toGone = window.setTimeout(
      () => setPhase('gone'),
      CAPTION_TIMING.HOLD_MS + CAPTION_TIMING.FADE_MS,
    )
    return () => {
      window.clearTimeout(toFading)
      window.clearTimeout(toGone)
    }
  }, [final, id])

  if (!enabled || !utterance || phase === 'gone') return null
  if (utterance.chunks.length === 0) return null

  return (
    <div className={`captions captions--${phase}`} data-persona={persona} aria-live="polite">
      <p className="captions__line">
        {utterance.chunks.map((chunk, index) => (
          // Append-only list, so the index IS the stable identity.
          <span className="captions__chunk" key={`${utterance.id}:${index}`}>
            {chunk}
          </span>
        ))}
      </p>
    </div>
  )
}
