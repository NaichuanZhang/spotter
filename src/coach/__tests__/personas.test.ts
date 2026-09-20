/**
 * personas.ts is the product voice and had no coverage at all, so the rules that
 * are load-bearing for safety, honesty and tool use were only held in place by
 * whoever last edited the prose.
 *
 * The ORDERING assertion is the important one. Measured against the live API: with
 * the tool rules buried mid-prompt the model called ZERO tools in six runs and
 * invented the number it was asked for instead of calling the tool that held it (the
 * tool in that measurement was `get_heart_rate`, removed in amendment 2 of
 * src/types/tools.ts). Moving the block to sit after CHARACTER and before SAFETY is
 * what made the calls happen, so the position is a behavioural contract, not
 * formatting.
 */
import { describe, expect, it } from 'vitest'
import {
  CONFIRMED_VOICES,
  DEFAULT_PERSONA_ID,
  getPersona,
  isPersonaId,
  personaList,
  PERSONAS,
  PERSONA_ORDER,
} from '../personas'
import { HIGGS } from '../higgsSocket'
import { TOOL_DEFS } from '../../types/tools'

const ALL = personaList()
const SAFETY_LAST_LINE = 'If the user wants to stop, they stop. Never push them to continue.'

/**
 * Tools that exist in TOOL_DEFS but that the prompt does not teach yet. This list is
 * a known, deliberate defect with a named owner (personas.ts), not an exemption —
 * see the pair of tests at the bottom of the instructions block.
 */
const PROMPT_GAP: readonly string[] = ['play_music']

describe('persona catalogue', () => {
  it('covers every id in tab order, and the default is one of them', () => {
    expect(PERSONA_ORDER).toEqual(['mean', 'nice', 'sarcastic'])
    expect(ALL.map((p) => p.id)).toEqual([...PERSONA_ORDER])
    expect(isPersonaId(DEFAULT_PERSONA_ID)).toBe(true)
    expect(Object.keys(PERSONAS)).toHaveLength(PERSONA_ORDER.length)
  })

  it('rejects anything that is not a persona id', () => {
    for (const value of ['', 'MEAN', 'kind', 'toString', null, 7, {}]) {
      expect(isPersonaId(value)).toBe(false)
    }
    expect(() => getPersona('nope' as never)).toThrow(/unknown persona/)
  })

  it('gives every persona a distinct voice-less identity the UI can tint from', () => {
    const accents = new Set(ALL.map((p) => p.accentColor))
    expect(accents.size).toBe(ALL.length)
    for (const persona of ALL) {
      expect(persona.accentColor).toMatch(/^#[0-9A-F]{6}$/i)
      expect(persona.introClip).toBe(`/avatars/${persona.id}-intro.mp4`)
      expect(persona.voice.length).toBeGreaterThan(0)
      expect(persona.fallbackVoice.length).toBeGreaterThan(0)
    }
  })

  it('only ever names a voice that was measured on this account', () => {
    for (const persona of ALL) {
      expect(CONFIRMED_VOICES).toContain(persona.voice)
      expect(CONFIRMED_VOICES).toContain(persona.fallbackVoice)
    }
    // `default` is ~5 dB quieter than every preset, non-overlapping in all three
    // batteries. It is never a legitimate pick, not even as a fallback.
    expect(CONFIRMED_VOICES).not.toContain('default')
  })

  it('never lets one persona fall back onto another persona’s voice', () => {
    const primary = ALL.map((p) => p.voice)
    // Six voices, six slots. The old table had sarcastic falling back to `jake`,
    // so one transient 429 made Super Sarcastic finish the demo as Super Mean.
    expect(new Set(primary).size).toBe(ALL.length)
    for (const persona of ALL) {
      expect(persona.fallbackVoice).not.toBe(persona.voice)
      for (const other of ALL) {
        if (other.id === persona.id) continue
        expect(persona.fallbackVoice).not.toBe(other.voice)
      }
    }
  })

  it('keeps every persona speed inside the range the clamp will allow', () => {
    for (const persona of ALL) {
      // Below 1.0 there is no urgency to buy; above speedSafeMax the naive
      // resample reads as a sped-up tape, and higgsSocket would clamp it anyway.
      expect(persona.speed).toBeGreaterThanOrEqual(HIGGS.speedDefault)
      expect(persona.speed).toBeLessThanOrEqual(HIGGS.speedSafeMax)
    }
  })
})

describe.each(ALL.map((persona) => [persona.id, persona] as const))('%s instructions', (_id, persona) => {
  const text = persona.instructions

  it('keeps SAFETY last so it wins every conflict', () => {
    expect(text.trimEnd().endsWith(SAFETY_LAST_LINE)).toBe(true)
    expect(text.indexOf('SAFETY — THESE RULES OVERRIDE YOUR CHARACTER')).toBeGreaterThan(
      text.indexOf('WHO YOU ARE'),
    )
  })

  it('puts the tool rules after CHARACTER and before SAFETY', () => {
    const character = text.indexOf('WHO YOU ARE')
    const tools = text.indexOf('YOUR TOOLS')
    const safety = text.indexOf('SAFETY — THESE RULES OVERRIDE YOUR CHARACTER')
    expect(character).toBeGreaterThan(-1)
    expect(tools).toBeGreaterThan(character)
    expect(safety).toBeGreaterThan(tools)
  })

  it('names every tool the model is actually given', () => {
    for (const def of TOOL_DEFS) {
      if (PROMPT_GAP.includes(def.name)) continue
      expect(text).toContain(def.name)
    }
  })

  /**
   * The other half of the assertion above, and the reason it is split rather than
   * loosened. TOOL_DEFS gained `play_music` in the mic-uplink pass, which did not own
   * personas.ts — so right now the model is handed a tool the prompt never teaches,
   * and the measured cost of that is not hypothetical: with the tool rules merely
   * PRESENT-but-badly-positioned the live model called zero tools in six runs.
   *
   * This pins the gap instead of hiding it. The moment the play_music lines land in
   * TOOLS this test fails, PROMPT_GAP empties, and both of these collapse back into
   * the single original assertion. Do not "fix" this by deleting the entry.
   */
  it('records, rather than hides, the tools the prompt does not yet teach', () => {
    for (const name of PROMPT_GAP) expect(text).not.toContain(name)
  })

  it('frames a tool call as free, so the word cap cannot crowd it out', () => {
    expect(text).toMatch(/costs you no words/i)
    expect(text).toMatch(/Call the tool FIRST/i)
  })

  /**
   * What is left of the heart-rate honesty rules after amendment 2 removed that tool.
   * The clause that still earns its place is the one that made the call happen at all
   * — "you do not know it until the tool answers" — so it is pinned against
   * get_workout_state, which is now the only tool the coach reads numbers out of.
   */
  it('forbids guessing the totals get_workout_state owns', () => {
    expect(text).toMatch(/call get_workout_state, then quote what it returns/i)
    expect(text).toMatch(/You do not know their totals until that tool answers you/i)
    expect(text).toMatch(/Never guess them/i)
  })

  it('no longer teaches a heart rate it cannot measure', () => {
    expect(text).not.toMatch(/heart rate/i)
    expect(text).not.toMatch(/get_heart_rate/)
    expect(text).not.toMatch(/\bbpm\b/i)
  })

  it('fires show_reference off the reading rather than the persona mood', () => {
    expect(text).toMatch(/EVERY reading that reports a form fault/i)
    expect(text).toMatch(/it fires when you are being kind too/i)
  })

  it('keeps the [EVENT] telemetry rules', () => {
    expect(text).toContain('[EVENT]')
    expect(text).toMatch(/Never read one aloud/i)
    expect(text).toMatch(/Never say "event"/i)
    expect(text).toMatch(/Never invent a measurement you were not sent/i)
  })

  it('states both speech caps as hard numbers', () => {
    expect(text).toMatch(/14 words in total, maximum/)
    expect(text).toMatch(/No sentence runs past 12 words/)
  })

  it('carries a HOW YOU SOUND section in both the shared and character blocks', () => {
    // Two SECTIONS (line-start headers). SAFETY also names the block mid-sentence,
    // to say it overrides it, which is why this anchors to the line start.
    expect(text.match(/^HOW YOU SOUND/gm)?.length).toBe(2)
    expect(text).toMatch(/this block also overrides HOW YOU SOUND/)
  })

  it('is frozen, so nothing can retune the voice at runtime', () => {
    expect(Object.isFrozen(persona)).toBe(true)
    expect(Object.isFrozen(PERSONAS)).toBe(true)
  })

  it('carries the shared orthography ladder, and carries it before SAFETY', () => {
    // Full stops -> exclamation marks is the measured mechanism (+28.7% RMS, n=5)
    // and the rung is chosen off the severity word already in the [EVENT] line.
    expect(text).toMatch(/SPELLING IS VOLUME/)
    expect(text).toMatch(/One mark per burst\. Never two marks/)
    expect(text).toMatch(/A reading marked SEVERE or MAJOR/)
    const ladder = text.indexOf('SPELLING IS VOLUME')
    const safety = text.indexOf('SAFETY — THESE RULES OVERRIDE YOUR CHARACTER')
    // Position is behavioural, not cosmetic: the identical rule placed after
    // SAFETY scored 0/4 on numeric accuracy, inside HOW YOU SOUND it scored 5/5.
    expect(ladder).toBeGreaterThan(text.indexOf('HOW YOU SOUND'))
    expect(ladder).toBeLessThan(safety)
  })
})

describe('the caps rung is a Mean-only bonus, not the shared mechanism', () => {
  const CAPS_ORDER = /Write every line in CAPITALS/

  it('orders capitals only in the Mean character block', () => {
    // Caps adds ~6% on top of the exclamation marks, with OVERLAPPING ranges, and
    // caps WITHOUT exclamation marks measured -11.3% — worse than doing nothing.
    // So it stays a per-character flourish and never migrates into CORE.
    expect(PERSONAS.mean.instructions).toMatch(CAPS_ORDER)
    expect(PERSONAS.nice.instructions).not.toMatch(CAPS_ORDER)
    expect(PERSONAS.sarcastic.instructions).not.toMatch(CAPS_ORDER)
  })

  it('overrides CORE’s MINOR clause explicitly for Mean, and only for Mean', () => {
    // Mean is pinned at the top rung permanently; its escalation is pace, not
    // spelling. Left implicit, CORE's "hold the marks back" would soften it.
    expect(PERSONAS.mean.instructions).toMatch(/You have no level setting/)
    expect(PERSONAS.sarcastic.instructions).toMatch(/You live on the level setting/)
    expect(PERSONAS.nice.instructions).toMatch(/Exclamation marks are your default/)
  })

  it('writes every example line in the orthography it wants heard', () => {
    // Probe 4: the examples carry more of the gain than the rule does — rule alone
    // +14.2%, rule plus examples +41.9%. A full stop in an example is a real cost.
    for (const line of exampleLines(PERSONAS.mean.instructions)) {
      expect(line).toBe(line.toUpperCase())
      expect(line).toMatch(/!"$/)
    }
    for (const line of exampleLines(PERSONAS.nice.instructions)) {
      expect(line).toMatch(/!"$/)
    }
    // Sarcastic stays deliberately on the level rung: a deadpan coach that barks
    // is a broken deadpan coach.
    for (const line of exampleLines(PERSONAS.sarcastic.instructions)) {
      expect(line).not.toMatch(/!/)
    }
  })
})

/** The quoted few-shot lines under HOW A GOOD LINE SOUNDS. */
function exampleLines(instructions: string): string[] {
  const block = instructions.split('HOW A GOOD LINE SOUNDS')[1] ?? ''
  const lines = block.split('\n').filter((line) => line.startsWith('"'))
  expect(lines).toHaveLength(4)
  return lines
}
