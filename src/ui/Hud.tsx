/**
 * The glass HUD: the only place in the app where a metric may carry hue.
 *
 * Top-left of the workout screen, one panel, never two. The rep numeral is the
 * hero — roughly 4.5x the caption size, which is what buys legibility from
 * fifteen feet away on a stage. Everything else is support.
 *
 * The reference clip renders as `children` INSIDE this panel; when it does, the
 * HUD collapses to a single row so there is still only one glass surface.
 */
import type { ReactNode } from 'react'

export type ConnState = 'idle' | 'connecting' | 'live' | 'error'

const CONN_LABEL: Readonly<Record<ConnState, string>> = {
  idle: 'STANDBY',
  connecting: 'CONNECTING',
  live: 'COACH LIVE',
  error: 'COACH DOWN',
}

/** HUD thresholds. Recalibrate here, nowhere else. */
const HUD = { HEALTHY_FPS: 18 } as const

function formatClock(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface HudProps {
  readonly target: number
  readonly totalReps: number
  readonly cleanReps: number
  readonly elapsedSec: number
  readonly fps: number
  readonly conn: ConnState
  readonly offline: boolean
  readonly inFrame: boolean
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
  conn,
  offline,
  inFrame,
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

      <div className="hud__strip">
        <span className="hud__conn" data-conn={conn}>
          <span className="hud__dot" aria-hidden="true" />
          {CONN_LABEL[conn]}
        </span>
        {offline ? <span className="hud__badge hud__badge--offline">OFFLINE</span> : null}
        {inFrame ? null : <span className="hud__badge hud__badge--frame">OUT OF FRAME</span>}
      </div>

      {children}

      {summary ? <p className="hud__summary">SET LOGGED · {summary}</p> : null}
    </section>
  )
}
