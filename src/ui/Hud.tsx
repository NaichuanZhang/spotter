/**
 * The glass HUD: the only place in the app where a metric may carry hue.
 *
 * Top-left of the workout screen, one panel, never two. The rep numeral is the
 * hero — roughly 4.5x the caption size, which is what buys legibility from
 * fifteen feet away on a stage. Everything else is support.
 *
 * The reference clip renders as `children` INSIDE this panel; when it does, the
 * HUD collapses to a single row so there is still only one glass surface.
 *
 * Heart rate lives here and nowhere else, for two reasons. It is the one metric
 * that is conventionally red, and metric hues are legal only inside this panel.
 * And it is SIMULATED, so it carries that word on screen permanently — the panel
 * is the only place honest enough to put it.
 */
import type { ReactNode } from 'react'
import type { GetHeartRateResult } from '../types/tools'
import type { MicState } from '../coach/micUplink'
import type { TrackId } from '../coach/musicPlayer'
import { MicPill, MusicPill } from './StatusPills'

export type ConnState = 'idle' | 'connecting' | 'live' | 'error'

const CONN_LABEL: Readonly<Record<ConnState, string>> = {
  idle: 'STANDBY',
  connecting: 'CONNECTING',
  live: 'COACH LIVE',
  error: 'COACH DOWN',
}

/** HUD thresholds. Recalibrate here, nowhere else. */
const HUD = {
  HEALTHY_FPS: 18,
  /** Floor for the heartbeat animation, so a nonsense bpm cannot divide by zero. */
  MIN_ANIMATED_BPM: 30,
} as const

/** Fixed-width slot, so the row does not shift sideways as the trend changes. */
const TREND_GLYPH: Readonly<Record<GetHeartRateResult['trend'], string>> = {
  rising: '▲',
  steady: '·',
  falling: '▼',
}

function formatClock(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** One glyph pulse per beat: the animation period IS the measured bpm. */
function beatPeriod(bpm: number): string {
  const safe = Number.isFinite(bpm) && bpm > HUD.MIN_ANIMATED_BPM ? bpm : HUD.MIN_ANIMATED_BPM
  return `${(60 / safe).toFixed(3)}s`
}

interface HudProps {
  readonly target: number
  readonly totalReps: number
  readonly cleanReps: number
  readonly elapsedSec: number
  readonly fps: number
  /** The simulation's current reading, exactly as get_heart_rate reports it. */
  readonly heart: GetHeartRateResult
  readonly conn: ConnState
  readonly offline: boolean
  readonly inFrame: boolean
  /** Uplink health. Three states, because they mean three different things to a user. */
  readonly mic: MicState
  /** The track currently playing, or null. Renders nothing when null. */
  readonly musicTrack: TrackId | null
  readonly summary: string | null
  /** True while the reference clip occupies the panel. */
  readonly compact: boolean
  readonly children?: ReactNode
}

export default function Hud({
  target,
  totalReps,
  cleanReps,
  elapsedSec,
  fps,
  heart,
  conn,
  offline,
  inFrame,
  mic,
  musicTrack,
  summary,
  compact,
  children,
}: HudProps) {
  return (
    <section className="hud glass" data-compact={compact ? 'true' : 'false'} aria-label="Workout metrics">
      <div className="hud__row">
        <div className="hud__reps">
          <span className="hud__numeral">{totalReps}</span>
          <span className="hud__target">/{target}</span>
        </div>
        <dl className="hud__stats">
          <div className="hud__stat">
            <dt>CLEAN</dt>
            <dd className="hud__value hud__value--clean">{cleanReps}</dd>
          </div>
          <div className="hud__stat">
            <dt>TIME</dt>
            <dd className="hud__value">{formatClock(elapsedSec)}</dd>
          </div>
          <div className="hud__stat">
            <dt>FPS</dt>
            <dd className="hud__value" data-low={fps < HUD.HEALTHY_FPS ? 'true' : 'false'}>
              {Math.round(fps)}
            </dd>
          </div>
        </dl>
      </div>

      {/* `simulated` is `true` by type in GetHeartRateResult, so the word is not
          conditional — there is no reading of this metric that is not simulated. */}
      <dl className="hud__heart">
        <dt className="hud__heartLabel">
          HEART{' '}
          <span className="hud__heartSim">SIMULATED</span>
        </dt>
        <dd className="hud__heartValue">
          <span
            className="hud__heartGlyph"
            style={{ animationDuration: beatPeriod(heart.bpm) }}
            aria-hidden="true"
          >
            ♥
          </span>
          <span className="hud__heartBpm">{heart.bpm}</span>
          <span className="hud__heartUnit">BPM</span>
          <span className="hud__heartTrend" data-trend={heart.trend} role="img" aria-label={heart.trend}>
            {TREND_GLYPH[heart.trend]}
          </span>
        </dd>
      </dl>

      <div className="hud__strip">
        <span className="hud__conn" data-conn={conn}>
          <span className="hud__dot" aria-hidden="true" />
          {CONN_LABEL[conn]}
        </span>
        {/* Mic sits next to the connection state on purpose: both answer "can the
            coach reach me", and together they are the whole two-way status. */}
        <MicPill state={mic} />
        <MusicPill track={musicTrack} />
        {offline ? <span className="hud__badge hud__badge--offline">OFFLINE</span> : null}
        {inFrame ? null : <span className="hud__badge hud__badge--frame">OUT OF FRAME</span>}
      </div>

      {children}

      {summary ? <p className="hud__summary">SET LOGGED · {summary}</p> : null}
    </section>
  )
}
