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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoachEvent, WorkoutState } from './types/events'
import type { PersonaId, ToolRegistry } from './types/tools'
import { createPoseEngine } from './pose/poseEngine'
import type { PoseEngine } from './pose/poseEngine'
import { createCoachSession } from './coach/session'
import type { CoachSession, CoachSessionOptions, CoachStatus } from './coach/session'
import { createToolHandlers, summarise } from './coach/toolHandlers'
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
  const [conn, setConn] = useState<ConnState>('idle')
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
  const personaRef = useRef<PersonaId>('mean')
  const heartRef = useRef<HeartRateState>(createHeartRateState())
  const repTimesRef = useRef<readonly number[]>([])
  const voiceRef = useRef(0)

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
      }),
    [applyPersona],
  )

  /** Synchronous on purpose: unlockAudio must run inside the START click gesture. */
  const openSession = useCallback(() => {
    if (sessionRef.current) return
    const options: CoachSessionOptions = {
      persona: personaRef.current,
      registry: buildRegistry(),
      getWorkoutState: () => engineRef.current?.getState() ?? null,
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
  }, [buildRegistry])

  const reconnect = useCallback(() => {
    const session = sessionRef.current
    if (!session) {
      openSession()
      return
    }
    setConn('connecting')
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

  const handleVideoReady = useCallback(
    (video: HTMLVideoElement) => {
      if (engineRef.current) return
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
      } catch (error) {
        console.error('[spotter] pose engine could not be created:', error)
        setFatal(describe(error))
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
  useEffect(() => {
    if (screen !== 'workout') return undefined
    let previousTick = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      const elapsed = now - previousTick
      previousTick = now
      heartRef.current = stepHeartRate(heartRef.current, elapsed, repsPerMinute(repTimesRef.current, now))

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
        void session.destroy().catch((error: unknown) => {
          console.error('[spotter] coach session teardown failed:', describe(error))
        })
      }
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
          conn={conn}
          offline={offline}
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
