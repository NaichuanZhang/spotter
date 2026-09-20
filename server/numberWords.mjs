/**
 * Integers as English words, for text that is going to be SPOKEN.
 *
 * WHY NOT JUST INTERPOLATE THE DIGITS. Every string this produces is driving
 * audio for a talking-head render that takes ~12 s and costs credits, and the
 * whole point of the verdict is that it quotes the user's real numbers. A TTS
 * engine that reads "20" as "two zero", or "95%" as "ninety five percentage",
 * cannot be corrected without paying for another render. The baked intro
 * scripts (scripts/bake-intros.mjs) already spell their one number out in
 * words — "twenty pushups" — so this follows the precedent that is already
 * verified to sound right on this voice stack.
 *
 * ASCII ONLY, deliberately: the rendered line travels back to the browser in
 * an HTTP response header, and header values are latin1. Hyphenated forms
 * ("twenty-five") are avoided for the same class of reason — a hyphen is one
 * more thing for a TTS front-end to interpret. Plain spaces read fine.
 */

const ONES = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
])

const TENS = Object.freeze([
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
])

/** Highest value spellWords accepts. Above this, callers should not be quoting it. */
export const SPELL_MAX = 999

/**
 * Spell a non-negative integer 0..999. Throws outside that range rather than
 * emitting digits, because a digit that reaches the TTS is exactly the failure
 * this module exists to prevent — better a 500 the server logs than a render
 * that says "nine hundred ninety nine" as "9 9 9".
 */
export function spellWords(value) {
  if (!Number.isInteger(value) || value < 0 || value > SPELL_MAX) {
    throw new RangeError(`spellWords expects an integer 0..${SPELL_MAX}, got ${String(value)}`)
  }
  if (value < 20) return ONES[value]
  if (value < 100) {
    const tens = TENS[Math.floor(value / 10)]
    const ones = value % 10
    return ones === 0 ? tens : `${tens} ${ONES[ones]}`
  }
  const hundreds = `${ONES[Math.floor(value / 100)]} hundred`
  const rest = value % 100
  return rest === 0 ? hundreds : `${hundreds} ${spellWords(rest)}`
}

/** "one rep" / "two reps". Pluralisation is the other thing a template gets wrong. */
export function spellCount(value, singular, plural) {
  return `${spellWords(value)} ${value === 1 ? singular : plural}`
}

/** Threshold above which a duration reads better as minutes than as bare seconds. */
export const MINUTES_FROM_SEC = 90

/**
 * A duration, spoken. Under MINUTES_FROM_SEC it stays in seconds because
 * "eighty eight seconds" is how a person in a gym says it; above that,
 * "two minutes ten seconds" beats "one hundred and thirty seconds".
 */
export function spellDuration(totalSeconds) {
  const whole = Math.max(0, Math.round(totalSeconds))
  if (whole < MINUTES_FROM_SEC) return spellCount(whole, 'second', 'seconds')
  const minutes = Math.min(SPELL_MAX, Math.floor(whole / 60))
  const seconds = whole % 60
  const minutePart = spellCount(minutes, 'minute', 'minutes')
  return seconds === 0 ? minutePart : `${minutePart} ${spellCount(seconds, 'second', 'seconds')}`
}

/** A percentage, spoken. Rounded, because "ninety four point seven percent" is not speech. */
export function spellPercent(value) {
  return `${spellWords(Math.max(0, Math.min(100, Math.round(value))))} percent`
}
