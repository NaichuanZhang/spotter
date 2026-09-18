/**
 * Background music, played on demand when the coach calls `play_music`.
 *
 * Routed through WebAudio rather than a bare <audio> element for one reason: we
 * need to DUCK it. A mastered track at full level buries a speaking coach, and
 * the coach is the product — so music sits under speech, not beside it.
 *
 * ── WHY MUSIC DOES NOT GATE THE MIC ────────────────────────────────────────
 * audioIn.ts closes the mic while the COACH speaks, because otherwise the model
 * hears itself. The obvious extension — also close it while music plays — creates
 * a trap: the track runs 35 s, so "stop the music" could never be heard for its
 * whole duration. The user would be shouting at a deaf coach.
 *
 * Instead music ducks to `duckedGain` whenever the mic is armed, and browser echo
 * cancellation handles the residue. Ducked music sits well below the VAD floor,
 * so it does not read as a user turn.
 *
 * Two independent duck reasons therefore exist and they must not fight: the coach
 * speaking, and the mic listening. `setDucked` takes a reason so whichever is
 * active keeps the level down, and music only returns to full when BOTH clear.
 */

/** Tunables in one place. These get set by ear — expect them to change. */
export const MUSIC_CONFIG = {
  /** Normal playback level. The asset is already loudness-normalised to about
   *  -21.6 LUFS with -7.6 dB peak, so it does not need much taming. */
  baseGain: 0.55,
  /** Level while the coach speaks or the mic is armed. Audible, but clearly under. */
  duckedGain: 0.12,
  /** Duck/restore ramp. Fast enough to catch the first syllable, slow enough not to pump. */
  duckRampSec: 0.18,
  restoreRampSec: 0.45,
  /** Fade applied on stop, so ending a track never clicks. */
  stopFadeSec: 0.35,
  /** Tracks live in public/music/. Keys are what the model may ask for. */
  tracks: {
    hype: { file: '/music/hype-01.mp3', label: 'Hype', approxSec: 35 },
  },
} as const

export type TrackId = keyof typeof MUSIC_CONFIG.tracks
export type DuckReason = 'coach' | 'mic'

export const TRACK_IDS = Object.keys(MUSIC_CONFIG.tracks) as readonly TrackId[]

export function isTrackId(value: unknown): value is TrackId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MUSIC_CONFIG.tracks, value)
}

export interface MusicPlayer {
  /** Resolves once playback has actually begun. Rejects if the browser refuses. */
  play(track?: TrackId): Promise<{ track: TrackId; label: string; approxSec: number }>
  stop(): void
  isPlaying(): boolean
  currentTrack(): TrackId | null
  /** Add or clear a duck reason. Level stays down while ANY reason is active. */
  setDucked(reason: DuckReason, ducked: boolean): void
  destroy(): void
}

interface MusicPlayerOptions {
  /** Shared AudioContext when the caller has one, so we do not open a second. */
  readonly context?: AudioContext
  readonly onEnded?: () => void
  readonly onError?: (error: Error) => void
}

export function createMusicPlayer(options: MusicPlayerOptions = {}): MusicPlayer {
  const reasons = new Set<DuckReason>()
  let context: AudioContext | null = options.context ?? null
  let ownsContext = options.context === undefined
  let element: HTMLAudioElement | null = null
  let sourceNode: MediaElementAudioSourceNode | null = null
  let gainNode: GainNode | null = null
  let track: TrackId | null = null

  function targetGain(): number {
    return reasons.size > 0 ? MUSIC_CONFIG.duckedGain : MUSIC_CONFIG.baseGain
  }

  function rampTo(value: number, seconds: number): void {
    if (!context || !gainNode) return
    const now = context.currentTime
    // cancelScheduledValues + setValueAtTime pins the curve's start to the CURRENT
    // value; without it, overlapping ramps jump.
    gainNode.gain.cancelScheduledValues(now)
    gainNode.gain.setValueAtTime(gainNode.gain.value, now)
    gainNode.gain.linearRampToValueAtTime(value, now + seconds)
  }

  function teardownGraph(): void {
    sourceNode?.disconnect()
    sourceNode = null
    gainNode?.disconnect()
    gainNode = null
    if (element) {
      element.onended = null
      element.pause()
      element.src = ''
      element = null
    }
    track = null
  }

  async function play(requested: TrackId = TRACK_IDS[0] as TrackId) {
    const meta = MUSIC_CONFIG.tracks[requested]
    if (!meta) throw new Error(`unknown track: ${String(requested)}`)

    // Restarting the same track is the common case ("more music"), so tear the old
    // graph down rather than layering two sources over each other.
    teardownGraph()

    context ??= new AudioContext()
    ownsContext = options.context === undefined
    if (context.state === 'suspended') await context.resume()

    const audio = new Audio(meta.file)
    audio.loop = false
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'

    const src = context.createMediaElementSource(audio)
    const gain = context.createGain()
    // Start ducked and ramp up, so a track never slams in at full level.
    gain.gain.value = MUSIC_CONFIG.duckedGain
    src.connect(gain)
    gain.connect(context.destination)

    element = audio
    sourceNode = src
    gainNode = gain
    track = requested

    audio.onended = () => {
      teardownGraph()
      options.onEnded?.()
    }

    try {
      await audio.play()
    } catch (cause) {
      teardownGraph()
      // Autoplay policy: a tool call triggered by speech is not a click, so the
      // browser may refuse. The caller surfaces this rather than silently failing.
      throw new Error(`the browser refused to play music: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    rampTo(targetGain(), MUSIC_CONFIG.restoreRampSec)
    return { track: requested, label: meta.label, approxSec: meta.approxSec }
  }

  function stop(): void {
    if (!element || !context || !gainNode) {
      teardownGraph()
      return
    }
    const fading = element
    rampTo(0, MUSIC_CONFIG.stopFadeSec)
    // Let the fade finish before ripping the graph out, or stopping clicks.
    window.setTimeout(() => {
      if (element === fading) teardownGraph()
    }, MUSIC_CONFIG.stopFadeSec * 1000 + 40)
  }

  function setDucked(reason: DuckReason, ducked: boolean): void {
    const had = reasons.size > 0
    if (ducked) reasons.add(reason)
    else reasons.delete(reason)
    const has = reasons.size > 0
    if (had === has) return
    rampTo(targetGain(), has ? MUSIC_CONFIG.duckRampSec : MUSIC_CONFIG.restoreRampSec)
  }

  return {
    play,
    stop,
    isPlaying: () => element !== null && !element.paused,
    currentTrack: () => track,
    setDucked,
    destroy: () => {
      teardownGraph()
      reasons.clear()
      if (ownsContext) {
        void context?.close().catch(() => undefined)
        context = null
      }
    },
  }
}
