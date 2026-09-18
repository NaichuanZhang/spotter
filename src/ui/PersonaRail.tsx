/**
 * Persona rail (top-right, workout screen) plus the UI's persona vocabulary.
 *
 * Persona identity — label, voice, accent, intro clip — lives in
 * src/coach/personas.ts. This module adds only what the screen needs and the
 * coach does not model: a short name for the chip, a one-line tagline for the
 * intro card, and the 1/2/3 hotkey mapping.
 *
 * Hue rule: the rail is "frame", so persona colour is allowed here. It never
 * touches a numeral.
 */
import type { PersonaId } from '../types/tools'
import { PERSONAS, PERSONA_ORDER } from '../coach/personas'

export { PERSONA_ORDER }

export interface PersonaView {
  readonly id: PersonaId
  /** Full display name, upper-case. */
  readonly name: string
  /** Short name for the rail chip. */
  readonly short: string
  /** UI-only copy: personas.ts has no tagline field. */
  readonly tagline: string
  readonly hotkey: string
  /** Pre-baked avatar intro, served from public/. */
  readonly introClip: string
}

const TAGLINE: Readonly<Record<PersonaId, string>> = {
  mean: 'Drill sergeant. No patience for a soft rep.',
  nice: 'Relentlessly kind. Will celebrate rep one.',
  sarcastic: 'Dry, precise, quietly devastating.',
}

const HOTKEY: Readonly<Record<PersonaId, string>> = { mean: '1', nice: '2', sarcastic: '3' }

export function personaView(id: PersonaId): PersonaView {
  const persona = PERSONAS[id]
  const name = persona.label.toUpperCase()
  return {
    id,
    name,
    short: name.replace(/^SUPER\s+/, ''),
    tagline: TAGLINE[id],
    hotkey: HOTKEY[id],
    introClip: persona.introClip,
  }
}

interface PersonaRailProps {
  readonly persona: PersonaId
  readonly onSelect: (persona: PersonaId) => void
}

export default function PersonaRail({ persona, onSelect }: PersonaRailProps) {
  return (
    <div className="rail" role="group" aria-label="Coach persona">
      {PERSONA_ORDER.map((id) => {
        const view = personaView(id)
        const active = id === persona
        return (
          <button
            key={id}
            type="button"
            className="rail__chip"
            data-persona={id}
            data-active={active ? 'true' : 'false'}
            aria-pressed={active}
            onClick={() => onSelect(id)}
          >
            <span className="rail__dot" aria-hidden="true" />
            <span className="rail__name">{view.short}</span>
            <span className="rail__key">{view.hotkey}</span>
          </button>
        )
      })}
    </div>
  )
}
