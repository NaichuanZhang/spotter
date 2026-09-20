/**
 * The 100 ms coordinator: it recomputes the music duck reasons and republishes mic
 * state, and it is a POLL rather than a set of event handlers on purpose.
 *
 * Neither of its two inputs is an event. `audioOut.isSpeaking()` is derived from how
 * much audio is still scheduled ahead of the audio clock, and `response.done` arrives
 * while seconds of that audio are still queued — so the obvious "duck on response
 * start, restore on response done" is wrong at both ends. The mic's armed state is
 * likewise a derived fact with a 400 ms hold on it. Polling both at 100 ms lands
 * comfortably inside musicPlayer's 180 ms duck ramp, so the level is already moving
 * before the first syllable is audible.
 *
 * It also owns the damping on mic state. `level` moves on every ~85 ms buffer, and an
 * undamped callback would re-render the HUD at 10 Hz for changes no eye can resolve.
 */

import { duckReasonsFor, NO_DUCK, syncDuck } from './musicControl'
import type { DuckReasons, MusicDucker } from './musicControl'
import { MIC_OFF } from './micUplink'
import type { MicState } from './micUplink'

export const DUCK_LOOP = {
  tickMs: 100,
  /** Below this the mic level has not moved enough to redraw a three-segment meter. */
  micLevelStep: 0.05,
} as const

export function micLevelStep(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.round(Math.min(1, level) / DUCK_LOOP.micLevelStep)
}

/** Quantised on `level` only; every other field is compared exactly. */
export function sameMicState(a: MicState, b: MicState): boolean {
  return (
    a.capturing === b.capturing &&
    a.gated === b.gated &&
    a.armed === b.armed &&
    (a.error?.code ?? null) === (b.error?.code ?? null) &&
    micLevelStep(a.level) === micLevelStep(b.level)
  )
}

export interface DuckLoopOptions {
  /** audioOut.isSpeaking() — duck reason 'coach'. */
  readonly isCoachSpeaking: () => boolean
  /** The uplink's live state; its `armed` field is duck reason 'mic'. */
  readonly getMicState: () => MicState
  /** Omit and nothing ducks. The loop still publishes mic state. */
  readonly music?: MusicDucker
  readonly onMicState?: (state: MicState) => void
  /** Injected in tests. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
}

export interface DuckLoop {
  start(): void
  /** Stops ticking AND releases every held duck reason. */
  stop(): void
  /** Recompute now, outside the tick. Used when something has obviously changed. */
  publish(): void
}

export function createDuckLoop(options: DuckLoopOptions): DuckLoop {
  const schedule = options.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const unschedule = options.clearInterval ?? ((handle) => clearInterval(handle as never))
  let timer: unknown = null
  let reasons: DuckReasons = NO_DUCK
  let published: MicState = MIC_OFF

  function publish(): void {
    const next = options.getMicState()
    if (sameMicState(published, next)) return
    published = next
    options.onMicState?.(next)
  }

  /**
   * Recomputes BOTH reasons and applies only the transitions. Both edges, always:
   * 'coach' and 'mic' overlap constantly, and a caller that sets one and forgets to
   * clear it leaves the music quiet for the rest of the demo.
   */
  function tick(): void {
    publish()
    if (!options.music) return
    reasons = syncDuck(
      options.music,
      reasons,
      duckReasonsFor({ coachSpeaking: options.isCoachSpeaking(), micArmed: published.armed }),
    )
  }

  return {
    start: () => {
      if (timer !== null) return
      timer = schedule(tick, DUCK_LOOP.tickMs)
    },
    stop: () => {
      if (timer !== null) {
        unschedule(timer)
        timer = null
      }
      // Release on the way out. A track can outlive the socket, and with the tick
      // stopped there would be nothing left running to restore its level.
      if (options.music) reasons = syncDuck(options.music, reasons, NO_DUCK)
    },
    publish,
  }
}
