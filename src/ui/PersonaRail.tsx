/**
 * Persona rail (top-right, workout screen) plus the UI's persona vocabulary.
 *
 * Persona identity — label, voice, accent, intro clip — lives in
 * src/coach/personas.ts. This module adds only what the screen needs and the
 * coach does not model: a short name for the chip, a one-line tagline for the
 * intro card, the "same bad rep" reaction the intro quotes, and the 1/2/3 hotkey
 * mapping. Every one of them is UI copy, which is why they are here and not in
 * the coach package — but they are still SINGLE-SOURCED here, so no screen is
 * allowed to hardcode a persona's name, tagline or line.
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
  /** The shared family word ("SUPER"), split off so the intro card can set it small. */
  readonly prefix: string
  /** Short name for the rail chip, and the big word on the intro card. */
  readonly short: string
  /** UI-only copy: personas.ts has no tagline field. */
  readonly tagline: string
  /** How THIS coach reacts to ONE shallow rep — the intro's proof of the gimmick. */
  readonly reaction: string
  readonly hotkey: string
  /** Pre-baked avatar intro, served from public/. */
  readonly introClip: string
}

const TAGLINE: Readonly<Record<PersonaId, string>> = {
  mean: 'Drill sergeant. No patience for a soft rep.',
  nice: 'Relentlessly kind. Will celebrate rep one.',
  sarcastic: 'Dry, precise, quietly devastating.',
}

/**
 * ONE bad rep — shallow, bailed out early — as each coach would call it. This is the
 * whole differentiator, demonstrated on the intro before the user has done a single
 * rep. Written in the voice each persona's own `instructions` block teaches (see the
 * "HOW A GOOD LINE SOUNDS" examples in coach/personas.ts); longer than a live bark
 * because the intro is read, not heard.
 */
const REACTION: Readonly<Record<PersonaId, string>> = {
  mean: '“Call that a rep? You went down four inches and gave up. Chest to the floor or don’t bother counting it.”',
  nice: '“Hey, that one came up a little shallow — and you’re still here, still moving. Next one, chest all the way down. You’ve got it.”',
  sarcastic:
    '“Bold of you to file that under pushups. I admire the confidence. Perhaps the floor could get involved next time?”',
}

const HOTKEY: Readonly<Record<PersonaId, string>> = { mean: '1', nice: '2', sarcastic: '3' }

/** Every label is "SUPER <X>"; the card sets the two halves in different type. */
const FAMILY_PREFIX = /^(SUPER)\s+/

export function personaView(id: PersonaId): PersonaView {
  const persona = PERSONAS[id]
  const name = persona.label.toUpperCase()
  const family = FAMILY_PREFIX.exec(name)
  return {
    id,
    name,
    prefix: family ? family[1] : '',
    short: family ? name.slice(family[0].length) : name,
    tagline: TAGLINE[id],
    reaction: REACTION[id],
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
