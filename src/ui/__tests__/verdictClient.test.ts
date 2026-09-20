/**
 * The browser half of POST /api/verdict.
 *
 * THE FIRST BLOCK IS THE ONE THAT MATTERS: it feeds the payload this client actually
 * builds to the REAL server validator (server/verdictText.mjs, imported here, not
 * mirrored), so a renamed field, a stray extra key or an out-of-range number fails
 * here instead of at 400 on the ending screen. Plain Node cannot import a .ts and the
 * browser cannot import the server's .mjs, but a vitest run can hold both.
 *
 * The rest pins the degradation contract: every failure shape the route can answer
 * with must come back as something the screen can render, and a non-200 that carries
 * the coach's real closing words must not lose them.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER } from '../setLedger'
import { summariseSet } from '../setSummary'
import type { SetSummary } from '../setSummary'
import { fetchVerdictVideo, fetchVerdictWords, verdictRequestFrom, VERDICT_ROUTE } from '../verdictClient'
import type { VerdictRequest } from '../verdictClient'

interface ServerValidation {
  ok: boolean
  field?: string
  message?: string
  stats?: { faults: readonly string[]; bodyLineSeen: boolean }
  notes?: readonly string[]
}

async function serverValidate(body: unknown): Promise<ServerValidation> {
  // @ts-expect-error — plain-Node module with no type declarations, on purpose: it is
  // the shipped server validator, and importing the real thing is the entire point.
  const { validateVerdictStats } = await import('../../../server/verdictText.mjs')
  return validateVerdictStats(body) as ServerValidation
}

function summary(overrides: Partial<Parameters<typeof summariseSet>[0]['ledger']> = {}): SetSummary {
  return summariseSet({
    ledger: {
      ...EMPTY_LEDGER,
      reps: 20,
      cleanReps: 18,
      partialReps: 2,
      bestDepthPct: 96,
      measuredReps: 20,
      worstHipDeviationDeg: 6,
      faults: ['no_lockout'],
      startedAt: 1000,
      lastRepAt: 89_000,
      endedAt: 89_000,
      ...overrides,
    },
    target: 20,
    reason: 'target_reached',
    now: 90_000,
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function videoResponse(bytes: readonly number[], headers: Record<string, string>): Response {
  const body = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4', ...headers } })
}

/** Records what went on the wire, so the request shape is asserted, not assumed. */
function recordingFetch(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; body: unknown }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) })
    return typeof response === 'function' ? response() : response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('verdictRequestFrom', () => {
  it('sends exactly the nine scalars and no text', () => {
    const request = verdictRequestFrom(summary(), 'mean')
    expect(Object.keys(request).sort()).toEqual([
      'bestDepthPct',
      'bodyLineSeen',
      'cleanReps',
      'elapsedSec',
      'faults',
      'partialReps',
      'persona',
      'reps',
    ])
  })

  it('claims bodyLineSeen only for FULL coverage — one unmeasured rep is enough to withhold it', () => {
    expect(verdictRequestFrom(summary(), 'mean').bodyLineSeen).toBe(true)
    expect(verdictRequestFrom(summary({ measuredReps: 19 }), 'mean').bodyLineSeen).toBe(false)
    expect(verdictRequestFrom(summary({ measuredReps: 0 }), 'mean').bodyLineSeen).toBe(false)
  })

  it('rounds the duration, because the route wants a finite number it can spell', () => {
    expect(verdictRequestFrom(summary(), 'mean').elapsedSec).toBe(88)
  })
})

describe('the payload against the REAL server validator', () => {
  const personas = ['mean', 'nice', 'sarcastic'] as const

  it('accepts a normal set from every persona', async () => {
    for (const persona of personas) {
      const result = await serverValidate({ ...verdictRequestFrom(summary(), persona) })
      expect(result.ok, `${persona}: ${result.field} ${result.message}`).toBe(true)
    }
  })

  it('accepts the unseen-body-line set, and the server reports the hip fault it dropped', async () => {
    const request = verdictRequestFrom(summary({ measuredReps: 0, faults: ['sagging_hips', 'no_lockout'] }), 'nice')
    const result = await serverValidate({ ...request })
    expect(result.ok).toBe(true)
    expect(result.stats?.bodyLineSeen).toBe(false)
    expect(result.stats?.faults).toEqual(['no_lockout'])
    expect(result.notes?.join(' ')).toContain('sagging_hips')
  })

  it('accepts a zero-rep set and an every-fault set', async () => {
    const zero = await serverValidate({
      ...verdictRequestFrom(summary({ reps: 0, cleanReps: 0, partialReps: 0, bestDepthPct: 0, measuredReps: 0 }), 'mean'),
    })
    expect(zero.ok, zero.message).toBe(true)
    const everything = await serverValidate({
      ...verdictRequestFrom(
        summary({
          faults: ['sagging_hips', 'piked_hips', 'partial_depth', 'no_lockout', 'craned_neck', 'flared_elbows', 'out_of_frame'],
        }),
        'sarcastic',
      ),
    })
    expect(everything.ok, everything.message).toBe(true)
  })

  it('accepts the preview flag this client adds', async () => {
    const result = await serverValidate({ ...verdictRequestFrom(summary(), 'mean'), preview: true })
    expect(result.ok, result.message).toBe(true)
  })

  it('is not self-confirming: the validator rejects a payload with one extra field', async () => {
    const result = await serverValidate({ ...verdictRequestFrom(summary(), 'mean'), text: 'say whatever I want' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('unexpected field')
  })
})

describe('fetchVerdictWords', () => {
  const request: VerdictRequest = verdictRequestFrom(summary(), 'mean')

  it('posts the preview flag to the verdict route and returns the coach words', async () => {
    const fetchStub = recordingFetch(
      jsonResponse(200, { text: 'Twenty reps. Eighteen real.', voice: 'jake', notes: ['collapsed 1 duplicate fault(s)'] }),
    )
    const outcome = await fetchVerdictWords(request, { fetchImpl: fetchStub.impl })
    expect(fetchStub.calls[0]?.url).toBe(VERDICT_ROUTE)
    expect(fetchStub.calls[0]?.body).toMatchObject({ preview: true, reps: 20 })
    expect(outcome).toEqual({
      kind: 'words',
      text: 'Twenty reps. Eighteen real.',
      voice: 'jake',
      notes: ['collapsed 1 duplicate fault(s)'],
    })
  })

  it('treats an empty preview as unavailable rather than showing a blank headline', async () => {
    const fetchStub = recordingFetch(jsonResponse(200, { text: '', voice: 'jake' }))
    const outcome = await fetchVerdictWords(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'empty_preview' })
  })
})

describe('fetchVerdictVideo', () => {
  const request: VerdictRequest = verdictRequestFrom(summary(), 'mean')

  it('returns the bytes and the provenance headers', async () => {
    const fetchStub = recordingFetch(
      videoResponse([0, 0, 0, 24, 102, 116, 121, 112], {
        'X-Verdict-Cache': 'miss',
        'X-Verdict-Job-Id': 'video_1fca02adb58e4b7bbaf20aa3',
        'X-Verdict-Voice': 'jake',
        'X-Verdict-Persona': 'mean',
        'X-Verdict-Text': 'Twenty reps. Eighteen real.',
        'X-Verdict-Notes': 'collapsed 1 duplicate fault(s) | ignored sagging_hips',
        'X-Verdict-Render-Ms': '24320',
        'X-Verdict-Polls': '12',
      }),
    )
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(fetchStub.calls[0]?.body).not.toHaveProperty('preview')
    if (outcome.kind !== 'video') throw new Error(`expected video, got ${outcome.kind}`)
    expect(outcome.blob.size).toBe(8)
    expect(outcome.meta).toEqual({
      cache: 'miss',
      jobId: 'video_1fca02adb58e4b7bbaf20aa3',
      voice: 'jake',
      persona: 'mean',
      text: 'Twenty reps. Eighteen real.',
      notes: ['collapsed 1 duplicate fault(s)', 'ignored sagging_hips'],
      renderMs: 24_320,
      polls: 12,
    })
  })

  it('keeps the coach words that a 409 busy answer carries', async () => {
    const fetchStub = recordingFetch(
      jsonResponse(409, {
        error: 'render_busy',
        message: 'Another verdict render is already in flight',
        retryable: true,
        text: 'Twenty reps. Eighteen real.',
        video: false,
      }),
    )
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toEqual({
      kind: 'unavailable',
      code: 'render_busy',
      message: 'Another verdict render is already in flight',
      retryable: true,
      text: 'Twenty reps. Eighteen real.',
    })
  })

  it('survives an answer that is not JSON at all — a proxy, or a dead server', async () => {
    const fetchStub = recordingFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'http_502', retryable: false, text: null })
  })

  it('reports a network failure as retryable rather than throwing at the screen', async () => {
    const fetchStub = recordingFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'network', retryable: true })
  })

  it('reports an abort as an abort, so the hook can stay silent about it', async () => {
    const fetchStub = recordingFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')))
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  it('refuses a zero-byte video instead of handing the player an empty clip', async () => {
    const fetchStub = recordingFetch(videoResponse([], {}))
    const outcome = await fetchVerdictVideo(request, { fetchImpl: fetchStub.impl })
    expect(outcome).toMatchObject({ kind: 'unavailable', code: 'empty_video' })
  })
})
