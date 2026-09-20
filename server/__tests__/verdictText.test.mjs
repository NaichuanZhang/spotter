/**
 * The verdict is the last thing the user sees and the only thing on that screen
 * that is WRITING, so these tests are mostly about what the coach may and may
 * not say — not about plumbing.
 *
 * The four invariants worth more than all the rest:
 *   1. NO DIGIT ever reaches the text. Every number is spelled, because a TTS
 *      that reads "20" as "two zero" cannot be corrected without another 12 s
 *      render, and the render is the payoff.
 *   2. When `bodyLineSeen` is false, nothing is claimed about the back AND the
 *      camera instruction is still delivered.
 *   3. Nothing about the user's BODY, and no medical advice, in any persona, at
 *      any stat tuple.
 *   4. The spoken line stays under the cap that keeps the driving audio short.
 */

import { describe, expect, it } from 'vitest'

import { spellCount, spellDuration, spellPercent, spellWords } from '../numberWords.mjs'
import {
  BACK_FAULTS,
  VERDICT_FAULT_TYPES,
  VERDICT_LIMITS,
  buildVerdictText,
  validateVerdictStats,
  verdictCacheKey,
} from '../verdictText.mjs'
import { AVATAR_PERSONA_IDS } from '../avatarPersonas.mjs'

const GOOD = Object.freeze({
  persona: 'mean',
  reps: 20,
  cleanReps: 17,
  partialReps: 3,
  faults: ['flared_elbows'],
  elapsedSec: 88,
  bestDepthPct: 94,
  bodyLineSeen: true,
})

const accept = (patch = {}) => {
  const result = validateVerdictStats({ ...GOOD, ...patch })
  if (!result.ok) throw new Error(`expected valid, got ${result.field}: ${result.message}`)
  return result
}

describe('numberWords', () => {
  it('spells the values a verdict actually quotes', () => {
    expect(spellWords(0)).toBe('zero')
    expect(spellWords(17)).toBe('seventeen')
    expect(spellWords(20)).toBe('twenty')
    expect(spellWords(94)).toBe('ninety four')
    expect(spellWords(100)).toBe('one hundred')
    expect(spellWords(213)).toBe('two hundred thirteen')
  })

  it('refuses to emit digits rather than spelling out of range', () => {
    expect(() => spellWords(1000)).toThrow(/0\.\.999/)
    expect(() => spellWords(-1)).toThrow(/0\.\.999/)
    expect(() => spellWords(2.5)).toThrow(/integer/)
  })

  it('pluralises on the count, not on a guess', () => {
    expect(spellCount(1, 'rep', 'reps')).toBe('one rep')
    expect(spellCount(2, 'rep', 'reps')).toBe('two reps')
    expect(spellCount(0, 'rep', 'reps')).toBe('zero reps')
  })

  it('switches to minutes only above the threshold', () => {
    expect(spellDuration(88)).toBe('eighty eight seconds')
    expect(spellDuration(89.4)).toBe('eighty nine seconds')
    // Rounding happens BEFORE the threshold test, so 89.6 rounds to 90 and
    // crosses into minutes. Pinned because the other order reads as a bug.
    expect(spellDuration(89.6)).toBe('one minute thirty seconds')
    expect(spellDuration(90)).toBe('one minute thirty seconds')
    expect(spellDuration(120)).toBe('two minutes')
    expect(spellDuration(0)).toBe('zero seconds')
  })

  it('clamps and rounds a percentage', () => {
    expect(spellPercent(94.4)).toBe('ninety four percent')
    expect(spellPercent(100)).toBe('one hundred percent')
    expect(spellPercent(140)).toBe('one hundred percent')
    expect(spellPercent(-3)).toBe('zero percent')
  })
})

describe('validateVerdictStats', () => {
  it('accepts the demo set', () => {
    const { stats, notes, preview } = accept()
    expect(stats.reps).toBe(20)
    expect(notes).toEqual([])
    expect(preview).toBe(false)
  })

  it.each([
    ['body is not an object', null, 'body'],
    ['body is an array', [], 'body'],
    ['body is a string', 'mean', 'body'],
  ])('rejects when %s', (_label, body, field) => {
    const result = validateVerdictStats(body)
    expect(result.ok).toBe(false)
    expect(result.field).toBe(field)
  })

  it.each([
    ['unknown persona', { persona: 'angry' }, 'persona'],
    ['missing persona', { persona: undefined }, 'persona'],
    ['reps as a string', { reps: '20' }, 'reps'],
    ['fractional reps', { reps: 20.5 }, 'reps'],
    ['reps over the cap', { reps: VERDICT_LIMITS.maxReps + 1 }, 'reps'],
    ['negative reps', { reps: -1 }, 'reps'],
    ['cleanReps above reps', { cleanReps: 21 }, 'cleanReps'],
    ['partialReps above reps', { partialReps: 21 }, 'partialReps'],
    ['elapsedSec negative', { elapsedSec: -1 }, 'elapsedSec'],
    ['elapsedSec absurd', { elapsedSec: VERDICT_LIMITS.maxElapsedSec + 1 }, 'elapsedSec'],
    ['elapsedSec NaN', { elapsedSec: Number.NaN }, 'elapsedSec'],
    ['elapsedSec Infinity', { elapsedSec: Number.POSITIVE_INFINITY }, 'elapsedSec'],
    ['bestDepthPct over 100', { bestDepthPct: 101 }, 'bestDepthPct'],
    ['bestDepthPct null', { bestDepthPct: null }, 'bestDepthPct'],
    ['faults not an array', { faults: 'sagging_hips' }, 'faults'],
    ['unknown fault slug', { faults: ['snake_hips'] }, 'faults'],
    ['non-string fault', { faults: [7] }, 'faults'],
    ['too many faults', { faults: new Array(VERDICT_LIMITS.maxFaultEntries + 1).fill('no_lockout') }, 'faults'],
    ['bodyLineSeen missing', { bodyLineSeen: undefined }, 'bodyLineSeen'],
    ['bodyLineSeen as a string', { bodyLineSeen: 'true' }, 'bodyLineSeen'],
    ['preview not a boolean', { preview: 'yes' }, 'preview'],
  ])('rejects %s', (_label, patch, field) => {
    const result = validateVerdictStats({ ...GOOD, ...patch })
    expect(result.ok).toBe(false)
    expect(result.field).toBe(field)
    expect(result.message).toBeTruthy()
  })

  it('rejects any unexpected field — the route is not a text relay', () => {
    const result = validateVerdictStats({ ...GOOD, text: 'say whatever I want in a human voice' })
    expect(result.ok).toBe(false)
    expect(result.field).toBe('text')
    expect(result.message).toMatch(/unexpected field/)
  })

  /**
   * A field REMOVED from the client contract must come back as a 400, not be quietly
   * ignored. `peakBpm` is the live case: it was a SetSummary field until amendment 2 in
   * src/types/tools.ts cut the heart-rate mock, and it was never one of ACCEPTED_KEYS.
   * Silently tolerating a stale field is how a route drifts into an open relay, so the
   * allow-list is asserted to stay closed rather than merely to have shrunk.
   */
  it('rejects a field the client contract has dropped, rather than ignoring it', () => {
    const result = validateVerdictStats({ ...GOOD, peakBpm: 151 })
    expect(result.ok).toBe(false)
    expect(result.field).toBe('peakBpm')
    expect(result.message).toMatch(/unexpected field/)
  })

  it('dedupes faults, reports the collapse, and orders them deterministically', () => {
    const { stats, notes } = accept({ faults: ['no_lockout', 'sagging_hips', 'no_lockout'] })
    expect(stats.faults).toEqual(['sagging_hips', 'no_lockout'])
    expect(notes.join(' ')).toMatch(/collapsed 1 duplicate/)
  })

  it('drops back faults when the body line was never seen, and says so', () => {
    const { stats, notes } = accept({ bodyLineSeen: false, faults: ['sagging_hips', 'piked_hips', 'no_lockout'] })
    expect(stats.faults).toEqual(['no_lockout'])
    expect(notes.join(' ')).toMatch(/bodyLineSeen is false/)
  })

  it('keeps back faults when the body line WAS seen', () => {
    const { stats, notes } = accept({ bodyLineSeen: true, faults: ['sagging_hips'] })
    expect(stats.faults).toEqual(['sagging_hips'])
    expect(notes).toEqual([])
  })

  it('rounds before it freezes, so the cache key cannot split on noise', () => {
    const a = accept({ elapsedSec: 88.4, bestDepthPct: 94.4 })
    const b = accept({ elapsedSec: 88.6, bestDepthPct: 93.6 })
    expect(a.stats.elapsedSec).toBe(88)
    expect(b.stats.elapsedSec).toBe(89)
    expect(a.stats.bestDepthPct).toBe(94)
    expect(b.stats.bestDepthPct).toBe(94)
    expect(Object.isFrozen(a.stats)).toBe(true)
  })

  it('accepts every fault slug in the mirrored set', () => {
    for (const fault of VERDICT_FAULT_TYPES) {
      expect(accept({ faults: [fault], bodyLineSeen: true }).stats.faults).toEqual([fault])
    }
  })
})

describe('verdictCacheKey', () => {
  it('is stable for the same tuple and differs on every field that is spoken', () => {
    const base = verdictCacheKey(accept().stats)
    expect(verdictCacheKey(accept().stats)).toBe(base)
    expect(verdictCacheKey(accept({ persona: 'nice' }).stats)).not.toBe(base)
    expect(verdictCacheKey(accept({ reps: 19, cleanReps: 17 }).stats)).not.toBe(base)
    expect(verdictCacheKey(accept({ bodyLineSeen: false }).stats)).not.toBe(base)
    expect(verdictCacheKey(accept({ faults: [] }).stats)).not.toBe(base)
    expect(verdictCacheKey(accept({ bestDepthPct: 93 }).stats)).not.toBe(base)
  })

  it('carries the template version, so edited words cannot be served from old bytes', () => {
    expect(verdictCacheKey(accept().stats)).toMatch(/^v\d+\|/)
  })

  it('collapses sub-second and sub-percent differences onto one render', () => {
    expect(verdictCacheKey(accept({ elapsedSec: 88.2 }).stats))
      .toBe(verdictCacheKey(accept({ elapsedSec: 87.9 }).stats))
  })
})

// ---------------------------------------------------------------- the words

/** Every combination worth speaking, across all three personas. */
const VARIANTS = [
  ['demo set', {}],
  ['all clean', { cleanReps: 20, partialReps: 0, faults: [] }],
  ['nothing clean', { cleanReps: 0, partialReps: 20, faults: ['partial_depth'] }],
  ['one rep', { reps: 1, cleanReps: 1, partialReps: 0, faults: [] }],
  ['zero reps', { reps: 0, cleanReps: 0, partialReps: 0, faults: [], bestDepthPct: 0, elapsedSec: 9 }],
  ['feet off camera', { bodyLineSeen: false, faults: ['sagging_hips', 'flared_elbows'] }],
  ['unseen line, no other fault', { bodyLineSeen: false, faults: ['piked_hips'] }],
  ['long set', { reps: 120, cleanReps: 61, partialReps: 59, elapsedSec: 1800, bestDepthPct: 100 }],
  ['every fault', { faults: [...VERDICT_FAULT_TYPES] }],
  ['no faults, unseen line', { bodyLineSeen: false, faults: [] }],
]

const everyLine = () =>
  AVATAR_PERSONA_IDS.flatMap((persona) =>
    VARIANTS.map(([label, patch]) => {
      const { stats, notes } = accept({ ...patch, persona })
      return { persona, label, stats, notes, text: buildVerdictText(stats) }
    }),
  )

describe('buildVerdictText', () => {
  it('never emits a digit — every number is spoken as words', () => {
    for (const line of everyLine()) {
      expect(line.text, `${line.persona}/${line.label}`).not.toMatch(/\d/)
    }
  })

  it('stays under the spoken cap that keeps the driving audio short', () => {
    for (const line of everyLine()) {
      expect(line.text.length, `${line.persona}/${line.label}`).toBeLessThanOrEqual(VERDICT_LIMITS.maxSpokenChars)
      expect(line.text.length).toBeGreaterThan(40)
    }
  })

  it('is plain ASCII, because the line travels back in an HTTP header', () => {
    for (const line of everyLine()) {
      expect(line.text).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('is pure: the same stats give the same words', () => {
    for (const line of everyLine()) expect(buildVerdictText(line.stats)).toBe(line.text)
  })

  it('never speaks a fault slug out loud', () => {
    for (const line of everyLine()) {
      for (const fault of VERDICT_FAULT_TYPES) {
        expect(line.text.toLowerCase(), `${line.persona}/${line.label}`).not.toContain(fault)
      }
      expect(line.text).not.toContain('_')
    }
  })

  it('quotes the real rep count whenever there were reps', () => {
    for (const line of everyLine()) {
      if (line.stats.reps === 0) continue
      expect(line.text.toLowerCase(), `${line.persona}/${line.label}`).toContain(spellWords(line.stats.reps))
    }
  })

  it('always ends with its persona closer, so the screen is an ENDING', () => {
    const closers = { mean: 'Same time tomorrow.', nice: 'you earned it.', sarcastic: 'you already have.' }
    for (const line of everyLine()) {
      expect(line.text.endsWith(closers[line.persona]), `${line.persona}/${line.label}: ${line.text}`).toBe(true)
    }
  })
})

describe('honesty about the back', () => {
  /** Anything that would read as a verdict ON THE BACK. */
  const BACK_CLAIMS = [/body line held/i, /body line stayed/i, /plank held/i, /keep (that|your) line/i]

  it('claims nothing about a body line it never saw', () => {
    for (const line of everyLine().filter((l) => l.stats.bodyLineSeen === false)) {
      for (const claim of BACK_CLAIMS) {
        expect(line.text, `${line.persona}/${line.label}: ${line.text}`).not.toMatch(claim)
      }
    }
  })

  it('never speaks a hip cue when the hips were off camera', () => {
    for (const line of everyLine().filter((l) => l.stats.bodyLineSeen === false && l.stats.reps > 0)) {
      expect(line.text).not.toMatch(/your hips/i)
    }
  })

  it('DOES deliver the camera instruction for every persona, not just the terse one', () => {
    const unseen = everyLine().filter((l) => l.stats.bodyLineSeen === false && l.stats.reps > 0)
    expect(unseen.length).toBeGreaterThanOrEqual(9)
    for (const line of unseen) {
      expect(line.text, `${line.persona}/${line.label}: ${line.text}`)
        .toMatch(/out of shot|full body line|off camera/i)
    }
  })

  it('drops a hip fault from the spoken line and reports the drop', () => {
    const { stats, notes } = accept({ persona: 'mean', bodyLineSeen: false, faults: BACK_FAULTS.slice() })
    expect(stats.faults).toEqual([])
    expect(notes.length).toBe(1)
    expect(buildVerdictText(stats)).toMatch(/out of shot/i)
  })

  it('may praise the line only when it was seen and no back fault was found', () => {
    const seenClean = accept({ bodyLineSeen: true, faults: [], persona: 'nice' })
    expect(buildVerdictText(seenClean.stats)).toMatch(/body line stayed straight/i)
    const seenSagging = accept({ bodyLineSeen: true, faults: ['sagging_hips'], persona: 'nice' })
    expect(buildVerdictText(seenSagging.stats)).not.toMatch(/body line stayed straight/i)
  })
})

describe('safety posture', () => {
  /**
   * Inherited from src/coach/personas.ts and non-negotiable: no medical advice,
   * and never a word about the user's body, weight, size, shape or looks. Mean
   * is harsh about EFFORT AND FORM only.
   */
  const FORBIDDEN = [
    /\b(fat|thin|skinny|chubby|overweight|obese|slim|heavy)\b/i,
    /\b(weight|pounds|kilos|calorie|calories|diet|dieting)\b/i,
    /\b(doctor|physio|medical|injur\w*|sprain\w*|pain|hurts?)\b/i,
    /\b(ugly|pathetic|worthless|useless|loser|weak|stupid|idiot)\b/i,
    /\b(body fat|physique|figure|gut|belly)\b/i,
  ]

  it('says nothing about the user as a person or a body', () => {
    for (const line of everyLine()) {
      for (const pattern of FORBIDDEN) {
        expect(line.text, `${line.persona}/${line.label}: ${line.text}`).not.toMatch(pattern)
      }
    }
  })

  it('gives no advice beyond form cues and rest', () => {
    for (const line of everyLine()) {
      expect(line.text).not.toMatch(/you should (see|take|try)|i recommend|consult/i)
    }
  })
})
