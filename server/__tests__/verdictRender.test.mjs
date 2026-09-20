/**
 * The render plumbing and the one-at-a-time rule, against a FAKE upstream.
 *
 * WHY FAKE, when the route was also verified live: the branches that matter
 * most here are the ones a live render cannot reach without deliberately
 * wasting ~12 s and credits each time — an async voice failure, a job that
 * never completes, a 429, a /content 404 that never clears. The happy path is
 * verified live; these tests own the failure taxonomy.
 *
 * `timings` shrinks every interval to milliseconds, which is the only reason a
 * 90-second-deadline module is testable in a normal suite.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { getAvatarPersona } from '../avatarPersonas.mjs'
import { VerdictRenderError, looksLikeVoiceFailure, renderVerdictVideo } from '../verdictRender.mjs'
import {
  VERDICT_CACHE,
  VerdictBusyError,
  clearVerdictCache,
  readVerdictCache,
  verdictCacheStats,
  withVerdictSingleFlight,
  writeVerdictCache,
} from '../verdictCache.mjs'

const PERSONA = getAvatarPersona('sarcastic')
const TEXT = 'Twenty reps. All clean. Now I have no material.'
const MP4 = Buffer.from('fake-mp4-bytes')

const FAST = { pollIntervalMs: 1, contentRetryMs: 1, overallTimeoutMs: 2_000, minMsForVoiceRetry: 1 }

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A scripted upstream. `plan` maps a voice to the statuses its job reports, so
 * one fake can play "jake works" and "bogus voice fails 12 s later" at once.
 */
function fakeUpstream(plan) {
  const calls = []
  const jobs = new Map()
  let nextId = 1

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v1', '')
    calls.push(`${init.method ?? 'GET'} ${path}`)

    if (path === '/videos' && init.method === 'POST') {
      const body = JSON.parse(init.body)
      const script = plan[body.input_tts.voice] ?? plan.default
      if (script.postStatus) return new Response(script.postBody ?? 'nope', { status: script.postStatus })
      const id = `job-${nextId++}`
      jobs.set(id, { script, polls: 0, contentHits: 0 })
      return json({ id, status: 'queued' })
    }

    const jobMatch = /^\/videos\/([^/]+)(\/content)?$/.exec(path)
    if (!jobMatch) throw new Error(`fake upstream got an unexpected path: ${path}`)
    const job = jobs.get(jobMatch[1])
    if (!job) return new Response('no such job', { status: 404 })

    if (jobMatch[2]) {
      job.contentHits += 1
      if (job.contentHits <= (job.script.content404s ?? 0)) return new Response('', { status: 404 })
      if (job.script.contentStatus) return new Response('boom', { status: job.script.contentStatus })
      if (job.script.emptyContent) return new Response(Buffer.alloc(0), { status: 200 })
      return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }

    const statuses = job.script.statuses ?? ['completed']
    const status = statuses[Math.min(job.polls, statuses.length - 1)]
    job.polls += 1
    if (job.script.pollStatus) return new Response('gone', { status: job.script.pollStatus })
    return json(status === 'failed' ? { status, error: job.script.error ?? 'boom' } : { status })
  }

  return { fetchImpl, calls, countOf: (needle) => calls.filter((c) => c === needle).length }
}

const render = (plan, extra = {}) =>
  renderVerdictVideo({
    apiKey: 'test-key',
    persona: PERSONA,
    text: TEXT,
    fetchImpl: fakeUpstream(plan).fetchImpl,
    timings: FAST,
    ...extra,
  })

describe('looksLikeVoiceFailure', () => {
  it('recognises the async failure text measured on this API', () => {
    expect(looksLikeVoiceFailure('tts stream failed: 400 Unknown voice')).toBe(true)
    expect(looksLikeVoiceFailure('invalid voice id')).toBe(true)
    expect(looksLikeVoiceFailure('unsupported voice')).toBe(true)
  })

  it('does not claim unrelated failures are about the voice', () => {
    expect(looksLikeVoiceFailure('429 insufficient_quota')).toBe(false)
    expect(looksLikeVoiceFailure('internal server error')).toBe(false)
    // A rate limit on the voices lookup is NOT a bad voice: retrying on the
    // fallback would change the character for no reason.
    expect(looksLikeVoiceFailure('voices API returned HTTP 429')).toBe(false)
  })
})

describe('renderVerdictVideo', () => {
  it('starts, polls, downloads, and reports what it did', async () => {
    const upstream = fakeUpstream({ default: { statuses: ['queued', 'processing', 'completed'] } })
    const seen = []
    const result = await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      fetchImpl: upstream.fetchImpl,
      timings: FAST,
      onJobId: (id) => seen.push(id),
    })
    expect(result.bytes.equals(MP4)).toBe(true)
    expect(result.voice).toBe(PERSONA.voice)
    expect(result.statuses).toEqual(['queued', 'processing', 'completed'])
    expect(result.contentType).toBe('video/mp4')
    expect(seen).toEqual([result.jobId])
    expect(result.attempts).toEqual([{ voice: PERSONA.voice, jobId: result.jobId, ok: true, polls: 3 }])
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('sends the persona ref_image, size, tts tag and voice the avatar path needs', async () => {
    let body = null
    const upstream = fakeUpstream({ default: {} })
    await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      timings: FAST,
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') body = JSON.parse(init.body)
        return upstream.fetchImpl(url, init)
      },
    })
    expect(body.model).toBe('higgs-avatar')
    expect(body.ref_image).toBe(PERSONA.refImage)
    expect(body.size).toBe('640x640')
    expect(body.input_tts.model).toBe('higgs-tts-v3')
    expect(body.input_tts.voice).toBe(PERSONA.voice)
    // The tag is prepended here, not baked into the verdict text — it is parsed
    // and consumed on this path and would be read aloud nowhere else.
    expect(body.input_tts.input).toBe(`${PERSONA.ttsTag}${TEXT}`)
  })

  it('treats a /content 404 as "still finalising" and retries', async () => {
    const upstream = fakeUpstream({ default: { content404s: 3 } })
    const result = await renderVerdictVideo({
      apiKey: 'k', persona: PERSONA, text: TEXT, fetchImpl: upstream.fetchImpl, timings: FAST,
    })
    expect(result.bytes.equals(MP4)).toBe(true)
    expect(result.contentNotReady).toBe(3)
  })

  it('recovers on the fallback voice when the job fails ASYNCHRONOUSLY on the voice', async () => {
    const result = await render({
      [PERSONA.voice]: { statuses: ['queued', 'failed'], error: 'tts stream failed: 400 Unknown voice' },
      [PERSONA.fallbackVoice]: { statuses: ['completed'] },
    })
    expect(result.voice).toBe(PERSONA.fallbackVoice)
    expect(result.bytes.equals(MP4)).toBe(true)
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]).toMatchObject({ voice: PERSONA.voice, ok: false, voiceFailure: true })
    expect(result.attempts[1]).toMatchObject({ voice: PERSONA.fallbackVoice, ok: true })
  })

  it('recovers when the voice is rejected at POST time instead', async () => {
    const result = await render({
      [PERSONA.voice]: { postStatus: 400, postBody: 'Unknown voice: oliver' },
      [PERSONA.fallbackVoice]: {},
    })
    expect(result.voice).toBe(PERSONA.fallbackVoice)
  })

  it('gives up after BOTH voices fail, and says both were tried', async () => {
    const both = { statuses: ['failed'], error: 'tts stream failed: 400 Unknown voice' }
    const err = await render({ [PERSONA.voice]: both, [PERSONA.fallbackVoice]: both }).catch((e) => e)
    expect(err).toBeInstanceOf(VerdictRenderError)
    expect(err.code).toBe('render_failed')
    expect(err.httpStatus).toBe(502)
    expect(err.attempts.map((a) => a.voice)).toEqual([PERSONA.voice, PERSONA.fallbackVoice])
    expect(err.detail).toMatch(/Unknown voice/)
  })

  it('does NOT retry a failure that has nothing to do with the voice', async () => {
    const upstream = fakeUpstream({ default: { statuses: ['failed'], error: 'internal error' } })
    const err = await renderVerdictVideo({
      apiKey: 'k', persona: PERSONA, text: TEXT, fetchImpl: upstream.fetchImpl, timings: FAST,
    }).catch((e) => e)
    expect(err.code).toBe('render_failed')
    expect(err.attempts).toHaveLength(1)
    expect(upstream.countOf('POST /videos')).toBe(1)
  })

  it('maps a 429 to a retryable 429, not a 502 — concurrent renders are rate limited', async () => {
    const err = await render({ default: { postStatus: 429, postBody: '{"error":"rate_limited"}' } }).catch((e) => e)
    expect(err.code).toBe('render_rate_limited')
    expect(err.httpStatus).toBe(429)
    expect(err.detail).toMatch(/rate_limited/)
  })

  it('times out instead of polling forever', async () => {
    const err = await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      fetchImpl: fakeUpstream({ default: { statuses: ['queued'] } }).fetchImpl,
      timings: { ...FAST, overallTimeoutMs: 60 },
    }).catch((e) => e)
    expect(err.code).toBe('render_timeout')
    expect(err.httpStatus).toBe(504)
    expect(err.detail).toMatch(/statuses seen: queued/)
  })

  it('refuses a second 12 s render it cannot finish inside the deadline', async () => {
    const err = await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      fetchImpl: fakeUpstream({
        [PERSONA.voice]: { statuses: ['failed'], error: 'Unknown voice' },
        [PERSONA.fallbackVoice]: {},
      }).fetchImpl,
      timings: { ...FAST, minMsForVoiceRetry: 10_000 },
    }).catch((e) => e)
    expect(err.code).toBe('render_failed')
    expect(err.attempts).toHaveLength(1)
    expect(err.detail).toMatch(/no budget for a .* retry/)
  })

  it('reports an unreachable upstream rather than hanging', async () => {
    const err = await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      timings: FAST,
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    }).catch((e) => e)
    expect(err.code).toBe('render_unreachable')
    expect(err.httpStatus).toBe(502)
  })

  it.each([
    ['a poll that 404s', { pollStatus: 404 }, 'render_poll_failed'],
    ['content that errors', { contentStatus: 500 }, 'render_content_failed'],
    ['zero bytes of video', { emptyContent: true }, 'render_empty'],
  ])('surfaces %s as a structured error', async (_label, script, code) => {
    const err = await render({ default: script }).catch((e) => e)
    expect(err.code).toBe(code)
    expect(err.message).toBeTruthy()
  })

  it('rejects a job POST that returns no id', async () => {
    const err = await renderVerdictVideo({
      apiKey: 'k',
      persona: PERSONA,
      text: TEXT,
      timings: FAST,
      fetchImpl: async () => json({ status: 'queued' }),
    }).catch((e) => e)
    expect(err.code).toBe('render_start_failed')
    expect(err.message).toMatch(/no job id/)
  })
})

describe('verdict cache', () => {
  const entry = (bytes) => ({ bytes: Buffer.alloc(bytes), contentType: 'video/mp4', text: TEXT, voice: 'oliver', jobId: 'j', renderMs: 1, polls: 1 })

  beforeEach(() => clearVerdictCache())

  it('returns a stored render and nothing for an unknown key', () => {
    writeVerdictCache('key-a', entry(10))
    expect(readVerdictCache('key-a').bytes.byteLength).toBe(10)
    expect(readVerdictCache('key-b')).toBeNull()
    expect(verdictCacheStats()).toMatchObject({ entries: 1, bytes: 10 })
  })

  it('evicts the least recently READ once over the entry bound', () => {
    for (let i = 0; i < VERDICT_CACHE.maxEntries; i += 1) writeVerdictCache(`k${i}`, entry(1))
    // Touching k0 must save it; k1 becomes the oldest.
    readVerdictCache('k0')
    writeVerdictCache('extra', entry(1))
    expect(verdictCacheStats().entries).toBe(VERDICT_CACHE.maxEntries)
    expect(readVerdictCache('k0')).not.toBeNull()
    expect(readVerdictCache('k1')).toBeNull()
  })

  it('evicts on the byte bound too, so mp4s cannot leak memory', () => {
    writeVerdictCache('big-1', entry(VERDICT_CACHE.maxBytes - 1))
    writeVerdictCache('big-2', entry(VERDICT_CACHE.maxBytes - 1))
    expect(verdictCacheStats().entries).toBe(1)
    expect(verdictCacheStats().bytes).toBeLessThanOrEqual(VERDICT_CACHE.maxBytes)
    expect(readVerdictCache('big-1')).toBeNull()
  })

  it('does not double-count a key that is written twice', () => {
    writeVerdictCache('same', entry(100))
    writeVerdictCache('same', entry(40))
    expect(verdictCacheStats()).toMatchObject({ entries: 1, bytes: 40 })
  })
})

describe('one render at a time', () => {
  beforeEach(() => clearVerdictCache())

  it('joins a render already in flight for the SAME stat tuple', async () => {
    let started = 0
    const task = async () => {
      started += 1
      await new Promise((done) => setTimeout(done, 20))
      return 'bytes'
    }
    const [a, b] = await Promise.all([
      withVerdictSingleFlight('same', task),
      withVerdictSingleFlight('same', task),
    ])
    // React 19 StrictMode double-invokes effects, so the honest single intent
    // arrives as two POSTs; refusing the second would look like a conflict.
    expect(started).toBe(1)
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(true)
    expect(b.result).toBe('bytes')
  })

  it('refuses a DIFFERENT tuple instead of queueing it behind 12 seconds', async () => {
    const slow = withVerdictSingleFlight('first', async () => {
      await new Promise((done) => setTimeout(done, 30))
      return 'one'
    })
    const err = await withVerdictSingleFlight('second', async () => 'two').catch((e) => e)
    expect(err).toBeInstanceOf(VerdictBusyError)
    expect(err.info.key).toBe('first')
    expect(err.info.elapsedMs).toBeGreaterThanOrEqual(0)
    await expect(slow).resolves.toMatchObject({ result: 'one' })
  })

  it('names the job the caller is waiting behind', async () => {
    const slow = withVerdictSingleFlight('first', async ({ onJobId }) => {
      onJobId('job-42')
      await new Promise((done) => setTimeout(done, 30))
      return 'one'
    })
    await new Promise((done) => setTimeout(done, 5))
    const err = await withVerdictSingleFlight('other', async () => 'two').catch((e) => e)
    expect(err.info.jobId).toBe('job-42')
    await slow
  })

  it('releases the lock after a failure, so one bad render does not wedge the route', async () => {
    await expect(withVerdictSingleFlight('boom', async () => {
      throw new Error('upstream died')
    })).rejects.toThrow('upstream died')
    expect(verdictCacheStats().inFlightKey).toBeNull()
    await expect(withVerdictSingleFlight('next', async () => 'ok')).resolves.toMatchObject({ result: 'ok' })
  })
})
