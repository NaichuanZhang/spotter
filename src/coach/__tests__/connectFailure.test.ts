/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * Measured against the live API: voice validation intermittently answers HTTP 429,
 * and the server then replies with an `error` frame ("Could not validate voice
 * 'oliver': voices API returned HTTP 429") and terminates the session BEFORE it ever
 * sends session.created. Roughly one startup in eight died this way.
 *
 * The old code logged that frame and kept waiting, so the connect could only fail
 * later — via the close, whose CoachError kind is `socket_closed` and whose message
 * no longer mentions a voice. `shouldRetryWithFallbackVoice` matches on exactly those
 * two things, so the fallback voice was never tried and the stage saw COACH DOWN.
 *
 * Deciding the connect on a pre-ack error frame means a second socket opens while the
 * first one is still closing, which is the second half of what is pinned here: the
 * dead socket's late close must not tear down the session that replaced it.
 */
import { describe, expect, it } from 'vitest'
import { CoachError, openHiggsSocket } from '../higgsSocket'
import type { HiggsCallbacks } from '../higgsSocket'
import { createCoachSession } from '../session'
import { PERSONAS } from '../personas'

const VOICE_429 =
  "Session terminated due to Error while handling session update: Could not validate voice 'oliver': voices API returned HTTP 429"

/** Minimal stand-in for the platform WebSocket: only what higgsSocket actually touches. */
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

  /** Server -> client. */
  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  errorFrame(message: string): void {
    this.emit({ type: 'error', error: { message } })
  }

  /** The voice the session.update frame asked for. */
  requestedVoice(): string | undefined {
    const update = this.sent.find((frame) => frame.type === 'session.update')
    const session = update?.session as { audio?: { output?: { voice?: string } } } | undefined
    return session?.audio?.output?.voice
  }
}

const tokenFetch = () =>
  Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve({ value: 'bai-eph-test' }) } as Response)

function silentCallbacks(overrides: Partial<HiggsCallbacks> = {}): HiggsCallbacks {
  return {
    onAudioDelta: () => {},
    onTranscriptDelta: () => {},
    onTranscriptDone: () => {},
    onAudioDone: () => {},
    onResponseDone: () => {},
    onToolCall: () => {},
    onError: () => {},
    onClose: () => {},
    ...overrides,
  }
}

/** Hands out a fresh FakeSocket per attempt and records them in order. */
function socketFactory() {
  const sockets: FakeSocket[] = []
  const createSocket = () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    // openHiggsSocket assigns ws.onopen after we return, so defer firing it.
    queueMicrotask(() => socket.onopen?.())
    return socket as unknown as WebSocket
  }
  return { sockets, createSocket }
}

const flush = () => new Promise((done) => setTimeout(done, 0))

describe('openHiggsSocket — an error frame before the ack decides the connect', () => {
  it('rejects with the server wording so the voice fallback can match on it', async () => {
    const { sockets, createSocket } = socketFactory()
    const opening = openHiggsSocket({ instructions: 'x', voice: 'oliver' }, silentCallbacks(), {
      createSocket,
      fetchImpl: tokenFetch,
    })
    await flush()
    sockets[0].errorFrame(VOICE_429)

    const error = await opening.then(
      () => null,
      (cause: unknown) => cause as CoachError,
    )
    expect(error).toBeInstanceOf(CoachError)
    expect(error?.kind).toBe('server_error')
    expect(error?.message).toMatch(/voice/i)
    // A half-open session would keep counting against the concurrency limit (1013).
    expect(sockets[0].closed).not.toBeNull()
  })

  it('leaves a post-ack error frame as a plain report, not a connect failure', async () => {
    const { sockets, createSocket } = socketFactory()
    const errors: CoachError[] = []
    const opening = openHiggsSocket(
      { instructions: 'x', voice: 'jake' },
      silentCallbacks({ onError: (error) => errors.push(error) }),
      { createSocket, fetchImpl: tokenFetch },
    )
    await flush()
    sockets[0].emit({ type: 'session.created' })
    const connection = await opening

    sockets[0].errorFrame('Voice output task is ongoing. Skipping.')
    expect(errors.map((e) => e.message)).toContain('Voice output task is ongoing. Skipping.')
    expect(connection.isOpen()).toBe(true)
    expect(sockets[0].closed).toBeNull()
  })
})

describe('createCoachSession — recovery from a rejected voice', () => {
  it('retries once with fallbackVoice and reports live', async () => {
    const { sockets, createSocket } = socketFactory()
    const session = createCoachSession({
      persona: 'sarcastic',
      socket: { createSocket, fetchImpl: tokenFetch },
    })
    const connecting = session.connect()
    await flush()
    expect(sockets[0].requestedVoice()).toBe(PERSONAS.sarcastic.voice)

    sockets[0].errorFrame(VOICE_429)
    await flush()
    sockets[1]?.emit({ type: 'session.created' })
    await connecting

    expect(sockets).toHaveLength(2)
    expect(sockets[1].requestedVoice()).toBe(PERSONAS.sarcastic.fallbackVoice)
    expect(session.getStatus()).toBe('live')
  })

  it('ignores a late close from the socket it already gave up on', async () => {
    const { sockets, createSocket } = socketFactory()
    const session = createCoachSession({
      persona: 'sarcastic',
      socket: { createSocket, fetchImpl: tokenFetch },
    })
    const connecting = session.connect()
    await flush()
    sockets[0].errorFrame(VOICE_429)
    await flush()
    sockets[1]?.emit({ type: 'session.created' })
    await connecting

    // The dead socket's close lands after the replacement is already live.
    sockets[0].onclose?.({ code: 1011, reason: 'terminated', wasClean: false })
    await flush()
    expect(session.getStatus()).toBe('live')
    // Nothing reconnected behind our back.
    expect(sockets).toHaveLength(2)
    session.disconnect()
  })
})
