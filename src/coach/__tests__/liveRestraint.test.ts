/**
 * LIVE: DID RESTRAINT MAKE THE COACH INCOHERENT? Skipped unless you ask for it:
 *
 *   SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveRestraint -t "counts a 20-rep set"
 *
 * Run ONE at a time with a pause between: each costs a real session, and the voices API
 * intermittently answers 429 and terminates the session before the ack.
 *
 * ── THE RISK THIS EXISTS FOR ────────────────────────────────────────────────────────────
 * The speech policy is measured and the numbers are good, but a quiet coach can be quiet and
 * WRONG. Saying nothing about reps 2, 3 and 4 means the model's only account of them is a
 * collapsed clause ("3 reps went by without comment"), and the risk is that it then loses the
 * thread: a coach that shouts "REP FOUR!" on the eighth rep is worse than a chatty one,
 * because it is now lying about something the user can count themselves.
 *
 * So this pushes the EXACT lines the shipped policy selects for a realistic 20-rep set —
 * computed by `replay()` from the real reducers, digest clauses and all — into a real session
 * with a real persona prompt, and reads back what the model says. The assertions are about
 * ARITHMETIC, not tone: every number the coach utters must be a number that was pushed to it.
 *
 * ── WHY THE LINES ARE COMPUTED AND THEN PUSHED, NOT PUSHED THROUGH pushEvent ────────────
 * `sendUserText` and `pushEvent` produce byte-identical wire frames (`userItem` +
 * `response.create` — see higgsSocket.ts), so pushing a pre-selected line is exactly what the
 * session does, minus a 50-second wait. It also makes the live run reproducible: the policy's
 * choices are deterministic and already measured by `speechBudget.test.ts`, so the only
 * variable left here is the model, which is the thing under test.
 */
import { describe, expect, it } from 'vitest'
import { createProbe, PROBE, say, sleep, transcriptOf } from './liveProbe'
import type { Probe } from './liveProbe'
import { fullSet, replay, SET_REPS } from './setReplay'
import { PERSONA_ORDER } from '../personas'

/** Long enough for a 14-word line plus the model's own latency, measured at ~600ms first audio. */
const REPLY_MS = 9_000
/** Polling grain while waiting for `response.done`. */
const POLL_MS = 250

/** The lines the shipped policy actually selects for a full 20-rep set with a target. */
async function policyLines(): Promise<string[]> {
  const { lines } = await replay({ events: fullSet(SET_REPS), throttled: true })
  return lines
}

/** Pushes one line and waits for the model to finish answering it. */
async function pushAndWait(probe: Probe, line: string): Promise<void> {
  const before = probe.count('response.done')
  probe.session.sendUserText(line)
  const deadline = performance.now() + REPLY_MS
  while (performance.now() < deadline) {
    await sleep(POLL_MS)
    if (probe.count('response.done') > before) return
  }
}

/** Every number the coach said, as digits — including the ones it spelled in words. */
const WORD_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
})

export function numbersIn(text: string): number[] {
  const digits = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))
  const words = [...text.toLowerCase().matchAll(/[a-z]+/g)]
    .map((match) => WORD_NUMBERS[match[0]])
    .filter((value): value is number => value !== undefined)
  return [...digits, ...words]
}

describe.skipIf(!PROBE.live || PROBE.key === '')('live: restraint without incoherence', () => {
  it('counts a 20-rep set correctly while speaking only a handful of times', async () => {
    const lines = await policyLines()
    say(`\n=== the ${lines.length} lines the policy selected for a ${SET_REPS}-rep set ===`)
    lines.forEach((line, i) => say(`  push ${i + 1}: ${line}`))

    const probe = createProbe({ persona: 'mean' })
    await probe.session.connect()
    for (const line of lines) {
      await pushAndWait(probe, line)
      // Spaced like the real set rather than back to back, so the model's context grows the
      // way it does in a room and a late line cannot be answered out of order.
      await sleep(600)
    }
    await sleep(1_500)
    say(`\n${transcriptOf(probe, 'mean, 20-rep set through the shipped policy')}\n`)

    const captions = probe.captions.join(' ')
    // It answered at all, on most turns. A silent coach is a different bug.
    expect(probe.count('response.done')).toBeGreaterThanOrEqual(lines.length - 1)
    /**
     * THE ARITHMETIC CHECK. Every rep number the coach utters must be one that was pushed.
     * `20` is the target and appears in the set_started line, so the interesting failure is a
     * number in between that nobody mentioned — "rep four" during rep eight.
     */
    const pushed = new Set(lines.flatMap((line) => numbersIn(line)))
    const invented = numbersIn(captions).filter((value) => value <= SET_REPS && !pushed.has(value))
    say(`pushed numbers: ${[...pushed].sort((a, b) => a - b).join(', ')}`)
    say(`coach numbers:  ${numbersIn(captions).join(', ')}`)
    say(`INVENTED:       ${invented.length === 0 ? 'none' : invented.join(', ')}`)
    expect(invented).toEqual([])
    probe.session.disconnect()
  }, 180_000)

  it('never enumerates the reps it was told to cover in one breath', async () => {
    // The collapsed digest carries an explicit instruction not to list them. If the model
    // ignores it, restraint has bought nothing: one line becomes four sentences of counting.
    const lines = await policyLines()
    const withDigest = lines.filter((line) => line.includes('went by without comment'))
    expect(withDigest.length).toBeGreaterThan(0)

    const probe = createProbe({ persona: 'mean' })
    await probe.session.connect()
    for (const line of withDigest) {
      await pushAndWait(probe, line)
      await sleep(600)
    }
    await sleep(1_500)
    say(`\n${transcriptOf(probe, 'mean, digest lines only')}\n`)

    for (const caption of probe.captions) {
      // A line that lists reps individually reads like "rep five, rep six, rep seven".
      const repMentions = [...caption.toLowerCase().matchAll(/\brep\b/g)].length
      say(`caption ("${caption}") mentions "rep" ${repMentions}x`)
      expect(repMentions).toBeLessThanOrEqual(2)
    }
    probe.session.disconnect()
  }, 150_000)

  it('all three personas stay coherent on the same selected lines', async () => {
    const lines = await policyLines()
    // Just the two that carry the most arithmetic: the first callout and the target.
    const probeLines = [lines[0]!, lines[lines.length - 1]!]

    for (const persona of PERSONA_ORDER) {
      const probe = createProbe({ persona })
      await probe.session.connect()
      for (const line of probeLines) {
        await pushAndWait(probe, line)
        await sleep(600)
      }
      await sleep(1_200)
      say(`\n${transcriptOf(probe, `${persona}, first + last selected line`)}\n`)

      const pushed = new Set(probeLines.flatMap((line) => numbersIn(line)))
      const invented = numbersIn(probe.captions.join(' ')).filter(
        (value) => value <= SET_REPS && !pushed.has(value),
      )
      say(`${persona}: invented ${invented.length === 0 ? 'none' : invented.join(', ')}`)
      expect(invented).toEqual([])
      probe.session.disconnect()
      // One session at a time, and the voices API needs the gap.
      await sleep(3_000)
    }
  }, 240_000)
})
