/**
 * PLUMBING for the personalised avatar verdict. verdictText.mjs holds the words;
 * this file holds the API calls, the polling, and the failure taxonomy.
 *
 * THE SHAPE OF THE UPSTREAM, measured on this key (2026-09-18), not guessed:
 *   POST /v1/videos            -> { id, status: 'queued' }      ~12 s to finish
 *   GET  /v1/videos/{id}       -> { status }                     poll every 2 s
 *   GET  /v1/videos/{id}/content -> the mp4; a 404 here means NOT FINISHED YET,
 *                                 which is why 404 is a retry and not an error.
 * Driving audio is capped at 60 s upstream and SETS the output length, so the
 * text this renders is capped hard in verdictText.mjs rather than here.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO HANDLE: a bad voice fails
 * ASYNCHRONOUSLY. The POST returns 200 with a job id and only ~12 s later does
 * the job report `status: 'failed'` with "tts stream failed: 400 Unknown voice".
 * A naive client waits out the whole cycle and then shows nothing. So a failure
 * whose text names a voice retries ONCE on the persona's collision-free
 * fallbackVoice, and only if there is still budget for a second render inside
 * the overall deadline — a retry that cannot finish is worse than a fast error.
 *
 * EVERY failure leaves as a VerdictRenderError carrying an `httpStatus` and a
 * stable `code`, because the caller is an HTTP route whose client has to show a
 * human something specific. Nothing here logs, and nothing here swallows.
 */

import { setTimeout as sleep } from 'node:timers/promises'

export const VERDICT_API = Object.freeze({
  base: 'https://api.boson.ai/v1',
  /** Absent from /v1/models, yet /v1/videos works. Do not gate on a model list. */
  avatarModel: 'higgs-avatar',
  /** NOT 'higgs-tts-3', which some docs claim; that id 404s on this key. */
  ttsModel: 'higgs-tts-v3',
  size: '640x640',
  pollIntervalMs: 2_000,
  /** Per HTTP call. The mp4 is ~300-500 KB, so this is generous for all four calls. */
  requestTimeoutMs: 30_000,
  /**
   * Whole-route budget, both attempts included.
   *
   * MEASURED on this key, for the ~250-260 character lines this route actually
   * sends: 22.5 / 26.7 / 30.7 s wall clock. That is NOT the 12 s the repo
   * measured for the short baked intros — render time tracks the DRIVING AUDIO
   * (18.0 / 21.8 s of video here), so the verdict costs roughly
   * `audio duration + 9 s`. 90 s is ~3x the worst observed, and deliberately
   * not the 180 s the build-time bake script allows: a human is lying on the
   * floor watching a screen, and the single-flight lock is held this whole time.
   */
  overallTimeoutMs: 90_000,
  /**
   * Refuse a fallback-voice retry with less than one render's worth of budget
   * left. Sized above the 30.7 s worst case so a granted retry can actually
   * finish — a retry that is admitted and then times out spends ~30 s of the
   * user's rest period to arrive at the same error.
   */
  minMsForVoiceRetry: 40_000,
  /** Gap between /content 404s while the job finalises. */
  contentRetryMs: 1_500,
  maxContentAttempts: 8,
  /** Upstream error text is forwarded — it says useful things like insufficient_quota. */
  errorDetailChars: 400,
})

const DONE_STATUSES = new Set(['completed', 'succeeded', 'success'])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'expired'])

export class VerdictRenderError extends Error {
  constructor({ code, httpStatus, message, detail = null, jobId = null, voiceFailure = false }) {
    super(message)
    this.name = 'VerdictRenderError'
    this.code = code
    this.httpStatus = httpStatus
    this.detail = detail
    this.jobId = jobId
    /** True when the upstream text blames the VOICE — the one retryable case. */
    this.voiceFailure = voiceFailure
    /** Filled in by renderVerdictVideo so a caller can report what was tried. */
    this.attempts = []
  }
}

const clip = (text, max) => String(text ?? '').slice(0, max)

/**
 * Does this upstream text blame the voice? Matched on text because the async
 * failure arrives as a status string, not a typed error code.
 */
export function looksLikeVoiceFailure(text) {
  return /voice/i.test(text) && /(invalid|unknown|not\s+found|unsupported)/i.test(text)
}

function parseJsonOr(raw, code, message, max) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new VerdictRenderError({ code, httpStatus: 502, message, detail: clip(raw, max) })
  }
}

async function apiFetch({ apiKey, path, init = {}, fetchImpl, timeoutMs }) {
  try {
    return await fetchImpl(`${VERDICT_API.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new VerdictRenderError({
      code: timedOut ? 'render_timeout' : 'render_unreachable',
      httpStatus: timedOut ? 504 : 502,
      message: `${init.method ?? 'GET'} ${path}: ${err?.name ?? 'Error'}: ${err?.message ?? err}`,
    })
  }
}

// ---------------------------------------------------------------- the three calls

async function startRender({ apiKey, persona, voice, text, fetchImpl, T }) {
  const response = await apiFetch({
    apiKey,
    path: '/videos',
    fetchImpl,
    timeoutMs: T.requestTimeoutMs,
    init: {
      method: 'POST',
      body: JSON.stringify({
        model: T.avatarModel,
        ref_image: persona.refImage,
        size: T.size,
        // The TTS tag is parsed and CONSUMED on this path (never read aloud);
        // it does nothing on Realtime, which is why it is added here and not
        // baked into the verdict text itself.
        input_tts: { model: T.ttsModel, input: `${persona.ttsTag}${text}`, voice },
      }),
    },
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new VerdictRenderError({
      code: response.status === 429 ? 'render_rate_limited' : 'render_start_failed',
      httpStatus: response.status === 429 ? 429 : 502,
      message: `POST /videos -> HTTP ${response.status}`,
      detail: clip(raw, T.errorDetailChars),
      voiceFailure: looksLikeVoiceFailure(raw),
    })
  }

  const body = parseJsonOr(raw, 'render_start_failed', 'POST /videos returned non-JSON', T.errorDetailChars)
  if (!body?.id) {
    throw new VerdictRenderError({
      code: 'render_start_failed',
      httpStatus: 502,
      message: 'POST /videos returned no job id',
      detail: clip(raw, T.errorDetailChars),
    })
  }
  return String(body.id)
}

async function pollUntilComplete({ apiKey, jobId, deadlineAt, fetchImpl, T }) {
  const statuses = []
  while (Date.now() < deadlineAt) {
    await sleep(T.pollIntervalMs)
    const response = await apiFetch({
      apiKey,
      path: `/videos/${encodeURIComponent(jobId)}`,
      fetchImpl,
      timeoutMs: T.requestTimeoutMs,
    })
    const raw = await response.text()
    if (!response.ok) {
      // A 404 on the JOB is a real error, unlike a 404 on /content.
      throw new VerdictRenderError({
        code: 'render_poll_failed',
        httpStatus: 502,
        message: `GET /videos/${jobId} -> HTTP ${response.status}`,
        detail: clip(raw, T.errorDetailChars),
        jobId,
      })
    }
    const body = parseJsonOr(raw, 'render_poll_failed', `GET /videos/${jobId} returned non-JSON`, T.errorDetailChars)
    const status = String(body?.status ?? 'unknown').toLowerCase()
    statuses.push(status)
    if (DONE_STATUSES.has(status)) return { statuses }
    if (FAILED_STATUSES.has(status)) {
      throw new VerdictRenderError({
        code: 'render_failed',
        httpStatus: 502,
        message: `render ${status}`,
        detail: clip(raw, T.errorDetailChars),
        jobId,
        voiceFailure: looksLikeVoiceFailure(raw),
      })
    }
  }
  throw new VerdictRenderError({
    code: 'render_timeout',
    httpStatus: 504,
    message: `render did not finish inside ${Math.round(T.overallTimeoutMs / 1000)}s`,
    jobId,
    detail: `statuses seen: ${statuses.join(' -> ') || 'none'}`,
  })
}

/** A 404 on /content means not-finished-yet, not missing. Retry until it lands. */
async function downloadContent({ apiKey, jobId, deadlineAt, fetchImpl, T }) {
  let notReady = 0
  while (Date.now() < deadlineAt && notReady < T.maxContentAttempts) {
    const response = await apiFetch({
      apiKey,
      path: `/videos/${encodeURIComponent(jobId)}/content`,
      fetchImpl,
      timeoutMs: T.requestTimeoutMs,
    })
    if (response.status === 404) {
      notReady += 1
      await sleep(T.contentRetryMs)
      continue
    }
    if (!response.ok) {
      const raw = await response.text()
      throw new VerdictRenderError({
        code: 'render_content_failed',
        httpStatus: 502,
        message: `GET /videos/${jobId}/content -> HTTP ${response.status}`,
        detail: clip(raw, T.errorDetailChars),
        jobId,
      })
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) {
      throw new VerdictRenderError({
        code: 'render_empty',
        httpStatus: 502,
        message: `GET /videos/${jobId}/content returned 0 bytes`,
        jobId,
      })
    }
    return { bytes, contentType: response.headers.get('content-type') || 'video/mp4', notReady }
  }
  throw new VerdictRenderError({
    code: 'render_timeout',
    httpStatus: 504,
    message: `content never became available for ${jobId} (${notReady} x 404)`,
    jobId,
  })
}

// ---------------------------------------------------------------- one attempt

async function renderOnce({ apiKey, persona, voice, text, onJobId, fetchImpl, T, deadlineAt }) {
  const jobId = await startRender({ apiKey, persona, voice, text, fetchImpl, T })
  onJobId(jobId)
  const { statuses } = await pollUntilComplete({ apiKey, jobId, deadlineAt, fetchImpl, T })
  const content = await downloadContent({ apiKey, jobId, deadlineAt, fetchImpl, T })
  return { jobId, statuses, contentNotReady: content.notReady, bytes: content.bytes, contentType: content.contentType }
}

/**
 * Render the verdict video. Resolves `{ bytes, contentType, jobId, voice,
 * statuses, attempts, elapsedMs }`; throws VerdictRenderError with an
 * `httpStatus` the route can use directly.
 *
 * `timings` overrides VERDICT_API field-by-field. It exists so the poll,
 * fallback and timeout branches are testable against a fake fetch in
 * milliseconds — those are exactly the branches a live render cannot exercise
 * without deliberately burning ~12 s and credits on a known-bad voice.
 */
export async function renderVerdictVideo({
  apiKey,
  persona,
  text,
  onJobId = () => {},
  fetchImpl = fetch,
  timings = {},
}) {
  const T = { ...VERDICT_API, ...timings }
  const startedAt = Date.now()
  const deadlineAt = startedAt + T.overallTimeoutMs
  const voices = [persona.voice, persona.fallbackVoice]
  const attempts = []
  let lastError = null

  for (const [index, voice] of voices.entries()) {
    const remainingMs = deadlineAt - Date.now()
    if (index > 0 && remainingMs < T.minMsForVoiceRetry) {
      lastError.detail = `${lastError.detail ?? ''} (no budget for a ${voice} retry: ${remainingMs} ms left)`
      break
    }
    try {
      const outcome = await renderOnce({ apiKey, persona, voice, text, onJobId, fetchImpl, T, deadlineAt })
      attempts.push({ voice, jobId: outcome.jobId, ok: true, polls: outcome.statuses.length })
      return { ...outcome, voice, attempts, elapsedMs: Date.now() - startedAt }
    } catch (err) {
      if (!(err instanceof VerdictRenderError)) throw err
      attempts.push({ voice, jobId: err.jobId, ok: false, code: err.code, voiceFailure: err.voiceFailure })
      lastError = err
      if (!err.voiceFailure || index === voices.length - 1) break
    }
  }

  lastError.attempts = attempts
  lastError.elapsedMs = Date.now() - startedAt
  throw lastError
}
