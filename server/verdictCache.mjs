/**
 * ONE render at a time, and never the same render twice.
 *
 * Two independent constraints, both measured, both cheap to get wrong:
 *
 *   CONCURRENCY. Concurrent POSTs to /v1/videos come back 429. So this process
 *   admits exactly one render at a time. A second request for a DIFFERENT stat
 *   tuple is told so immediately (VerdictBusyError -> 409) rather than queued:
 *   the caller is a user lying on the floor watching a screen, and "waiting 24
 *   seconds behind someone else's render" is a worse answer than "busy, the
 *   screen you are looking at is already complete".
 *
 *   IDENTITY. A second request for the SAME tuple joins the in-flight render
 *   instead of being refused. That is not a micro-optimisation: React 19 in
 *   StrictMode double-invokes effects, so the honest single "render my verdict"
 *   intent arrives as two POSTs microseconds apart, and refusing the second
 *   would make the common case look like a conflict.
 *
 * CACHE IS IN MEMORY AND A RESTART CLEARS IT. That is the accepted trade: the
 * demo set gets run over and over, and paying ~27 s plus credits for the same
 * six numbers every time is the thing to avoid; surviving a redeploy is not.
 * Bounded by BOTH entry count and total bytes, because an unbounded Map of mp4s
 * is a slow memory leak on a small container.
 */

export const VERDICT_CACHE = Object.freeze({
  maxEntries: 24,
  /**
   * MEASURED, not estimated: a 245-261 character verdict renders to 890 KB -
   * 1.11 MB (18-22 s of 640x640 h264 + 24 kHz aac). So the BYTE bound bites
   * first, at ~11 entries, and maxEntries is the backstop for a future shorter
   * clip rather than the live limit. Both bounds stay: one of them is always
   * the wrong one to trust alone.
   */
  maxBytes: 12 * 1024 * 1024,
})

/** Insertion-ordered = recency-ordered, because a hit re-inserts. */
const entries = new Map()
let cachedBytes = 0

/** The single in-flight render, or null. */
let inFlight = null

export class VerdictBusyError extends Error {
  constructor(info) {
    super(`a verdict render is already in flight (${info.elapsedMs} ms so far)`)
    this.name = 'VerdictBusyError'
    this.info = info
  }
}

/** Cache hit, or null. Re-inserts so the hottest tuple is evicted last. */
export function readVerdictCache(key) {
  const hit = entries.get(key)
  if (!hit) return null
  entries.delete(key)
  entries.set(key, hit)
  return hit
}

export function writeVerdictCache(key, entry) {
  if (entries.has(key)) cachedBytes -= entries.get(key).bytes.byteLength
  entries.set(key, entry)
  cachedBytes += entry.bytes.byteLength
  evictWhileOverBudget()
  return entry
}

function evictWhileOverBudget() {
  while (entries.size > VERDICT_CACHE.maxEntries || cachedBytes > VERDICT_CACHE.maxBytes) {
    const oldest = entries.keys().next()
    if (oldest.done) return
    cachedBytes -= entries.get(oldest.value).bytes.byteLength
    entries.delete(oldest.value)
  }
}

export function verdictCacheStats() {
  return { entries: entries.size, bytes: cachedBytes, inFlightKey: inFlight?.key ?? null }
}

/** Test/ops hook. Not reachable from any route — nothing clears a cache by HTTP. */
export function clearVerdictCache() {
  entries.clear()
  cachedBytes = 0
}

/**
 * Run `task` under the one-at-a-time rule.
 *
 * `task` receives `{ onJobId }` so the upstream job id can be attached to the
 * in-flight record the moment it exists — that is what lets a 409 name the job
 * the caller is waiting behind instead of saying "busy" and nothing else.
 *
 * Resolves `{ result, shared }`; throws VerdictBusyError when a DIFFERENT key
 * is already rendering.
 */
export async function withVerdictSingleFlight(key, task) {
  if (inFlight) {
    if (inFlight.key !== key) throw new VerdictBusyError(describeInFlight())
    return { result: await inFlight.promise, shared: true }
  }

  const record = { key, startedAt: Date.now(), jobId: null, promise: null }
  record.promise = task({ onJobId: (jobId) => { record.jobId = jobId } })
  inFlight = record
  try {
    return { result: await record.promise, shared: false }
  } finally {
    // Only clear if we are still the current holder. A `finally` that clears
    // unconditionally would wipe a successor's record if these ever interleave.
    if (inFlight === record) inFlight = null
  }
}

function describeInFlight() {
  return {
    key: inFlight.key,
    jobId: inFlight.jobId,
    elapsedMs: Date.now() - inFlight.startedAt,
  }
}
