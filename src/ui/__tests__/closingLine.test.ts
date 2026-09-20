/**
 * STAGE 1 OF THE ENDING, on the wire.
 *
 * `closingLine` is pure text and setSummary.test.ts pins its words, but the thing that
 * actually has to be true is that the text REACHES THE MODEL AND DRAWS A REPLY. Two
 * ways that can silently fail, and both are what this file exists for:
 *
 *   1. `conversation.item.create` without the mandatory `response.create` is a coach
 *      that goes permanently mute with no error frame — this repo's worst failure mode.
 *   2. An event pushed through `pushEvent` can be held back by the speech policy (and
 *      routinely is, by design). A typed user turn must NOT be, or the ending screen
 *      is silent exactly when the set has just finished and everything is quiet.
 *
 * It drives the real `createCoachSession` through its injectable socket seam, so the
 * frames asserted here are the frames a browser sends.
 */
import { describe, expect, it } from 'vitest'
import { createCoachSession } from '../../coach/session'
import { EMPTY_LEDGER } from '../setLedger'
import { closingLine, summariseSet } from '../setSummary'
import type { SetSummary } from '../setSummary'

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
}

const tokenFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ value: 'bai-eph-test' }),
  } as Response)

const flush = () => new Promise((done) => setTimeout(done, 0))

/** A connected session with no Web Audio and no microphone. */
async function liveSession() {
  const sockets: FakeSocket[] = []
  const session = createCoachSession({
    persona: 'mean',
    micEnabled: false,
    audio: {
      unlock: () => Promise.resolve(),
      unlocked: () => true,
      enqueue: () => {},
      stop: () => {},
      // The policy's hardest case: the coach is ALREADY TALKING when the set ends.
      isSpeaking: () => true,
      level: () => 0,
      queuedSec: () => 4,
      setEmphasis: () => {},
      close: () => Promise.resolve(),
    },
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
  sockets[0].emit({ type: 'session.created' })
  await connecting
  return { session, socket: sockets[0] }
}

function summary(overrides: Partial<SetSummary> = {}): SetSummary {
  const base = summariseSet({
    ledger: {
      ...EMPTY_LEDGER,
      reps: 20,
      cleanReps: 18,
      partialReps: 2,
      bestDepthPct: 96,
      measuredReps: 0,
      faults: ['no_lockout'],
      startedAt: 1000,
      endedAt: 89_000,
    },
    target: 20,
    reason: 'target_reached',
    now: 90_000,
  })
  return { ...base, ...overrides }
}

function userTexts(socket: FakeSocket): string[] {
  return socket.sent
    .filter((frame) => frame.type === 'conversation.item.create')
    .map((frame) => JSON.stringify((frame as { item?: unknown }).item))
}

describe('the closing line on the wire', () => {
  it('sends the reading AND the mandatory response.create, in that order', async () => {
    const { session, socket } = await liveSession()
    const before = socket.sent.length
    session.sendUserText(closingLine(summary()))
    const types = socket.sent.slice(before).map((frame) => frame.type)
    expect(types).toEqual(['conversation.item.create', 'response.create'])
  })

  it('is not held back by the speech policy even while the coach is mid-utterance', async () => {
    const { session, socket } = await liveSession()
    const before = socket.sent.length
    session.sendUserText(closingLine(summary()))
    // A ranked pose event would be suppressed here; the whole-set verdict must not be.
    expect(socket.sent.slice(before)).toHaveLength(2)
  })

  it('carries the honesty clause and the numbers all the way to the frame', async () => {
    const { session, socket } = await liveSession()
    session.sendUserText(closingLine(summary()))
    const item = userTexts(socket).at(-1) ?? ''
    expect(item).toContain('[EVENT] set complete')
    expect(item).toContain('20 of 20 reps')
    expect(item).toContain('18 clean (no fault detected)')
    expect(item).toContain('body line not visible')
    expect(item).toContain('best depth 96%')
    // Never on the Realtime wire: TTS-3 tags do nothing here and can be read aloud.
    expect(item).not.toContain('<|')
  })

  it('puts no session.update on the wire — a stray patch costs a CoachError', async () => {
    const { session, socket } = await liveSession()
    const before = socket.sent.length
    session.sendUserText(closingLine(summary()))
    expect(socket.sent.slice(before).map((frame) => frame.type)).not.toContain('session.update')
  })

  it('drops the line rather than throwing when the socket is not open', async () => {
    const { session, socket } = await liveSession()
    socket.close()
    const before = socket.sent.length
    expect(() => session.sendUserText(closingLine(summary()))).not.toThrow()
    expect(socket.sent).toHaveLength(before)
  })
})
