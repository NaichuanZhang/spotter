/**
 * A handle on the raw WebSocket behind a HiggsConnection, for the one frame type the
 * transport deliberately does not model: `input_audio_buffer.append`.
 *
 * WHY THIS EXISTS AT ALL. higgsSocket.ts is pure protocol and exposes exactly the four
 * policy frames it understands — push an item, reply to a tool, patch the session, patch
 * the speed. There is no raw send, on purpose. But the mic uplink has to put audio on
 * THE SAME socket as everything else, and the two credible alternatives are both worse:
 * forking the transport duplicates its ack, dedupe and close state, and opening a second
 * socket spends the one-session-per-key budget and closes both with code 1013.
 *
 * So this wraps the `createSocket` seam OpenOptions already provides for tests. The
 * default branch is the same `new WebSocket(url, protocols)` higgsSocket would have run,
 * which means installing the tap changes nothing about how the socket is opened.
 *
 * THE PROMOTE STEP IS THE LOAD-BEARING PART. A socket is built by every open ATTEMPT,
 * including the ones that fail — a rejected voice, a stale token, a 429 from the voices
 * API. Sending mic audio into one of those is shouting into a corpse while the real
 * session is somewhere else, so a socket is only usable once openHiggsSocket has
 * resolved and the caller says so.
 */

import { CoachError } from './higgsSocket'
import type { OpenOptions } from './higgsSocket'

export interface SocketTap {
  /** OpenOptions with createSocket wrapped. Pass the result to openHiggsSocket. */
  options: () => OpenOptions
  /** Call once openHiggsSocket RESOLVES. Until then there is nothing safe to send on. */
  promote: () => void
  /** Call when an attempt fails, when the socket closes, and on disconnect. */
  release: () => void
  /**
   * Sends one frame. Returns false when there is nothing open — which is NORMAL
   * (pre-connect, mid-reconnect) and is not reported as an error, because a buffer
   * dropped during a reconnect belongs to a turn the server has already abandoned.
   */
  send: (frame: Record<string, unknown>) => boolean
}

export interface SocketTapOptions {
  /** Caller-supplied transport options, which may already carry a createSocket. */
  readonly base?: OpenOptions
  /** True only while the session still considers its connection usable. */
  readonly isConnected: () => boolean
  /** A send that actually threw. Never called for "no socket yet". */
  readonly onError: (error: CoachError) => void
}

export function createSocketTap(options: SocketTapOptions): SocketTap {
  let live: WebSocket | null = null
  let pending: WebSocket | null = null

  return {
    options: () => {
      const base = options.base ?? {}
      const create =
        base.createSocket ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols))
      return {
        ...base,
        createSocket: (url, protocols) => {
          const socket = create(url, protocols)
          pending = socket
          return socket
        },
      }
    },
    promote: () => {
      live = pending
      pending = null
    },
    release: () => {
      live = null
      pending = null
    },
    send: (frame) => {
      const socket = live
      if (!options.isConnected() || !socket || socket.readyState !== WebSocket.OPEN) return false
      try {
        socket.send(JSON.stringify(frame))
        return true
      } catch (cause) {
        options.onError(new CoachError('audio', 'could not send a microphone buffer', cause))
        return false
      }
    },
  }
}
