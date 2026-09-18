/**
 * Intro screen. The baked avatar video owns this screen exclusively — it is the
 * avatar's only appearance, and confining it here is what keeps the workout screen
 * down to two video surfaces.
 *
 * Selecting a persona swaps the clip; START enters the workout. That click is also
 * the user gesture that unlocks audio, so it has to be a real click — App does the
 * AudioContext work inside this handler.
 *
 * SOUND. The baked intros carry a real AAC track (24 kHz mono) — the coach actually
 * introduces itself. But browsers refuse to autoplay audible media without a prior
 * user gesture, so the first clip has to start muted or it does not start at all.
 *
 * Rather than leave a lip-synced talking head permanently silent, sound is EARNED:
 * a click on a persona card (or the speaker affordance) is a genuine gesture, so
 * that is where we unmute and restart the clip from zero. Once the user has
 * interacted, every later persona switch plays audibly and immediately.
 *
 * Muted clips loop, because a silent face freezing on its last frame reads as
 * broken. An audible clip does NOT loop — hearing the same introduction on repeat
 * is worse than silence.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PersonaId } from '../types/tools'
import { PERSONA_ORDER, personaView } from './PersonaRail'

interface IntroScreenProps {
  readonly persona: PersonaId
  readonly onPersona: (persona: PersonaId) => void
  readonly onStart: () => void
  readonly target: number
}

export default function IntroScreen({ persona, onPersona, onStart, target }: IntroScreenProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoFailed, setVideoFailed] = useState(false)
  /** Flips once on the first real gesture, then stays on for the session. */
  const [audible, setAudible] = useState(false)
  const active = personaView(persona)

  useEffect(() => {
    setVideoFailed(false)
  }, [persona])

  useEffect(() => {
    const element = videoRef.current
    if (!element || videoFailed) return
    element.muted = !audible
    element.loop = !audible
    if (audible) element.currentTime = 0
    void element.play().catch((error: unknown) => {
      // An audible play can still be refused if the browser did not credit our
      // gesture. Fall back to muted playback rather than a frozen frame, and let
      // the affordance reappear so the user can try again.
      if (audible) {
        element.muted = true
        element.loop = true
        setAudible(false)
        void element.play().catch(() => setVideoFailed(true))
        return
      }
      // Muted autoplay refusal is not fatal — the poster gradient carries the screen.
      console.warn('[spotter] intro autoplay refused', error)
    })
  }, [persona, videoFailed, audible])

  /** Any deliberate click counts as the gesture that earns sound. */
  const enableSound = useCallback(() => setAudible(true), [])

  const pickPersona = useCallback(
    (id: PersonaId) => {
      setAudible(true)
      onPersona(id)
    },
    [onPersona],
  )

  return (
    <main className="intro">
      {videoFailed ? (
        <div className="intro__poster" aria-hidden="true">
          <span className="intro__posterName">{active.name}</span>
        </div>
      ) : (
        <video
          key={persona}
          ref={videoRef}
          className="intro__video"
          src={active.introClip}
          autoPlay
          muted
          playsInline
          preload="auto"
          onError={() => setVideoFailed(true)}
        />
      )}

      <div className="intro__scrim" aria-hidden="true" />

      {!videoFailed && !audible ? (
        <button type="button" className="intro__unmute glass" onClick={enableSound}>
          <span aria-hidden="true">🔊</span> Hear your coach
        </button>
      ) : null}

      <div className="intro__content">
        <header className="intro__brand">
          <h1 className="intro__wordmark">SPOTTER</h1>
          <p className="intro__tagline">Your coach can see you.</p>
        </header>

        <div className="intro__pick">
          <p className="intro__prompt">Pick your coach</p>
          <div className="intro__cards" role="radiogroup" aria-label="Coach persona">
            {PERSONA_ORDER.map((id) => {
              const view = personaView(id)
              const selected = id === persona
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className="card glass"
                  data-persona={id}
                  data-active={selected ? 'true' : 'false'}
                  onClick={() => pickPersona(id)}
                >
                  <span className="card__key">{view.hotkey}</span>
                  <span className="card__name">{view.name}</span>
                  <span className="card__tagline">{view.tagline}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="intro__go">
          <button type="button" className="start" onClick={onStart}>
            START · {target} PUSHUPS
          </button>
          <p className="intro__note">Camera and microphone start when you do. Press ? for demo keys.</p>
        </div>
      </div>
    </main>
  )
}
