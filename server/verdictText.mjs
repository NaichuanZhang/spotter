/**
 * THE CLOSING WORDS. This file is the product; verdictRender.mjs is plumbing.
 *
 * Two jobs, and they are two jobs on purpose:
 *   1. VALIDATE the stats a client POSTs to /api/verdict.
 *   2. TEMPLATE the spoken line from them, server-side.
 *
 * The server templates the line because /v1/videos is a paid generative API
 * reached with the real BOSON_API_KEY. If the route forwarded client text, the
 * URL would be an open relay for putting arbitrary words in a synthetic human
 * mouth on someone else's credits. So the client sends MEASUREMENTS and gets
 * back a coach; it never gets to choose what the coach says.
 *
 * HONESTY IS THE HARD REQUIREMENT, not a nicety. `bodyLineSeen === false`
 * means the hip-to-ankle line was never on camera (feet cropped out of shot is
 * the normal case — see the amendment log in src/types/events.ts). In that
 * state the verdict may not praise OR criticise the user's back, so:
 *   - hip faults are dropped from the spoken line and the drop is REPORTED,
 *   - the body-line clause becomes a camera instruction instead of a judgement.
 *
 * SAFETY POSTURE, inherited from src/coach/personas.ts and non-negotiable: no
 * medical, injury or diet advice, and never a word about the user's body,
 * weight, size, shape or looks. Every line below judges effort and form only.
 */

import { spellCount, spellDuration, spellPercent, spellWords } from './numberWords.mjs'
import { AVATAR_PERSONA_IDS, isAvatarPersonaId } from './avatarPersonas.mjs'

/**
 * The closed fault set, mirroring `FaultType` in src/types/events.ts. Node
 * cannot import that .ts without a bundler, so this is a hand copy — checked,
 * not trusted: `node scripts/verdict-cli.mjs --check-sources` parses the .ts
 * and fails if the two sets differ.
 */
export const VERDICT_FAULT_TYPES = Object.freeze([
  'sagging_hips',
  'piked_hips',
  'partial_depth',
  'no_lockout',
  'craned_neck',
  'flared_elbows',
  'out_of_frame',
])

/** Faults that are a claim ABOUT THE BACK. Unsayable when the line was unseen. */
export const BACK_FAULTS = Object.freeze(['sagging_hips', 'piked_hips'])

/**
 * Which single fault the verdict speaks about. One, not all of them: the line
 * has ~300 characters and a list of six complaints is not coaching. Ordered by
 * how much it costs the rep, which makes the pick deterministic (and testable)
 * rather than "whatever the client happened to put first".
 */
const FAULT_PRIORITY = Object.freeze([
  'sagging_hips',
  'piked_hips',
  'no_lockout',
  'flared_elbows',
  'partial_depth',
  'craned_neck',
  'out_of_frame',
])

export const VERDICT_LIMITS = Object.freeze({
  /** A set nobody will exceed on a demo floor, and spellWords tops out at 999. */
  maxReps: 300,
  /** Two hours. Anything longer is a stuck clock, not a workout. */
  maxElapsedSec: 7200,
  /** Raw array length accepted before dedupe — generous, then collapsed. */
  maxFaultEntries: 32,
  /**
   * Hard cap on the SPOKEN text. Driving audio both sets the output length and
   * is capped at 60 s upstream, so a runaway line would be truncated by the
   * API mid-sentence. ~300 characters is the documented sweet spot and lands
   * around 15-20 s of speech, which is also about as long as anyone wants to
   * watch a talking head after twenty pushups.
   */
  maxSpokenChars: 300,
})

/**
 * Bump when any template below changes. It is part of the cache key, so an
 * edited line cannot be served from a cache entry rendered off the old words.
 */
export const VERDICT_TEXT_VERSION = 1

/** Every key the route accepts. Anything else is a 400 — see validateVerdictStats. */
const ACCEPTED_KEYS = Object.freeze([
  'persona', 'reps', 'cleanReps', 'partialReps', 'faults',
  'elapsedSec', 'bestDepthPct', 'bodyLineSeen', 'preview',
])

// ---------------------------------------------------------------- validation

const fail = (field, message) => ({ ok: false, field, message })

function validateInt(raw, field, max) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return fail(field, `${field} must be an integer, got ${JSON.stringify(raw) ?? typeof raw}`)
  }
  if (raw < 0 || raw > max) return fail(field, `${field} must be between 0 and ${max}, got ${raw}`)
  return { ok: true, value: raw }
}

function validateFiniteRange(raw, field, min, max) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail(field, `${field} must be a finite number, got ${JSON.stringify(raw) ?? typeof raw}`)
  }
  if (raw < min || raw > max) return fail(field, `${field} must be between ${min} and ${max}, got ${raw}`)
  return { ok: true, value: raw }
}

/** Dedupes, keeps FAULT_PRIORITY order, and rejects anything off the allow-list. */
function validateFaults(raw) {
  if (!Array.isArray(raw)) return fail('faults', 'faults must be an array of fault strings')
  if (raw.length > VERDICT_LIMITS.maxFaultEntries) {
    return fail('faults', `faults must hold at most ${VERDICT_LIMITS.maxFaultEntries} entries, got ${raw.length}`)
  }
  const seen = new Set()
  for (const entry of raw) {
    if (typeof entry !== 'string' || !VERDICT_FAULT_TYPES.includes(entry)) {
      return fail('faults', `unknown fault ${JSON.stringify(entry)}; allowed: ${VERDICT_FAULT_TYPES.join(', ')}`)
    }
    seen.add(entry)
  }
  return { ok: true, value: FAULT_PRIORITY.filter((fault) => seen.has(fault)), collapsed: raw.length - seen.size }
}

/**
 * Validate a POSTed body into a normalised stat tuple.
 *
 * Returns `{ ok: false, field, message }` for anything a client got wrong (the
 * caller turns that into a 400), or `{ ok: true, stats, notes }`. `notes` is
 * how a survivable inconsistency gets REPORTED instead of swallowed: the stats
 * are still renderable, but the client is told what the server ignored.
 */
export function validateVerdictStats(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', 'body must be a JSON object of workout stats')
  }
  const unexpected = Object.keys(body).filter((key) => !ACCEPTED_KEYS.includes(key))
  if (unexpected.length > 0) {
    return fail(unexpected[0], `unexpected field(s): ${unexpected.join(', ')}. Accepted: ${ACCEPTED_KEYS.join(', ')}`)
  }
  if (!isAvatarPersonaId(body.persona)) {
    return fail('persona', `persona must be one of ${AVATAR_PERSONA_IDS.join(', ')}, got ${JSON.stringify(body.persona)}`)
  }
  if (typeof body.bodyLineSeen !== 'boolean') {
    return fail('bodyLineSeen', 'bodyLineSeen must be a boolean — it decides whether the coach may mention the back')
  }
  // `preview` asks for the WORDS ONLY, with no render and no credits spent. It
  // is validated but deliberately kept out of `stats`, because it must not
  // reach verdictCacheKey: a preview and a render of the same set are the same
  // verdict and must share one cache entry.
  if (body.preview !== undefined && typeof body.preview !== 'boolean') {
    return fail('preview', `preview must be a boolean when present, got ${JSON.stringify(body.preview)}`)
  }

  const reps = validateInt(body.reps, 'reps', VERDICT_LIMITS.maxReps)
  if (!reps.ok) return reps
  const cleanReps = validateInt(body.cleanReps, 'cleanReps', reps.value)
  if (!cleanReps.ok) return cleanReps
  const partialReps = validateInt(body.partialReps, 'partialReps', reps.value)
  if (!partialReps.ok) return partialReps
  const elapsedSec = validateFiniteRange(body.elapsedSec, 'elapsedSec', 0, VERDICT_LIMITS.maxElapsedSec)
  if (!elapsedSec.ok) return elapsedSec
  const bestDepthPct = validateFiniteRange(body.bestDepthPct, 'bestDepthPct', 0, 100)
  if (!bestDepthPct.ok) return bestDepthPct
  const faults = validateFaults(body.faults)
  if (!faults.ok) return faults

  return {
    ok: true,
    preview: body.preview === true,
    ...normaliseStats({ body, reps, cleanReps, partialReps, elapsedSec, bestDepthPct, faults }),
  }
}

/**
 * Second half of validateVerdictStats, split out to keep both under 50 lines.
 * This is where cross-field honesty is enforced.
 *
 * A hip fault alongside `bodyLineSeen: false` is a contradiction, and it is
 * DROPPED rather than rejected: the verdict is the last thing in the product,
 * the render is the payoff, and refusing the whole set over a flag the user
 * cannot see would trade a real screen for a pedantic 400. The drop is
 * returned as a note so nothing is silently swallowed.
 */
function normaliseStats({ body, reps, cleanReps, partialReps, elapsedSec, bestDepthPct, faults }) {
  const notes = []
  if (faults.collapsed > 0) notes.push(`collapsed ${faults.collapsed} duplicate fault(s)`)

  let spokenFaults = faults.value
  if (body.bodyLineSeen === false) {
    const dropped = spokenFaults.filter((fault) => BACK_FAULTS.includes(fault))
    if (dropped.length > 0) {
      spokenFaults = spokenFaults.filter((fault) => !BACK_FAULTS.includes(fault))
      notes.push(
        `ignored ${dropped.join(', ')} because bodyLineSeen is false: the hip line was never on ` +
          'camera, so the coach must not judge it',
      )
    }
  }

  return {
    notes,
    stats: Object.freeze({
      persona: body.persona,
      reps: reps.value,
      cleanReps: cleanReps.value,
      partialReps: partialReps.value,
      elapsedSec: Math.round(elapsedSec.value),
      bestDepthPct: Math.round(bestDepthPct.value),
      bodyLineSeen: body.bodyLineSeen,
      faults: Object.freeze(spokenFaults),
    }),
  }
}

/**
 * The exact stat tuple, as a cache key. Rounded fields are rounded BEFORE the
 * key is built (in normaliseStats), so 88.4 s and 88.6 s share the render they
 * would have shared anyway — the spoken line only ever uses the rounded value.
 */
export function verdictCacheKey(stats) {
  return [
    `v${VERDICT_TEXT_VERSION}`, stats.persona, stats.reps, stats.cleanReps, stats.partialReps,
    stats.elapsedSec, stats.bestDepthPct, stats.bodyLineSeen ? 'line' : 'noline',
    stats.faults.join('+') || 'none',
  ].join('|')
}

// ---------------------------------------------------------------- the words

/**
 * One fault, spoken as a cue, per persona. Never the slug: the coach saying
 * "sagging_hips" out loud is the single most immersion-breaking thing it can do.
 */
const FAULT_LINES = Object.freeze({
  mean: Object.freeze({
    sagging_hips: 'Your hips dropped. Lock them next time.',
    piked_hips: 'Your hips rode high. Flatten out.',
    partial_depth: 'You cut the depth short. Chest to the floor.',
    no_lockout: 'Soft elbows at the top. Finish the rep.',
    craned_neck: 'Your head led every rep. Keep it neutral.',
    flared_elbows: 'Elbows flying out. Tuck them in.',
    out_of_frame: 'You wandered out of shot. Stay where I can see you.',
  }),
  nice: Object.freeze({
    sagging_hips: 'Tighten the middle and those hips stay up.',
    piked_hips: 'Drop the hips a touch and you are level.',
    partial_depth: 'A little more depth and every one of those counts.',
    no_lockout: 'Push all the way to straight arms at the top.',
    craned_neck: 'Let your head follow your chest and it feels smoother.',
    flared_elbows: 'Tuck the elbows in closer and it gets easier.',
    out_of_frame: 'Scoot back into frame and I can watch every rep.',
  }),
  sarcastic: Object.freeze({
    sagging_hips: 'Your hips went their own way. Structurally ambitious.',
    piked_hips: 'Your hips aimed for the ceiling. A tent, not a plank.',
    partial_depth: 'The depth was more of a suggestion.',
    no_lockout: 'You never straightened your arms. Saving them for later.',
    craned_neck: 'Your head arrived before the rest of you.',
    flared_elbows: 'Your elbows left the building.',
    out_of_frame: 'You left the frame. Dramatic.',
  }),
})

/** Sentence case for a spelled number that starts a clause ("three" -> "Three"). */
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1)

/** Openers and closers. The closer is always spoken — see assemble(). */
const FRAME = Object.freeze({
  mean: Object.freeze({
    zero: 'Zero reps. The floor was right there the whole time.',
    perfect: (reps) => `${cap(spellCount(reps, 'rep', 'reps'))}. All clean. I will allow it.`,
    mixed: (reps, clean) => `${cap(spellCount(reps, 'rep', 'reps'))}. ${cap(spellWords(clean))} of them real.`,
    closer: 'Now get off my floor. Same time tomorrow.',
  }),
  nice: Object.freeze({
    zero: 'You showed up, and showing up is the hardest part.',
    perfect: (reps) => `${cap(spellCount(reps, 'rep', 'reps'))}, and every single one was clean!`,
    mixed: (reps, clean) => `${cap(spellCount(reps, 'rep', 'reps'))}, and ${spellWords(clean)} of them clean!`,
    closer: 'That is real work. Rest up, you earned it.',
  }),
  sarcastic: Object.freeze({
    zero: 'Zero reps. A bold interpretation of a workout.',
    perfect: (reps) => `${cap(spellCount(reps, 'rep', 'reps'))}. All clean. Now I have no material.`,
    mixed: (reps, clean) => `${cap(spellCount(reps, 'rep', 'reps'))}. ${cap(spellWords(clean))} of them clean, which is a ratio.`,
    closer: 'You may now lie down, which I notice you already have.',
  }),
})

/** Middle clauses, in the order they get dropped from the BACK if space runs out. */
const MIDDLES = Object.freeze({
  mean: Object.freeze({
    partial: (n) => `${cap(spellWords(n))} stopped short. Half a rep is an insult.`,
    depth: (pct) => `Your best rep hit ${spellPercent(pct)}.`,
    lineHeld: 'Your body line held. Noted.',
    lineUnseen: 'Your feet were out of shot. Give me the whole body next time.',
    time: (sec) => `${cap(spellDuration(sec))} of work.`,
  }),
  nice: Object.freeze({
    partial: (n) => `${cap(spellCount(n, 'rep', 'reps'))} came up short, and they still counted.`,
    depth: (pct) => `Your deepest rep reached ${spellPercent(pct)}.`,
    lineHeld: 'Your body line stayed straight, which is the hard part.',
    lineUnseen: 'I could not see your full body line, so set the camera back a step next time.',
    time: (sec) => `${cap(spellDuration(sec))}, start to finish.`,
  }),
  sarcastic: Object.freeze({
    partial: (n) => `${cap(spellWords(n))} did not reach depth. I rounded up. Generous.`,
    depth: (pct) => `Deepest rep, ${spellPercent(pct)}. Noted.`,
    lineHeld: 'Your plank held, which I will admit once and never again.',
    lineUnseen: 'Your lower half was off camera throughout, so that stays a mystery.',
    time: (sec) => `${cap(spellDuration(sec))}. I timed it. Obviously.`,
  }),
})

/**
 * opener + required clauses + as many optional ones as fit + closer, under
 * `maxChars`.
 *
 * THREE TIERS, because two were not enough. The opener and closer are never
 * dropped: the opener carries the rep count (the whole reason the screen
 * exists) and the closer is what makes it an ENDING rather than a line that
 * stops. `optional` is packed greedily in order and a clause that does not fit
 * is SKIPPED, not fatal — so a later, shorter clause can still get in.
 *
 * `required` exists because that greedy skip is priority-blind: with only two
 * tiers, "I could not see your full body line" (81 chars) lost its place to
 * "eighty eight seconds, start to finish" (35), so Nice and Sarcastic silently
 * dropped the camera instruction that Mean's shorter phrasing happened to keep.
 * A clause whose job is HONESTY cannot be decided by how wordy its persona is.
 */
function assemble({ opener, required, optional, closer, maxChars }) {
  const head = [opener, ...required]
  const parts = [...head]
  // Separators: one per gap, and head+closer is head.length+1 parts.
  let length = [...head, closer].reduce((total, part) => total + part.length, 0) + head.length
  for (const clause of optional) {
    if (length + 1 + clause.length > maxChars) continue
    parts.push(clause)
    length += 1 + clause.length
  }
  parts.push(closer)
  const text = parts.join(' ')
  if (text.length > maxChars) {
    // Only reachable if opener + required + closer is itself over budget, i.e.
    // a template edit, not a runtime input. Loud, because a truncated verdict
    // would be a mid-sentence cut in a 12 s render nobody can fix live.
    throw new Error(`verdict template overflow: ${text.length} > ${maxChars} chars`)
  }
  return text
}

/** The one fault the verdict speaks about, or null. */
function pickFault(stats) {
  // partial_depth is skipped when the partial COUNT is already being spoken —
  // saying "three stopped short" and then "the depth was a suggestion" is one
  // complaint delivered twice, and it costs a clause that could carry a number.
  const speakable = stats.faults.filter((fault) => !(fault === 'partial_depth' && stats.partialReps > 0))
  return speakable[0] ?? null
}

/**
 * The middle of the line, split into what must be said and what may be cut.
 *
 * The back gets mentioned in exactly two ways: it HELD (only ever claimed when
 * it was seen and nothing was wrong with it), or it was never on camera. The
 * first is a compliment and is droppable; the second is REQUIRED, because it is
 * the sentence that explains why this verdict judges no hips — without it the
 * silence about form is indistinguishable from approval.
 */
function middleClausesFor(stats) {
  const middles = MIDDLES[stats.persona]
  const fault = pickFault(stats)
  const required = stats.bodyLineSeen ? [] : [middles.lineUnseen]
  const optional = []
  if (fault) optional.push(FAULT_LINES[stats.persona][fault])
  if (stats.partialReps > 0) optional.push(middles.partial(stats.partialReps))
  if (stats.reps > 0) optional.push(middles.depth(stats.bestDepthPct))
  if (stats.bodyLineSeen && (!fault || !BACK_FAULTS.includes(fault))) optional.push(middles.lineHeld)
  if (stats.elapsedSec > 0) optional.push(middles.time(stats.elapsedSec))
  return { required, optional }
}

/**
 * Build the spoken verdict. Pure: same stats in, same words out, which is what
 * makes the render cache sound rather than an optimisation that might lie.
 */
export function buildVerdictText(stats) {
  const frame = FRAME[stats.persona]
  if (!frame) throw new Error(`no verdict frame for persona ${String(stats.persona)}`)
  const opener =
    stats.reps === 0
      ? frame.zero
      : stats.cleanReps === stats.reps
        ? frame.perfect(stats.reps)
        : frame.mixed(stats.reps, stats.cleanReps)
  // Zero reps: nothing was measured, so there is no clause to earn — not even
  // the camera instruction, which would be a note about a set that never began.
  const middles = stats.reps === 0 ? { required: [], optional: [] } : middleClausesFor(stats)
  const text = assemble({
    opener,
    required: middles.required,
    optional: middles.optional,
    closer: frame.closer,
    maxChars: VERDICT_LIMITS.maxSpokenChars,
  })
  // Header transport is latin1 and a stray non-ASCII character is a silent
  // mojibake bug that only shows up in the browser, so refuse it here.
  if (!/^[\x20-\x7E]+$/.test(text)) throw new Error(`verdict text is not plain ASCII: ${text}`)
  return text
}
