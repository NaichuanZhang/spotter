/**
 * SPOTTER shell: two screens, one persona, one pose engine, one coach session.
 *
 * The inversion the whole app is built on lives in handleEvent — the pose engine
 * INITIATES (it measures and decides), the model REACTS to one line of text per
 * event. Tool calls come back the other way and act on this component: the coach's
 * show_reference drops a clip into the HUD, its set_persona retints the frame.
 *
 * This file is the only place the three subsystems meet:
 *   pose/poseEngine   — owns camera + MediaPipe, emits CoachEvents
 *   coach/session     — owns the realtime socket, voice and captions
 *   coach/toolHandlers— turns model tool calls into the UI callbacks below
 * Everything else in src/ui is presentational.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CoachEvent, WorkoutState } from './types/events'
import type { GetHeartRateResult, PersonaId, ToolRegistry } from './types/tools'
import { createPoseEngine } from './pose/poseEngine'
import type { PoseEngine } from './pose/poseEngine'
import { createCoachSession } from './coach/session'
import type { CoachSession, CoachSessionOptions, CoachStatus } from './coach/session'
import { createToolHandlers, summarise } from './coach/toolHandlers'
import { MIC_OFF } from './coach/micUplink'
import type { MicState } from './coach/micUplink'
import { createMusicPlayer } from './coach/musicPlayer'
import type { MusicPlayer, TrackId } from './coach/musicPlayer'
import type { MusicController, MusicDucker } from './coach/musicControl'
import { createHeartRateState, repsPerMinute, step as stepHeartRate, toHeartRateResult } from './mock/heartRate'
import type { HeartRateState } from './mock/heartRate'
import IntroScreen from './ui/IntroScreen'
import WorkoutScreen from './ui/WorkoutScreen'
import type { ConnState } from './ui/Hud'
import type { FaultCandidate } from './ui/FaultChip'
import type { Utterance } from './ui/Captions'
import type { ReferenceClipSpec } from './ui/ReferenceClip'
import type { OverlayLandmark } from './ui/SkeletonOverlay'
import { useHotkeys, HOTKEY_HINTS } from './ui/useHotkeys'

/** Shell-level knobs. Recalibrate here, nowhere else. */
const SESSION = {
  TARGET_REPS: 20,
  /** How often the HUD re-reads engine state (counts, elapsed time, fps). */
  STATE_POLL_MS: 200,
  /** Ignore voice-level changes smaller than this to avoid style thrash. */
  VOICE_EPSILON: 0.03,
} as const

const IDLE_WORKOUT: WorkoutState = {
  target: SESSION.TARGET_REPS,
  totalReps: 0,
  cleanReps: 0,
  phase: 'top',
  activeFaults: [],
  setElapsedSec: 0,
  inFrame: true,
}

const STATUS_TO_CONN: Readonly<Record<CoachStatus, ConnState>> = {
  idle: 'idle',
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'connecting',
  closed: 'idle',
  error: 'error',
}

// ------------------------------------------------------------- pure helpers

/** Never let a subsystem callback take down the UI — and never swallow it either. */
function safely(label: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    console.error(`[spotter] ${label} failed:`, error)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The coach emits the CUMULATIVE transcript, not deltas. Splitting the new tail
 * off is what lets each fragment fade in on its own instead of the whole line
 * re-animating on every partial.
 */
function appendDelta(previous: readonly string[], text: string): readonly string[] {
  const joined = previous.join('')
  if (text === joined) return previous
  if (text.startsWith(joined)) return [...previous, text.slice(joined.length)]
  // The final transcript can revise the partials; replace rather than duplicate.
  return [text]
}

/** Captions never accumulate: a finished utterance is replaced, not appended to. */
function nextUtterance(previous: Utterance | null, text: string, final: boolean): Utterance | null {
  if (!previous || previous.final) {
    if (!text) return previous
    return { id: (previous?.id ?? 0) + 1, chunks: [text], final }
  }
  return {
    ...previous,
    chunks: text ? appendDelta(previous.chunks, text) : previous.chunks,
    final: final || previous.final,
  }
}

/**
 * The heart rate simulation ticks at 5Hz but the displayed reading is rounded, so
 * most ticks are visually identical. Returning the PREVIOUS object when nothing
 * observable moved keeps the HUD from re-rendering for an unchanged number.
 */
function sameReading(a: GetHeartRateResult, b: GetHeartRateResult): boolean {
  return a.bpm === b.bpm && a.zone === b.zone && a.trend === b.trend
}

function writeVoiceLevel(store: { current: number }, level: number): void {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
  if (Math.abs(clamped - store.current) < SESSION.VOICE_EPSILON) return
  store.current = clamped
  document.documentElement.style.setProperty('--voice', clamped.toFixed(2))
}

// ------------------------------------------------------------------ the shell

export default function App() {
  const [screen, setScreen] = useState<'intro' | 'workout'>('intro')
  const [persona, setPersona] = useState<PersonaId>('mean')
  const [workout, setWorkout] = useState<WorkoutState>(IDLE_WORKOUT)
  const [fps, setFps] = useState(0)
  // Two representations of ONE simulation, on purpose:
  //   heartRef   — the live state the physics steps; read by the get_heart_rate
  //                tool handler, which needs the freshest value, not a render-old one.
  //   heartBeat  — the displayed reading. A ref mutation does not re-render, so the
  //                number on screen MUST come from state. Both are written in the
  //                same interval below; nothing reads heartRef during render.
  const [heartBeat, setHeartBeat] = useState<GetHeartRateResult>(() =>
    toHeartRateResult(createHeartRateState()),
  )
  const [conn, setConn] = useState<ConnState>('idle')
  // Pushed from the session (damped there, so this is not a 10 Hz re-render) rather
  // than polled: a denied mic has to show up the moment the prompt is dismissed.
  const [micState, setMicState] = useState<MicState>(MIC_OFF)
  const [musicTrack, setMusicTrack] = useState<TrackId | null>(null)
  const [offline, setOffline] = useState(false)
  const [captionsEnabled, setCaptionsEnabled] = useState(true)
  const [hintVisible, setHintVisible] = useState(false)
  const [utterance, setUtterance] = useState<Utterance | null>(null)
  const [clip, setClip] = useState<ReferenceClipSpec | null>(null)
  const [faultCandidate, setFaultCandidate] = useState<FaultCandidate | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  const engineRef = useRef<PoseEngine | null>(null)
  const sessionRef = useRef<CoachSession | null>(null)
  const musicRef = useRef<MusicPlayer | null>(null)
  const personaRef = useRef<PersonaId>('mean')
  const heartRef = useRef<HeartRateState>(createHeartRateState())
  const repTimesRef = useRef<readonly number[]>([])
  const voiceRef = useRef(0)

  /**
   * Built on first use, not on mount. createMusicPlayer opens no AudioContext until
   * play() runs, so this costs nothing until the coach actually calls play_music —
   * and a context created outside a gesture would only come up suspended.
   */
  const getMusic = useCallback((): MusicPlayer => {
    musicRef.current ??= createMusicPlayer({
      onEnded: () => setMusicTrack(null),
      onError: (error) => console.error('[spotter] music player failed:', describe(error)),
    })
    return musicRef.current
  }, [])

  /**
   * The half play_music is allowed to touch. Deliberately does NOT expose setDucked:
   * how loud the music sits under the coach is not a decision a language model gets
   * to make. The React state written here is only what the HUD indicator reads.
   */
  const musicController = useMemo<MusicController>(
    () => ({
      play: async (track) => {
        const playing = await getMusic().play(track)
        setMusicTrack(playing.track)
        return playing
      },
      stop: () => {
        musicRef.current?.stop()
        setMusicTrack(null)
      },
      isPlaying: () => musicRef.current?.isPlaying() ?? false,
      currentTrack: () => musicRef.current?.currentTrack() ?? null,
    }),
    [getMusic],
  )

  /**
   * The half the coach session is allowed to touch. Uses musicRef directly instead of
   * getMusic(), so ducking silence never constructs a player: there is nothing to duck
   * before the first track, and building an AudioContext outside a user gesture to
   * lower a gain nobody can hear would be the worst of both worlds.
   */
  const musicDucker = useMemo<MusicDucker>(
    () => ({
      setDucked: (reason, ducked) => musicRef.current?.setDucked(reason, ducked),
      stop: () => {
        musicRef.current?.stop()
        setMusicTrack(null)
      },
    }),
    [],
  )

  const applyPersona = useCallback((next: PersonaId) => {
    if (personaRef.current === next) return
    personaRef.current = next
    setPersona(next)
    const session = sessionRef.current
    if (!session) return
    safely('persona switch', () => session.setPersona(next))
  }, [])

  const handleEvent = useCallback((event: CoachEvent) => {
    if (event.kind === 'form_fault') {
      setFaultCandidate({ fault: event.fault, severity: event.severity, at: event.at, valueDeg: event.valueDeg })
    } else if (event.kind === 'out_of_frame') {
      setFaultCandidate({ fault: 'out_of_frame', severity: 'major', at: event.at })
    } else if (event.kind === 'rep_completed') {
      repTimesRef.current = [...repTimesRef.current, event.at]
    } else if (event.kind === 'set_started') {
      setSummary(null)
      repTimesRef.current = []
    } else if (event.kind === 'set_ended') {
      setSummary(summarise(event.totalReps, event.cleanReps, event.faults))
    }

    const engine = engineRef.current
    if (engine) {
      // Defensive copy: if the engine ever hands back its own state object React
      // would not re-render on a mutated reference.
      safely('pose state read', () => setWorkout({ ...engine.getState() }))
    }

    const session = sessionRef.current
    if (!session) return
    safely('coach pushEvent', () => session.pushEvent(event))
  }, [])

  const buildRegistry = useCallback(
    (): ToolRegistry =>
      createToolHandlers({
        getWorkoutState: () => engineRef.current?.getState() ?? null,
        getHeartRate: () => toHeartRateResult(heartRef.current),
        setPersona: (next) => {
          applyPersona(next)
          return true
        },
        showReference: (referenceClip) => {
          setClip({ ...referenceClip, at: Date.now() })
          return true
        },
        logSet: (args) => {
          setSummary(summarise(args.reps, args.cleanReps, args.faults))
          return true
        },
        music: musicController,
      }),
    [applyPersona, musicController],
  )

  /** Synchronous on purpose: unlockAudio must run inside the START click gesture. */
  const openSession = useCallback(() => {
    if (sessionRef.current) return
    const options: CoachSessionOptions = {
      persona: personaRef.current,
      registry: buildRegistry(),
      getWorkoutState: () => engineRef.current?.getState() ?? null,
      // Ducking only. The session cannot start a track through this.
      music: musicDucker,
      onMicState: setMicState,
      onStatus: (status) => setConn(STATUS_TO_CONN[status]),
      onCaption: (caption) => {
        setUtterance((previous) => nextUtterance(previous, caption.text, caption.final))
      },
      onPersonaChange: (next) => {
        personaRef.current = next.id
        setPersona(next.id)
      },
      onError: (error) => console.error('[spotter] coach session error:', error),
    }

    try {
      const session = createCoachSession(options)
      sessionRef.current = session
      setConn('connecting')
      void session.unlockAudio().catch((error: unknown) => {
        console.error('[spotter] audio could not be unlocked:', describe(error))
      })
      void session.connect().catch((error: unknown) => {
        setConn('error')
        console.error('[spotter] coach session failed to connect:', describe(error))
      })
    } catch (error) {
      setConn('error')
      console.error('[spotter] coach session could not be created:', describe(error))
    }
  }, [buildRegistry, musicDucker])

  const reconnect = useCallback(() => {
    const session = sessionRef.current
    if (!session) {
      openSession()
      return
    }
    setConn('connecting')
    // A track outlives a socket. Reconnecting with hype-01 still running would leave
    // 35 seconds of music playing over a session that no longer exists and cannot
    // be asked to stop it.
    safely('music stop', () => session.stopMusic())
    safely('coach disconnect', () => session.disconnect())
    void session.connect().catch((error: unknown) => {
      setConn('error')
      console.error('[spotter] coach reconnect failed:', describe(error))
    })
  }, [openSession])

  const start = useCallback(() => {
    setScreen('workout')
    openSession()
  }, [openSession])

  /**
   * Returns true when the pose engine has CLAIMED the element and owns the camera.
   * The claim is synchronous — it lands before start() awaits getUserMedia — so
   * WorkoutScreen can suppress its fallback instead of racing the permission
   * prompt and opening a second stream.
   */
  const handleVideoReady = useCallback(
    (video: HTMLVideoElement): boolean => {
      if (engineRef.current) return true
      try {
        const options = {
          video,
          target: SESSION.TARGET_REPS,
          onError: (error: unknown) => console.warn('[spotter] pose frame error:', describe(error)),
        }
        const engine = createPoseEngine(options)
        engineRef.current = engine
        engine.onEvent(handleEvent)
        void engine.start().catch((error: unknown) => {
          console.error('[spotter] pose engine failed to start:', error)
          setFatal(describe(error))
        })
        return true
      } catch (error) {
        console.error('[spotter] pose engine could not be created:', error)
        setFatal(describe(error))
        return false
      }
    },
    [handleEvent],
  )

  /** Pulled once per animation frame by the skeleton overlay, never via state. */
  const getLandmarks = useCallback(
    (): readonly OverlayLandmark[] | null => engineRef.current?.getLandmarks() ?? null,
    [],
  )

  const dismissClip = useCallback(() => setClip(null), [])

  useHotkeys({
    onSyntheticRep: () => safely('synthetic rep', () => engineRef.current?.injectSyntheticRep()),
    onPersona: applyPersona,
    onReconnect: reconnect,
    onToggleOffline: () => setOffline((value) => !value),
    onToggleCaptions: () => setCaptionsEnabled((value) => !value),
    onToggleHint: () => setHintVisible((value) => !value),
    onEscape: () => {
      setHintVisible(false)
      setClip(null)
    },
  })

  // HUD numerals + the simulated heart rate advance on one clock, and that clock
  // MUST be performance.now(): repTimesRef holds `event.at` values, which the pose
  // engine stamps with performance.now() (ms since page load). Mixing in Date.now()
  // here silently puts every rep timestamp ~1.7e12 ms "in the past", so
  // repsPerMinute filters them all out, returns 0, and the simulated heart rate
  // never leaves its resting value no matter how hard the user works. Both clocks
  // are `number`, so neither tsc nor the bundler can catch the swap.
  //
  // This is also the ONLY place the displayed heart rate is published. Do not add a
  // second timer for it, and do not let the HUD read heartRef: a ref mutation is
  // invisible to React, so the widget would freeze at 64 bpm exactly as it used to.
  useEffect(() => {
    if (screen !== 'workout') return undefined
    let previousTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const elapsed = now - previousTick
      previousTick = now
      const heart = stepHeartRate(heartRef.current, elapsed, repsPerMinute(repTimesRef.current, now))
      heartRef.current = heart
      const reading = toHeartRateResult(heart)
      setHeartBeat((previous) => (sameReading(previous, reading) ? previous : reading))

      const engine = engineRef.current
      if (!engine) return
      safely('pose state poll', () => {
        setWorkout({ ...engine.getState() })
        setFps(engine.getFps())
      })
    }, SESSION.STATE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [screen])

  // Voice amplitude -> --voice, which drives the persona rim light and backdrop
  // tint. Written straight to the DOM: React state at frame rate is not worth it.
  useEffect(() => {
    if (screen !== 'workout') return undefined
    let frame = 0
    const tick = () => {
      frame = window.requestAnimationFrame(tick)
      const session = sessionRef.current
      writeVoiceLevel(voiceRef, session ? session.audio.level() : 0)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      document.documentElement.style.setProperty('--voice', '0')
    }
  }, [screen])

  useEffect(
    () => () => {
      safely('pose engine stop', () => engineRef.current?.stop())
      const session = sessionRef.current
      if (session) {
        // destroy() also stops the mic capture and releases both duck reasons.
        void session.destroy().catch((error: unknown) => {
          console.error('[spotter] coach session teardown failed:', describe(error))
        })
      }
      // Last, and unconditionally: the session only stops the TRACK, and only if it
      // was ever given the ducker. The AudioContext and the <audio> element belong to
      // this component and leak with the page otherwise.
      safely('music destroy', () => musicRef.current?.destroy())
      musicRef.current = null
    },
    [],
  )

  return (
    <div className="app" data-persona={persona} data-screen={screen}>
      {screen === 'intro' ? (
        <IntroScreen persona={persona} onPersona={applyPersona} onStart={start} target={SESSION.TARGET_REPS} />
      ) : (
        <WorkoutScreen
          persona={persona}
          onPersona={applyPersona}
          workout={workout}
          fps={fps}
          heart={heartBeat}
          conn={conn}
          offline={offline}
          mic={micState}
          musicTrack={musicTrack}
          summary={summary}
          faultCandidate={faultCandidate}
          utterance={utterance}
          captionsEnabled={captionsEnabled}
          clip={clip}
          onDismissClip={dismissClip}
          getLandmarks={getLandmarks}
          onVideoReady={handleVideoReady}
        />
      )}

      {fatal ? (
        <p className="banner" role="alert">
          {fatal}
        </p>
      ) : null}

      {hintVisible ? <HotkeyHint onClose={() => setHintVisible(false)} /> : null}
    </div>
  )
}

function HotkeyHint({ onClose }: { readonly onClose: () => void }) {
  return (
    <aside className="hint glass" role="dialog" aria-label="Demo keys">
      <p className="hint__title">DEMO KEYS</p>
      <ul className="hint__list">
        {HOTKEY_HINTS.map((entry) => (
          <li key={entry.keys}>
            <kbd>{entry.keys}</kbd>
            <span>{entry.label}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="hint__close" onClick={onClose}>
        close
      </button>
    </aside>
  )
}
