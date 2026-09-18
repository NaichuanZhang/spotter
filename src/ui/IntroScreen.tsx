/**
 * Intro screen. The baked avatar video owns this screen exclusively — it is the
 * avatar's only appearance, and confining it here is what keeps the workout screen
 * down to two video surfaces.
 *
 * Selecting a persona swaps the clip; START enters the workout. That click is also
 * the user gesture that unlocks audio, so it has to be a real click — App does the
 * AudioContext work inside this handler.
 */
import { useEffect, useRef, useState } from 'react'
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
  const active = personaView(persona)

  useEffect(() => {
    setVideoFailed(false)
  }, [persona])

  useEffect(() => {
    const element = videoRef.current
    if (!element || videoFailed) return
    element.muted = true
    void element.play().catch((error: unknown) => {
      // Autoplay refusal is not fatal — the poster gradient carries the screen.
      console.warn('[spotter] intro autoplay refused', error)
    })
  }, [persona, videoFailed])

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
                  onClick={() => onPersona(id)}
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
