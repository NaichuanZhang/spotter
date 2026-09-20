/**
 * ROOM TO SPEAK, MEASURED THROUGH THE REAL SESSION. The harness both arms of the comparison
 * run on, so the "before" number is a measurement and not an anecdote.
 *
 * ── WHY A HARNESS AND NOT A REDUCER TEST ────────────────────────────────────────────────
 * `speechPolicy.test.ts` pins the pure reducers, and every one of those cases can pass while
 * `session.ts` drops the returned state — a policy whose state is not threaded is exactly as
 * eager as no policy. So this drives the REAL `createCoachSession`: its real `pushEvent`, its
 * real `interrupt`, its real audio accounting, its real socket framing.
 *
 * ── THE FAKE AUDIO IS THE LOAD-BEARING PART ─────────────────────────────────────────────
 * The question the user actually asked is not "how often does the coach talk", it is "why can
 * I never get a word in". Those are the same question only because the mic gate is
 * `() => !audio.isSpeaking()` and `isSpeaking()` is literally `queuedSec() > 0`. So the
 * coach's audio has to be modelled as a DRAIN against the same clock the session runs on —
 * then the gate can be sampled exactly as `micUplink.gateOpen()` computes it, and "percent of
 * the set the mic was open" is a measurement rather than an inference from the utterance count.
 *
 * A second line pushed while the first is still playing QUEUES behind it, which is precisely
 * why the before-arm coach never stops: `audioUntil` extends from the LATER of "now" and the
 * existing drain time. Getting that one `Math.max` wrong is the difference between measuring
 * a backlog and pretending it cannot happen.
 *
 * ── WHAT `throttled: false` MEANS ───────────────────────────────────────────────────────
 * The BEFORE arm bypasses the policy and puts the event straight on the wire, which is what
 * the code did before `speechPolicy.ts` existed (`conn.pushEvent` per event, unconditionally).
 * It is reconstructed rather than checked out from git because the policy modules were never
 * committed in the eager state — and running both arms in ONE process against ONE harness is
 * what makes the two numbers comparable at all.
 */

import { createCoachSession } from '../session'
import type { AudioOut } from '../audioOut'
import type { CoachEvent, RepMetrics, Severity } from '../../types/events'
import { toEventLine } from '../../types/events'

/**
 * Seconds of audio one pushed line becomes. MEASURED against the live API, not guessed: six
 * real rep-callout lines (the exact strings `repCalloutLine` builds, digest clause and all)
 * pushed to `higgs-realtime` through the real `buildSessionPayload` with Mean's real prompt
 * and voice returned 4.89 / 5.75 / 6.39 / 5.14 / 5.46 / 5.68 s of PCM16 at 24 kHz — mean 5.55.
 *
 * Deliberately the UNTRIMMED duration. The repo's earlier 2.26-4.62 s figures are trimmed, and
 * trimming is the wrong measure for a gate question: `isSpeaking()` is `queuedSec() > 0`, so an
 * utterance's padding silence holds the mic shut exactly as its speech does.
 *
 * Used for BOTH arms, so neither can be flattered by the choice.
 */
export const UTTERANCE_SEC = 5.55

/** Realistic pushup cadence, and the spacing the user's complaint describes. */
export const REP_INTERVAL_MS = 2500
export const SET_REPS = 20

/** Sampling interval for the gate integration. Fine enough to resolve a 250 ms window. */
const STEP_MS = 50

export interface SpeechBudget {
  /** Lines that reached the wire as a synthetic user turn, i.e. things the coach SAYS. */
  readonly utterances: number
  /**
   * Length of the EXERCISING WINDOW — first event to last event — and the denominator for
   * every percentage here.
   *
   * It deliberately excludes the lead-in before the first rep. That silence is real but it is
   * not room to speak DURING a set, and counting it flatters the before arm with the only
   * open-mic time it has: measured, the pre-rep gap was the whole of its "5% open".
   */
  readonly setMs: number
  /** Including the drain, so an arm that overruns its own set is visible rather than hidden. */
  readonly totalMs: number
  /** Milliseconds WITHIN the set the coach had audio queued, i.e. the mic gate was SHUT. */
  readonly speakingInSetMs: number
  /** Milliseconds within the set the mic gate was OPEN. The user's actual room to speak. */
  readonly openInSetMs: number
  /** The single longest uninterrupted open-mic window inside the set. */
  readonly longestOpenMs: number
  /** Total speaking across the whole timeline, drain included. */
  readonly speakingTotalMs: number
}

export function utterancesPerMin(budget: SpeechBudget): number {
  return (budget.utterances / budget.setMs) * 60_000
}

export function pctSpeaking(budget: SpeechBudget): number {
  return (budget.speakingInSetMs / budget.setMs) * 100
}

export function pctOpen(budget: SpeechBudget): number {
  return (budget.openInSetMs / budget.setMs) * 100
}

export function overrunMs(budget: SpeechBudget): number {
  return budget.totalMs - budget.setMs
}

// ------------------------------------------------------------------------------- the fakes

/** Exported so the interaction tests drive the same socket rather than a third copy of one. */
export class FakeSocket {
  static readonly OPEN = 1
  readyState = FakeSocket.OPEN
  readonly sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

export const tokenFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ value: 'bai-eph-test' }),
  } as Response)

export const flush = (): Promise<unknown> => new Promise((done) => setTimeout(done, 0))

/** The BEFORE arm: straight onto the wire, no policy, which is what the code used to do. */
function pushRaw(socket: FakeSocket, event: CoachEvent): void {
  socket.send(JSON.stringify({ type: 'conversation.item.create', line: toEventLine(event) }))
  socket.send(JSON.stringify({ type: 'response.create' }))
}

export interface ReplayOptions {
  /** Pushed in ascending `at` order. Several may share a timestamp — that is a real case. */
  readonly events: readonly CoachEvent[]
  /** End of the exercising window. Defaults to the last event's timestamp. */
  readonly endMs?: number
  /** False bypasses the policy entirely: the BEFORE arm. */
  readonly throttled: boolean
}

export interface ReplayResult extends SpeechBudget {
  /** Every line the policy let through, in order, for reading as a transcript. */
  readonly lines: string[]
}

/**
 * Replays an event stream through the real session and measures the gate.
 *
 * The clock is injected and stepped by hand, so the whole measurement is deterministic and a
 * 50-second set costs milliseconds. `micEnabled: false` because the uplink needs
 * `getUserMedia`; the gate it WOULD compute is reproduced here from `isSpeaking()`, which is
 * the only input `gateOpen()` has when nobody is barging in.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const ordered = [...options.events].sort((a, b) => a.at - b.at)
  const first = ordered.length > 0 ? ordered[0]!.at : 0
  const last = options.endMs ?? (ordered.length > 0 ? ordered[ordered.length - 1]!.at : 0)

  let clock = 0
  /** When the coach's queued audio will have drained, on the injected clock. */
  let audioUntil = 0
  const queuedSec = () => Math.max(0, audioUntil - clock) / 1000

  let speakingInSetMs = 0
  let speakingTotalMs = 0
  let openInSetMs = 0
  let longestOpenMs = 0
  let openRunMs = 0

  /** One sample of the gate, exactly as `micUplink.gateOpen()` would read it. */
  function sample(atMs: number, forMs: number): void {
    const shut = queuedSec() > 0
    if (shut) speakingTotalMs += forMs
    // Only the exercising window counts toward the percentages — see `SpeechBudget.setMs`.
    if (atMs <= first || atMs > last) return
    if (shut) {
      speakingInSetMs += forMs
      openRunMs = 0
      return
    }
    openInSetMs += forMs
    openRunMs += forMs
    longestOpenMs = Math.max(longestOpenMs, openRunMs)
  }

  /**
   * Steps the clock in STEP_MS slices, sampling the gate on each. The slice is CLAMPED to the
   * target and the sample is credited with the clamped width, not a full step — crediting a
   * short final slice with 50 ms is how an early draft reported "100.8 % speaking", which is
   * not a rounding error so much as a measurement that cannot be trusted at the edges.
   */
  function advanceTo(target: number): void {
    while (clock < target) {
      const next = Math.min(target, clock + STEP_MS)
      const dt = next - clock
      clock = next
      sample(clock, dt)
    }
  }

  const audio: AudioOut = {
    unlock: () => Promise.resolve(),
    unlocked: () => true,
    enqueue: () => {},
    stop: () => {
      audioUntil = clock
    },
    isSpeaking: () => queuedSec() > 0,
    level: () => 0,
    queuedSec,
    setEmphasis: () => {},
    close: () => Promise.resolve(),
  }

  const sockets: FakeSocket[] = []
  const session = createCoachSession({
    persona: 'mean',
    now: () => clock,
    micEnabled: false,
    audio,
    socket: {
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.onopen?.())
        return socket as unknown as WebSocket
      },
      fetchImpl: tokenFetch,
    },
  })

  const connecting = session.connect()
  await flush()
  const socket = sockets[0]!
  socket.emit({ type: 'session.created' })
  await connecting

  /** The text of every line that reached the wire, in order — the transcript to read. */
  const lines: string[] = []
  let seen = socket.sent.length

  /**
   * Everything that reached the wire since the last check becomes audio, as the server would
   * answer it. `response.create` is THE utterance marker: it is what asks for a spoken reply,
   * and the two frames that deliberately do not carry one (the keepalive and the reconnect
   * reseed, both `respond: false`) must not be counted as the coach talking.
   */
  function answerWhateverWasPushed(): void {
    const fresh = socket.sent.slice(seen)
    seen = socket.sent.length
    for (const frame of fresh) {
      if (frame.type === 'conversation.item.create') {
        const text = lineTextOf(frame)
        if (text !== null) lines.push(text)
        continue
      }
      if (frame.type !== 'response.create') continue
      // Queued BEHIND the current utterance, not on top of it. This `Math.max` is the whole
      // mechanism by which the before arm's coach never stops talking.
      audioUntil = Math.max(audioUntil, clock) + UTTERANCE_SEC * 1000
      // The server's own boundaries. `output_audio.done` is where the listen window anchors:
      // at that moment every sample is scheduled and `queuedSec()` is exactly what is left.
      socket.emit({ type: 'response.output_audio.done' })
      socket.emit({ type: 'response.done' })
      seen = socket.sent.length
    }
  }

  for (const event of ordered) {
    advanceTo(event.at)
    if (options.throttled) session.pushEvent(event)
    else pushRaw(socket, event)
    answerWhateverWasPushed()
  }

  // Let the last utterance drain, so an arm that overruns its own set is counted for it.
  advanceTo(Math.max(clock, audioUntil))
  session.disconnect()

  return {
    utterances: lines.length,
    lines,
    setMs: Math.max(0, last - first),
    // Measured from the same origin as `setMs`, so `overrunMs` is "how long after the last rep
    // was the coach still talking" and nothing else.
    totalMs: Math.max(0, clock - first),
    speakingInSetMs,
    openInSetMs,
    longestOpenMs,
    speakingTotalMs,
  }
}

/** The pushed text, from either arm's framing. Null for a frame that is not a user item. */
function lineTextOf(frame: Record<string, unknown>): string | null {
  const raw = frame.line
  if (typeof raw === 'string') return raw
  const item = frame.item as { content?: { text?: unknown }[] } | undefined
  const text = item?.content?.[0]?.text
  return typeof text === 'string' ? text : null
}

// -------------------------------------------------------------------------- event builders

export function rep(over: Partial<RepMetrics> = {}): RepMetrics {
  return {
    index: 1,
    minElbowAngle: 72,
    maxElbowAngle: 168,
    depthPct: 92,
    hipDeviationDeg: 3,
    descentMs: 900,
    ascentMs: 700,
    partial: false,
    clean: true,
    ...over,
  }
}

export function repEvent(n: number, at: number, over: Partial<RepMetrics> = {}): CoachEvent {
  return { kind: 'rep_completed', at, rep: rep({ index: n, ...over }), totalReps: n, cleanReps: n }
}

export function faultEvent(severity: Severity, at: number): CoachEvent {
  return { kind: 'form_fault', at, fault: 'sagging_hips', severity, valueDeg: 26, heldFrames: 8 }
}

/** A 20-rep set at the cadence the complaint describes, plus anything extra per rep. */
export function simulatedSet(
  reps = SET_REPS,
  extra?: (n: number, at: number) => CoachEvent | null,
): CoachEvent[] {
  const out: CoachEvent[] = []
  for (let n = 1; n <= reps; n += 1) {
    const at = n * REP_INTERVAL_MS
    out.push(repEvent(n, at))
    const more = extra?.(n, at) ?? null
    if (more !== null) out.push(more)
  }
  return out
}

/**
 * A WHOLE set with its lifecycle: the `set_started` that declares the target, every rep, and
 * the `set_ended` wrap-up.
 *
 * The target is what makes this different from `simulatedSet`, and it is the harder case for
 * the policy — `final_stretch` and `target_reached` both become reachable, so the end of the
 * set has three callouts competing where the middle had none. It is also the only shape in
 * which the coach's rep ARITHMETIC can be checked: it has to still be counting to the right
 * number on rep 20 having said nothing about reps 2 through 4.
 */
export function fullSet(target = SET_REPS): CoachEvent[] {
  const reps = simulatedSet(target)
  const lastAt = target * REP_INTERVAL_MS
  return [
    { kind: 'set_started', at: 0, target },
    ...reps,
    { kind: 'set_ended', at: lastAt + 500, totalReps: target, cleanReps: target, faults: [] },
  ]
}
