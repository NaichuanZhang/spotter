/**
 * The coach picker. Three cards, each carrying its OWN hue at all times — that is
 * what teaches the persona-to-colour mapping before anything is selected.
 *
 * A click here is also the gesture that earns sound, so `onSelect` is the parent's
 * pick handler, never a bare setState. Keyboard: the whole row is one tab stop
 * (roving tabindex) and the arrows move the selection, which is what a radiogroup
 * is supposed to do. The 1/2/3 keys are handled globally by App's useHotkeys, so the
 * kbd hint next to the heading is telling the truth on both screens.
 */
import type { KeyboardEvent } from 'react'
import type { PersonaId } from '../types/tools'
import { PERSONA_ORDER, personaView } from './PersonaRail'
import { REVEAL_MS, cardRevealMs, revealAt } from './introMotion'

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

interface PersonaCardsProps {
  readonly persona: PersonaId
  readonly onSelect: (persona: PersonaId) => void
}

export default function PersonaCards({ persona, onSelect }: PersonaCardsProps) {
  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[event.key]
    if (!step) return
    event.preventDefault()
    const from = PERSONA_ORDER.indexOf(persona)
    const next = PERSONA_ORDER[(from + step + PERSONA_ORDER.length) % PERSONA_ORDER.length]
    if (!next) return
    onSelect(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-persona="${next}"]`)?.focus()
  }

  return (
    <section className="picker" aria-labelledby="pickerHead">
      <p className="picker__head" id="pickerHead" data-reveal="" style={revealAt(REVEAL_MS.pickerHead)}>
        <span>Pick your coach</span>
        <i />
        <span className="keys">
          {PERSONA_ORDER.map((id) => (
            <kbd key={id}>{personaView(id).hotkey}</kbd>
          ))}
          to switch
        </span>
      </p>

      <div className="cards" role="radiogroup" aria-label="Coach persona" onKeyDown={moveSelection}>
        {PERSONA_ORDER.map((id, index) => {
          const view = personaView(id)
          const selected = id === persona
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className="card"
              data-persona={id}
              data-reveal=""
              style={revealAt(cardRevealMs(index))}
              onClick={() => onSelect(id)}
            >
              <span className="card__top">
                <span className="card__super">{view.prefix}</span>
                <span className="card__dot" aria-hidden="true" />
              </span>
              <span className="card__name">{view.short}</span>
              <span className="card__line">{view.tagline}</span>
              <span className="card__state">
                <span className="card__check" aria-hidden="true">
                  <svg viewBox="0 0 8 8" fill="none">
                    <path
                      d="M1 4.2 3 6.2 7 1.9"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {selected ? 'Selected' : 'Select'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
