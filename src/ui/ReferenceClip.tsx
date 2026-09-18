/**
 * The "here is what good looks like" clip, driven by the show_reference tool.
 *
 * It renders INSIDE the glass HUD panel, never as a floating card: two stacked
 * glass layers read as mush, so the HUD collapses to one row and lends this its
 * surface instead.
 *
 * The clip table itself lives in src/coach/toolHandlers.ts (REFERENCE_CLIPS) —
 * the model's tool result and this card must never disagree about which file is
 * on screen, so there is exactly one source for src + description.
 *
 * If the file is missing (the clips are shot by hand) we fall back to the text
 * cue rather than showing a black rectangle: the coach has already said the line
 * out loud, so the words still land.
 */
import { useEffect, useRef, useState } from 'react'
import { FAULT_LABEL } from '../types/events'
import type { ReferenceClip as ReferenceClipInfo } from '../coach/toolHandlers'

/** Clip behaviour. Recalibrate here, nowhere else. */
export const REFERENCE_CLIP = {
  /** Auto-dismiss, so the HUD returns to full height without a click. */
  VISIBLE_MS: 9000,
} as const

/** What the tool handed us, plus when it was handed over. */
export interface ReferenceClipSpec extends ReferenceClipInfo {
  readonly at: number
}

interface ReferenceClipProps {
  readonly clip: ReferenceClipSpec | null
  readonly onDismiss: () => void
}

export default function ReferenceClip({ clip, onDismiss }: ReferenceClipProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [failed, setFailed] = useState(false)
  const at = clip?.at ?? 0

  useEffect(() => {
    setFailed(false)
  }, [at])

  useEffect(() => {
    if (!clip) return undefined
    const timer = window.setTimeout(onDismiss, REFERENCE_CLIP.VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [at, clip, onDismiss])

  useEffect(() => {
    const element = videoRef.current
    if (!element || !clip || failed) return
    element.muted = true
    void element.play().catch((error: unknown) => {
      // Not fatal: the still frame plus the text cue still carries the point.
      console.warn('[spotter] reference clip autoplay refused', error)
    })
  }, [at, clip, failed])

  if (!clip) return null

  return (
    <figure className="refclip" data-fallback={failed ? 'true' : 'false'}>
      {failed ? (
        <div className="refclip__fallback">{FAULT_LABEL[clip.fault]}</div>
      ) : (
        <video
          ref={videoRef}
          className="refclip__video"
          src={clip.src}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
          onError={() => setFailed(true)}
        />
      )}
      <figcaption className="refclip__caption">
        <span className="refclip__tag">REFERENCE · {clip.view}</span>
        <span className="refclip__text">{clip.description}</span>
      </figcaption>
      <button type="button" className="refclip__close" onClick={onDismiss} aria-label="Hide reference clip">
        ×
      </button>
    </figure>
  )
}
