/**
 * The two narrow views of the music player, plus the duck coordinator.
 *
 * `createMusicPlayer` is one object, but two very different callers need it and
 * neither should be able to reach the other's half:
 *   - the play_music TOOL HANDLER starts and stops tracks, and must not touch the
 *     duck level — ducking is not a decision a language model gets to make;
 *   - the COACH SESSION only ducks, and must not start playback — nothing but an
 *     explicit user request may make noise.
 * Both are structurally satisfied by MusicPlayer, so App passes the same object
 * twice and tsc still keeps the halves apart.
 *
 * ── WHY THE DUCK COORDINATOR IS A SET AND NOT A BOOLEAN ─────────────────────
 * Two things independently want the music quiet: the coach speaking, and the mic
 * listening. They overlap constantly — the coach stops talking, the gate reopens,
 * the mic arms — and with a single boolean whichever one cleared last would restore
 * full volume while the other still needed it down. musicPlayer models this as a Set
 * of reasons and only restores when the set empties; this module's job is to keep the
 * caller honest about the OTHER half of that contract, which is that BOTH edges have
 * to be reported every time. `syncDuck` recomputes the whole map and emits only the
 * transitions, so there is no code path that sets a reason and forgets to clear it.
 */

import type { DuckReason, TrackId } from './musicPlayer'

/** What the play_music handler is allowed to do. */
export interface MusicController {
  play(track?: TrackId): Promise<MusicNowPlaying>
  stop(): void
  isPlaying(): boolean
  currentTrack(): TrackId | null
}

/** What the coach session is allowed to do. */
export interface MusicDucker {
  setDucked(reason: DuckReason, ducked: boolean): void
  stop(): void
}

/** Exactly what musicPlayer.play() resolves with — restated so callers need not import it. */
export interface MusicNowPlaying {
  track: TrackId
  label: string
  approxSec: number
}

export type DuckReasons = Readonly<Record<DuckReason, boolean>>

/** Nothing wants the music quiet. The starting point, and what teardown restores to. */
export const NO_DUCK: DuckReasons = Object.freeze({ coach: false, mic: false })

/** Every reason, derived from NO_DUCK so syncDuck cannot skip one added later. */
export const DUCK_REASONS: readonly DuckReason[] = Object.freeze(
  Object.keys(NO_DUCK) as DuckReason[],
)

export interface DuckInputs {
  /** audioOut.isSpeaking() — the coach is audible right now. */
  readonly coachSpeaking: boolean
  /** The mic is capturing, un-gated, and actually passing buffers upstream. */
  readonly micArmed: boolean
}

/**
 * The whole map, every time. Returning a partial map is what would let one reason
 * leak: a caller that only hears about `coach` cannot know whether `mic` is still
 * holding the level down.
 */
export function duckReasonsFor(inputs: DuckInputs): DuckReasons {
  return { coach: inputs.coachSpeaking, mic: inputs.micArmed }
}

/**
 * Applies only the reasons that changed and returns the new map. Immutable: the
 * caller stores the result rather than having its previous map mutated underneath it.
 *
 * Sending only the edges matters because setDucked ramps the gain, and re-asserting a
 * reason that is already set would be harmless in musicPlayer (it early-returns on an
 * unchanged set size) but not in a fake, and this runs on a 100 ms tick.
 */
export function syncDuck(ducker: MusicDucker, previous: DuckReasons, next: DuckReasons): DuckReasons {
  for (const reason of DUCK_REASONS) {
    if (previous[reason] === next[reason]) continue
    ducker.setDucked(reason, next[reason])
  }
  return next
}
