/**
 * LIVE probe for the ending screen's stage-2 path. SKIPPED by default.
 *
 *   npm run serve            # in another shell, with BOSON_API_KEY set
 *   SPOTTER_LIVE=1 npx vitest run verdictLive
 *
 * It drives the REAL client module (src/ui/verdictClient.ts) against the REAL route
 * and the real upstream render, which is the only way to check the two things a stub
 * cannot: that the provenance headers this client reads are actually the ones the
 * server sends, and that the bytes it hands the <video> element are a real mp4.
 *
 * `fetchImpl` only prefixes the origin — Node has no page to resolve `/api/verdict`
 * against. Every code path under test is the shipped one.
 *
 * A render is 22-31 s and costs credits, so the video case has a long timeout and
 * there is exactly one of them.
 */
import { describe, expect, it } from 'vitest'
import { fetchVerdictVideo, fetchVerdictWords, verdictRequestFrom } from '../verdictClient'
import { EMPTY_LEDGER } from '../setLedger'
import { summariseSet } from '../setSummary'
import type { SetLedger } from '../setLedger'

const LIVE = process.env.SPOTTER_LIVE === '1'
const ORIGIN = process.env.SPOTTER_ORIGIN ?? 'http://localhost:8080'
const RENDER_TIMEOUT_MS = 150_000

/** Prefixes the origin and nothing else. */
const viaOrigin: typeof fetch = (input, init) => fetch(`${ORIGIN}${String(input)}`, init)

function summaryFor(overrides: Partial<SetLedger>) {
  return summariseSet({
    ledger: { ...EMPTY_LEDGER, startedAt: 1000, lastRepAt: 89_000, endedAt: 89_000, ...overrides },
    target: 20,
    reason: 'target_reached',
    now: 90_000,
  })
}

const FULL_SET: Partial<SetLedger> = {
  reps: 20,
  cleanReps: 18,
  partialReps: 2,
  bestDepthPct: 96,
  measuredReps: 20,
  worstHipDeviationDeg: 6,
  faults: ['no_lockout'],
}

const UNSEEN_SET: Partial<SetLedger> = {
  reps: 20,
  cleanReps: 18,
  partialReps: 0,
  bestDepthPct: 91,
  measuredReps: 0,
  worstHipDeviationDeg: null,
  faults: ['sagging_hips', 'no_lockout'],
}

describe.skipIf(!LIVE)('POST /api/verdict, live', () => {
  it('returns the coach words for every persona in preview', async () => {
    for (const persona of ['mean', 'nice', 'sarcastic'] as const) {
      const outcome = await fetchVerdictWords(verdictRequestFrom(summaryFor(FULL_SET), persona), {
        fetchImpl: viaOrigin,
      })
      if (outcome.kind !== 'words') throw new Error(`${persona}: ${outcome.kind}`)
      expect(outcome.text.length).toBeGreaterThan(40)
      console.log(`[live] ${persona}/${outcome.voice}: ${outcome.text}`)
    }
  })

  it('says nothing about the back when the body line was never seen', async () => {
    const outcome = await fetchVerdictWords(verdictRequestFrom(summaryFor(UNSEEN_SET), 'nice'), {
      fetchImpl: viaOrigin,
    })
    if (outcome.kind !== 'words') throw new Error(outcome.kind)
    console.log(`[live] unseen line: ${outcome.text}`)
    console.log(`[live] server notes: ${outcome.notes.join(' | ')}`)
    expect(outcome.text.toLowerCase()).not.toContain('hip')
    expect(outcome.notes.join(' ')).toContain('sagging_hips')
  })

  it(
    'renders a real mp4 and the provenance headers this client reads',
    async () => {
      const startedAt = Date.now()
      const outcome = await fetchVerdictVideo(verdictRequestFrom(summaryFor(FULL_SET), 'mean'), {
        fetchImpl: viaOrigin,
      })
      if (outcome.kind !== 'video') throw new Error(`${outcome.kind}: ${JSON.stringify(outcome)}`)
      const bytes = new Uint8Array(await outcome.blob.arrayBuffer())
      console.log(
        `[live] ${bytes.byteLength} bytes in ${Date.now() - startedAt} ms | cache=${outcome.meta.cache} ` +
          `voice=${outcome.meta.voice} render=${outcome.meta.renderMs}ms polls=${outcome.meta.polls}`,
      )
      // 'ftyp' at offset 4 is the ISO base media file signature: a real mp4, not JSON.
      expect(String.fromCharCode(...bytes.slice(4, 8))).toBe('ftyp')
      expect(outcome.blob.size).toBeGreaterThan(200_000)
      expect(outcome.meta.text.length).toBeGreaterThan(40)
      expect(outcome.meta.voice).toBe('jake')
      expect(['miss', 'hit', 'shared']).toContain(outcome.meta.cache)
    },
    RENDER_TIMEOUT_MS,
  )
})
