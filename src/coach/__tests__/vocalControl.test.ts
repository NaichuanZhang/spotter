/**
 * The vocal-control levers that are UNDOCUMENTED and therefore have no schema,
 * no error and no server-side validation to catch a mistake.
 *
 * Two of these assertions are guarding against a silent, unrecoverable failure
 * rather than a crash:
 *   - `speed` outside [0.25, 4.0] passes validation, echoes back in
 *     session.updated, and then the session WEDGES — no audio delta, no error, no
 *     close (confirmed at 0.1/0.2/0/-1/5/6/8/100; one wait ran 260s). The clamp is
 *     the only place this can be stopped.
 *   - a speed patch that carries `voice` triggers a rate-limited server-side
 *     voices lookup that answers 429 and TERMINATES the session (~1 in 7). In the
 *     hot path that is a demo-ender, so "no voice key" is a hard contract.
 *
 * `temperature: 0.3` is pinned because it is a measurement precondition: every
 * acoustic number personas.ts is tuned to was taken at 0.3, and at 0.8 the model
 * overruns the word cap (13-21 words observed), which is what the orthography
 * result was measured against.
 */
import { describe, expect, it } from 'vitest'
import { buildSessionPayload, buildSpeedPatch, clampSpeed, HIGGS } from '../higgsSocket'
import {
  createCoachSession,
  isSevere,
  isVoiceRateLimit,
  PER_EVENT_PACE_ENABLED,
  URGENCY_SPEED,
  urgencyFor,
} from '../session'
import { CoachError } from '../higgsSocket'
import { PERSONAS } from '../personas'
import type { CoachEvent, RepMetrics, Severity } from '../../types/events'

const CLEAN_REP: RepMetrics = {
  index: 1,
  minElbowAngle: 72,
  maxElbowAngle: 168,
  depthPct: 92,
  hipDeviationDeg: 3,
  descentMs: 900,
  ascentMs: 700,
  partial: false,
  clean: true,
}

const repEvent: CoachEvent = {
  kind: 'rep_completed',
  at: 0,
  rep: CLEAN_REP,
  totalReps: 1,
  cleanReps: 1,
}

function faultEvent(severity: Severity): CoachEvent {
  return { kind: 'form_fault', at: 0, fault: 'sagging_hips', severity, valueDeg: 26, heldFrames: 8 }
}

const severeEvent = faultEvent('severe')

type AudioOutput = { voice?: string; speed?: number; temperature?: number }

function audioOutput(payload: Record<string, unknown>): AudioOutput {
  const session = payload.session as { audio?: { output?: AudioOutput } }
  return session.audio?.output ?? {}
}

describe('clampSpeed', () => {
  it('passes the shipped persona speeds through untouched', () => {
    for (const persona of Object.values(PERSONAS)) {
      expect(clampSpeed(persona.speed)).toBe(persona.speed)
    }
  })

  it('pulls anything past the demo ceiling back to it', () => {
    for (const value of [1.26, 2, 4, 100, Number.MAX_VALUE]) {
      expect(clampSpeed(value)).toBe(HIGGS.speedSafeMax)
    }
  })

  it('pulls anything under the hard floor up to it', () => {
    // These are the exact values that wedged a live session.
    for (const value of [0.2, 0.1, 0, -1]) {
      expect(clampSpeed(value)).toBe(HIGGS.speedMin)
    }
  })

  it('falls back to unity for anything that is not a usable number', () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampSpeed(value as number | undefined)).toBe(HIGGS.speedDefault)
    }
  })
})

describe('buildSessionPayload', () => {
  const payload = buildSessionPayload({ instructions: 'x', voice: 'jake', speed: 1.12 })

  it('carries the voice and the pace', () => {
    expect(audioOutput(payload)).toMatchObject({ voice: 'jake', speed: 1.12 })
  })

  /**
   * audio.output.temperature must NOT be on the wire. Greedy audio decoding
   * degenerates: 5 of 18 live turns (3 personas x 6 varied [EVENT] lines) came back
   * with 72-142 seconds of PCM for a 2-4 second line — one of them 75 seconds of
   * loud babble rather than silence. The same 18 turns with the field omitted: 0.
   * audioOut drops every chunk past maxQueuedSec, so a runaway costs the line its
   * tail and pins the UI at "speaking". This asserts absence, not a value, because
   * the fix is omission — the server's own default is undocumented too.
   */
  it('omits the undocumented audio.output.temperature entirely', () => {
    expect(audioOutput(payload)).not.toHaveProperty('temperature')
    expect(Object.keys(audioOutput(payload)).sort()).toEqual(['format', 'speed', 'voice'])
    expect(HIGGS.useOutputTemperature).toBe(false)
  })

  it('pins the top-level temperature every measurement was taken at', () => {
    const session = payload.session as { temperature?: number }
    expect(session.temperature).toBe(0.3)
    expect(HIGGS.temperature).toBe(0.3)
  })

  it('clamps an out-of-range speed rather than forwarding it', () => {
    const wedging = buildSessionPayload({ instructions: 'x', voice: 'jake', speed: 0 })
    expect(audioOutput(wedging).speed).toBe(HIGGS.speedMin)
  })

  it('still sends a speed when the caller omits one', () => {
    const bare = buildSessionPayload({ instructions: 'x', voice: 'jake' })
    expect(audioOutput(bare).speed).toBe(HIGGS.speedDefault)
  })
})

describe('buildSpeedPatch', () => {
  it('sends a speed and nothing else — above all, no voice', () => {
    const patch = buildSpeedPatch(1.25)
    expect(patch.type).toBe('session.update')
    expect(audioOutput(patch)).toEqual({ speed: 1.25 })
    expect(JSON.stringify(patch)).not.toContain('voice')
  })

  it('clamps, because the hot path is where a wedge is least recoverable', () => {
    expect(audioOutput(buildSpeedPatch(99)).speed).toBe(HIGGS.speedSafeMax)
  })
})

describe('urgencyFor', () => {
  it('leaves a clean rep at the persona base, so no patch is sent at all', () => {
    const base = PERSONAS.mean.speed
    expect(urgencyFor(repEvent, base)).toBe(base)
    expect(URGENCY_SPEED.minor).toBe(1)
  })

  it('scales a fault by its severity, strictly monotonically', () => {
    const base = PERSONAS.mean.speed
    const minor = urgencyFor(faultEvent('minor'), base)
    const major = urgencyFor(faultEvent('major'), base)
    const severe = urgencyFor(faultEvent('severe'), base)
    expect(minor).toBe(base)
    expect(major).toBeGreaterThan(minor)
    expect(severe).toBeGreaterThan(major)
  })

  it('stays inside the clamp for every persona at every severity', () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const severity of ['minor', 'major', 'severe'] as const) {
        const target = clampSpeed(urgencyFor(faultEvent(severity), persona.speed))
        expect(target).toBeLessThanOrEqual(HIGGS.speedSafeMax)
        expect(target).toBeGreaterThanOrEqual(persona.speed)
      }
    }
  })

  it('reserves client-side emphasis gain for severe faults only', () => {
    expect(isSevere(faultEvent('severe'))).toBe(true)
    expect(isSevere(faultEvent('major'))).toBe(false)
    expect(isSevere(repEvent)).toBe(false)
  })
})

describe('isVoiceRateLimit', () => {
  it('recognises the server wording that must NOT cost a persona its voice', () => {
    expect(
      isVoiceRateLimit(
        new CoachError(
          'server_error',
          "Could not validate voice 'oliver': voices API returned HTTP 429",
        ),
      ),
    ).toBe(true)
  })

  it('does not swallow a genuinely missing voice', () => {
    expect(isVoiceRateLimit(new CoachError('server_error', "Invalid voice 'x': not found"))).toBe(
      false,
    )
  })

  it('ignores a 429 that has nothing to do with a voice', () => {
    expect(isVoiceRateLimit(new CoachError('server_error', 'HTTP 429 too many requests'))).toBe(
      false,
    )
    expect(isVoiceRateLimit(new CoachError('rate_limited', "voice 'x' rate limited 429"))).toBe(
      false,
    )
  })
})

// ------------------------------------------------- the frames actually sent

class FakeSocket {
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

  close(code = 1000, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean: true })
  }

  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  speedPatches(): number[] {
    return this.sent
      .filter((frame) => frame.type === 'session.update')
      .map((frame) => audioOutput(frame))
      .filter((output): output is AudioOutput & { speed: number } => output.voice === undefined)
      .map((output) => output.speed)
  }
}

const tokenFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ value: 'bai-eph-test' }),
  } as Response)

const flush = () => new Promise((done) => setTimeout(done, 0))

async function liveSession(persona: 'mean' | 'nice' | 'sarcastic') {
  const sockets: FakeSocket[] = []
  const createSocket = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    queueMicrotask(() => socket.onopen?.())
    return socket as unknown as WebSocket
  }
  const emphasis: boolean[] = []
  const session = createCoachSession({
    persona,
    // A real AudioOut needs Web Audio, which this environment does not have.
    audio: {
      unlock: () => Promise.resolve(),
      unlocked: () => true,
      enqueue: () => {},
      stop: () => {},
      isSpeaking: () => false,
      level: () => 0,
      queuedSec: () => 0,
      setEmphasis: (hot) => emphasis.push(hot),
      close: () => Promise.resolve(),
    },
    socket: { createSocket, fetchImpl: tokenFetch },
  })
  const connecting = session.connect()
  await flush()
  sockets[0].emit({ type: 'session.created' })
  await connecting
  return { session, socket: sockets[0], emphasis }
}

describe('per-event pace patching is OFF, and must stay off by accident-proof means', () => {
  it('is disabled, because the premise it rested on was falsified live', () => {
    // A speed-only patch does NOT skip the server's voices lookup: 8 of 20 patches
    // at a 300 ms gap and 1 of 20 at 2500 ms came back "Could not validate voice
    // 'jake': voices API returned HTTP 429" — for a frame carrying no voice.
    expect(PER_EVENT_PACE_ENABLED).toBe(false)
  })

  it('puts no session.update on the wire for any event, at any severity', async () => {
    const { session, socket } = await liveSession('mean')
    const before = socket.sent.length
    session.pushEvent(repEvent)
    session.pushEvent(faultEvent('minor'))
    session.pushEvent(faultEvent('major'))
    session.pushEvent(severeEvent)
    const types = socket.sent.slice(before).map((frame) => frame.type)
    // Four events, two frames each, and not one session.update among them. This is
    // the regression guard: a stray patch per event is a CoachError every ~20 reps.
    expect(types).toEqual(Array(4).fill(['conversation.item.create', 'response.create']).flat())
    expect(socket.speedPatches()).toEqual([])
    session.disconnect()
  })

  it('still differentiates the personas by base pace in the opening payload', async () => {
    for (const id of ['mean', 'nice', 'sarcastic'] as const) {
      const { session, socket } = await liveSession(id)
      expect(audioOutput(socket.sent[0]).speed).toBe(PERSONAS[id].speed)
      session.disconnect()
    }
  })

  it('turns client emphasis on for a severe fault and off when the turn ends', async () => {
    const { session, socket, emphasis } = await liveSession('mean')
    session.pushEvent(severeEvent)
    expect(emphasis.at(-1)).toBe(true)
    socket.emit({ type: 'response.done' })
    expect(emphasis.at(-1)).toBe(false)
    session.pushEvent(faultEvent('major'))
    expect(emphasis.at(-1)).toBe(false)
    session.disconnect()
  })

  it('carries the new persona’s speed in the swap payload, with no follow-up patch', async () => {
    const { session, socket } = await liveSession('mean')
    session.setPersona('sarcastic')
    const swap = socket.sent.filter((frame) => frame.type === 'session.update')
    expect(audioOutput(swap[swap.length - 1])).toMatchObject({
      voice: PERSONAS.sarcastic.voice,
      speed: PERSONAS.sarcastic.speed,
    })
    expect(socket.speedPatches()).toEqual([])
    session.disconnect()
  })
})
