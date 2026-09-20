/**
 * The avatar verdict: one runtime-rendered 640x640 talking head, played once, loud.
 *
 * Every hard-won lesson here is inherited from AvatarStage.tsx (the intro's clip
 * panel) rather than rediscovered, because the two clips come off the same pipeline:
 *
 * THE WATERMARK CROP. Every Higgs avatar clip burns "This digital avatar is generated
 * by AI" across source y 93-99%. The stage is a square overflow-hidden cell and the
 * video is blown up to `--avatar-crop` (112%) anchored to the TOP, which pushes that
 * strip past the bottom edge (93% x 112% = 104%). Shrink that number and the strip
 * comes back. The disclosure is not lost — it is restated as readable text under the
 * card, which is better than a hard-coded band of pixels nobody can style.
 *
 * SOUND IS EARNED, NEVER ASSUMED. By the time a verdict exists the user has clicked
 * START, so the document is interacted-with and an audible play should be granted. It
 * still might not be — a tab restored from the background, an iOS quirk — so a refusal
 * falls back to a MUTED LOOPING clip plus an affordance, never a frozen frame. Muted
 * loops; audible plays exactly once, because hearing the same verdict twice is worse
 * than silence.
 *
 * AN ARRIVAL, NOT A WAIT. This component is mounted only once the bytes exist, so the
 * entrance animation in styles.css is the whole "it's here" beat.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface VerdictStageProps {
  readonly src: string
  readonly coachName: string
  /** True once the screen believes sound is allowed. */
  readonly audible: boolean
  /** The user asked for sound after a refusal. */
  readonly onSoundRequest: () => void
  /** An audible play was refused; the screen must restore the affordance. */
  readonly onSoundRefused: () => void
  /** Provenance, straight from the response headers. Null until the clip exists. */
  readonly voice: string | null
  readonly renderMs: number
}

/** Second caption line: which voice spoke, and what the render actually cost. */
function provenance(voice: string | null, renderMs: number): string | null {
  if (!voice) return null
  return renderMs > 0 ? `voice ${voice} · ${(renderMs / 1000).toFixed(1)}s render` : `voice ${voice}`
}

export default function VerdictStage({
  src,
  coachName,
  audible,
  onSoundRequest,
  onSoundRefused,
  voice,
  renderMs,
}: VerdictStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [failed, setFailed] = useState(false)
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    const element = videoRef.current
    if (!element || failed) return
    setEnded(false)
    element.muted = !audible
    element.loop = !audible
    element.currentTime = 0
    void element.play().catch((error: unknown) => {
      if (!audible) {
        // A refused MUTED play leaves a poster frame, which is survivable.
        console.warn('[spotter] verdict clip autoplay refused', error)
        return
      }
      console.warn('[spotter] audible verdict refused, falling back to muted', error)
      element.muted = true
      element.loop = true
      onSoundRefused()
      void element.play().catch((fallbackError: unknown) => {
        console.error('[spotter] verdict clip will not play at all', fallbackError)
        setFailed(true)
      })
    })
  }, [src, audible, failed, onSoundRefused])

  const replay = useCallback(() => {
    onSoundRequest()
    const element = videoRef.current
    if (!element) return
    element.currentTime = 0
    void element.play().catch((error: unknown) => {
      console.warn('[spotter] verdict replay refused', error)
    })
  }, [onSoundRequest])

  const label = !audible ? 'Tap to hear' : ended ? 'Replay' : 'Playing'
  const detail = provenance(voice, renderMs)

  return (
    <figure className="verdict" data-failed={failed ? 'true' : 'false'}>
      <div className="verdict__stage">
        {failed ? (
          <div className="verdict__fallback">
            <span className="verdict__fallbackName">{coachName}</span>
            <p className="verdict__fallbackNote">Verdict clip unavailable</p>
          </div>
        ) : (
          <video
            ref={videoRef}
            className="verdict__video"
            src={src}
            playsInline
            preload="auto"
            aria-label={`${coachName} delivering your verdict`}
            onEnded={() => setEnded(true)}
            onError={() => {
              console.error('[spotter] verdict clip failed to decode')
              setFailed(true)
            }}
          />
        )}
        <div className="verdict__rim" aria-hidden="true" />
        <span className="verdict__badge">
          <span className="verdict__badgeDot" aria-hidden="true" />
          {coachName}
        </span>
      </div>

      <figcaption className="verdict__caption">
        <button
          type="button"
          className="verdict__sound"
          data-on={audible && !ended ? 'true' : 'false'}
          disabled={failed || (audible && !ended)}
          onClick={replay}
        >
          {label}
        </button>
        {/* The disclosure the crop removed from the pixels, restated in words. */}
        <span className="verdict__provenance">AI avatar · rendered from this set</span>
        {detail ? <span className="verdict__provenance">{detail}</span> : null}
      </figcaption>
    </figure>
  )
}
