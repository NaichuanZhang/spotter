/**
 * What the user actually did, in one glass panel — the ending screen's equivalent of
 * the HUD, and the reason the screen is complete with no video in it.
 *
 * HUE, per the doctrine at the top of styles.css: metric colours are legal because
 * this IS the glass panel; the fault chips are `--fault` because a fault is a fault;
 * no persona hue touches a numeral.
 *
 * ONE DELIBERATE EXCEPTION TO "CLEAN IS BLUE". When the body line was never
 * measurable, the clean count is rendered in plain ink instead of `--metric-clean`,
 * because a hue that means "good" next to a number that only means "nothing was
 * detected" is the exact lie by omission the honesty note underneath exists to stop.
 * The hue is a claim; it is withheld when the measurement was never made.
 */
import { FAULT_LABEL } from '../types/events'
import { bodyLineNote, formatClock } from './setSummary'
import type { SetSummary } from './setSummary'

interface EndingStatsProps {
  readonly summary: SetSummary
}

export default function EndingStats({ summary }: EndingStatsProps) {
  const note = bodyLineNote(summary)
  const verified = summary.coverage === 'seen'

  return (
    <section className="ending__panel glass" aria-label="Set result">
      <div className="ending__row">
        <div className="ending__reps">
          <span className="ending__numeral">{summary.reps}</span>
          <span className="ending__target">/{summary.target}</span>
        </div>
        <dl className="ending__stats">
          <div className="ending__stat">
            <dt>CLEAN</dt>
            <dd className="ending__value" data-verified={verified ? 'true' : 'false'}>
              {summary.cleanReps}
            </dd>
          </div>
          <div className="ending__stat">
            <dt>PARTIAL</dt>
            <dd className="ending__value" data-warn={summary.partialReps > 0 ? 'true' : 'false'}>
              {summary.partialReps}
            </dd>
          </div>
          <div className="ending__stat">
            <dt>TIME</dt>
            <dd className="ending__value">{formatClock(summary.elapsedSec)}</dd>
          </div>
          <div className="ending__stat">
            <dt>BEST DEPTH</dt>
            <dd className="ending__value">
              {summary.bestDepthPct}
              <span className="ending__unit">%</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Same permanent SIMULATED pill the HUD carries: there is no reading of this
          metric that is not simulated, so the word is not conditional. */}
      <dl className="ending__heart">
        <dt className="ending__heartLabel">
          PEAK HEART <span className="ending__heartSim">SIMULATED</span>
        </dt>
        <dd className="ending__heartValue">
          <span className="ending__heartBpm">{summary.peakBpm > 0 ? summary.peakBpm : '--'}</span>
          <span className="ending__heartUnit">BPM</span>
        </dd>
      </dl>

      <div className="ending__faults">
        <span className="ending__faultsLabel">FAULTS SEEN</span>
        {summary.faults.length === 0 ? (
          <span className="ending__faultsNone">NONE DETECTED</span>
        ) : (
          <ul className="ending__faultList">
            {summary.faults.map((fault) => (
              <li key={fault} className="ending__faultChip">
                {FAULT_LABEL[fault]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="ending__note" data-coverage={note.coverage}>
        <span className="ending__noteLabel">{note.label}</span>
        <span className="ending__noteDetail">{note.detail}</span>
      </p>
    </section>
  )
}
