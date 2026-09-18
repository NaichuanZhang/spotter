/**
 * personas.ts is the product voice and had no coverage at all, so the rules that
 * are load-bearing for safety, honesty and tool use were only held in place by
 * whoever last edited the prose.
 *
 * The ORDERING assertion is the important one. Measured against the live API: with
 * the tool rules buried mid-prompt the model called ZERO tools in six runs and
 * invented a heart rate instead of calling get_heart_rate. Moving the block to sit
 * after CHARACTER and before SAFETY is what made the calls happen, so the position
 * is a behavioural contract, not formatting.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERSONA_ID, getPersona, isPersonaId, personaList, PERSONAS, PERSONA_ORDER } from '../personas'
import { TOOL_DEFS } from '../../types/tools'

const ALL = personaList()
const SAFETY_LAST_LINE = 'If the user wants to stop, they stop. Never push them to continue.'

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
    for (const def of TOOL_DEFS) expect(text).toContain(def.name)
  })

  it('frames a tool call as free, so the word cap cannot crowd it out', () => {
    expect(text).toMatch(/costs you no words/i)
    expect(text).toMatch(/Call the tool FIRST/i)
  })

  it('forbids inventing a heart rate and requires the estimated caveat', () => {
    expect(text).toMatch(/Never guess a heart rate/i)
    expect(text).toMatch(/estimated/i)
    expect(text).toMatch(/Never claim it came from a real device/i)
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
})
