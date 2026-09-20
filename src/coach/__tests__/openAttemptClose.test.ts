/**
 * THE REGRESSION THIS FILE EXISTS FOR — found by running the live probe, not by reading.
 *
 * One `connect()` opened THREE sessions. The live transcript
 * (src/coach/__tests__/liveTwoWay.test.ts, "stop the music") recorded
 * `session.update x3` sent and `session.created x2` received for a single connect,
 * against a key the API limits to ONE concurrent realtime session — the exact condition
 * that answers close code 1013 and can kill both sessions mid-demo.
 *
 * THE MECHANISM. A pre-ack `error` frame (voice validation answering HTTP 429 is the
 * common one, roughly 1 startup in 8) makes openHiggsSocket close its own socket so the
 * half-open session stops counting against the concurrency limit, then reject. That
 * close is delivered to session.ts's onClose BEFORE the rejection reaches the catch that
 * owns the retry — and `generation` still matches, so `closeCallbackFor` lets it through
 * to handleClose, which treats it as an unexpected drop and schedules a reconnect.
 *
 * So two independent recovery paths then run at once: the voice retry (after its 2 s
 * delay) and the reconnect (after its ~600 ms backoff). Both mint a token, both open a
 * socket, both can reach session.created. The loser is never closed — it sits open until
 * the server's five-minute idle timeout — and `socketTap`'s `pending`/`promote` handshake
 * is left racing two sockets, which is how the mic uplink could end up appending to the
 * one nobody is listening on.
 *
 * A close from an attempt the connect path is still handling is that path's business.
 */
import { describe, expect, it } from 'vitest'
import { createCoachSession } from '../session'
import type { CoachStatus } from '../session'

const VOICE_429 =
  "Session terminated due to Error while handling session update: Could not validate voice 'jake': voices API returned HTTP 429"

/** Same minimal stand-in the other socket tests use: only what higgsSocket touches. */
class FakeSocket {
  static readonly OPEN = 1
  readyState = FakeSocket.OPEN
  readonly sent: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = { code, reason }
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

function socketFactory() {
  const sockets: FakeSocket[] = []
  const createSocket = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    queueMicrotask(() => socket.onopen?.())
    return socket as unknown as WebSocket
  }
  return { sockets, createSocket }
}

const flush = () => new Promise((done) => setTimeout(done, 0))
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await flush()
}
/**
 * Longer than the worst-case first backoff (reconnectBaseMs 600 with +30% jitter = 780 ms),
 * because the whole point is to catch a socket that opens LATER than the assertion would.
 */
const pastFirstBackoff = () => new Promise((done) => setTimeout(done, 1_000))

describe('createCoachSession — a failed open attempt owns its own close', () => {
  it('does not schedule a reconnect for the socket its voice retry is already replacing', async () => {
    const { sockets, createSocket } = socketFactory()
    const statuses: CoachStatus[] = []
    const session = createCoachSession({
      persona: 'mean',
      voiceRetryDelayMs: 0,
      micEnabled: false,
      socket: { createSocket, fetchImpl: tokenFetch },
      onStatus: (status) => statuses.push(status),
    })

    const connecting = session.connect()
    await flush()
    // The server rejects session.update and terminates. openHiggsSocket closes this
    // socket itself, and that close used to look like an unexpected drop.
    sockets[0]?.emit({ type: 'error', error: { message: VOICE_429 } })
    await settle()
    sockets[1]?.emit({ type: 'session.created' })
    await connecting

    expect(session.getStatus()).toBe('live')
    // 'reconnecting' here means handleClose ran the recovery a second time, in parallel.
    expect(statuses).not.toContain('reconnecting')

    await pastFirstBackoff()
    // Two sockets: the one that was rejected, and the one that replaced it. A third is a
    // second live session on a one-session-per-key limit.
    expect(sockets).toHaveLength(2)
    expect(session.getStatus()).toBe('live')
    session.disconnect()
  })

  it('still reconnects when a socket that WAS live drops', async () => {
    const { sockets, createSocket } = socketFactory()
    const statuses: CoachStatus[] = []
    const session = createCoachSession({
      persona: 'mean',
      voiceRetryDelayMs: 0,
      micEnabled: false,
      socket: { createSocket, fetchImpl: tokenFetch },
      onStatus: (status) => statuses.push(status),
    })

    const connecting = session.connect()
    await flush()
    sockets[0]?.emit({ type: 'session.created' })
    await connecting
    expect(session.getStatus()).toBe('live')

    // A genuine transport drop, on the socket the session was actually using.
    sockets[0]?.onclose?.({ code: 1006, reason: 'gone', wasClean: false })
    expect(statuses).toContain('reconnecting')

    await pastFirstBackoff()
    await settle()
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    sockets[1]?.emit({ type: 'session.created' })
    await settle()
    expect(session.getStatus()).toBe('live')
    session.disconnect()
  })
})
