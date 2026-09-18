/**
 * The intro's left column: what SPOTTER is, what it measures, and the one button
 * that enters the workout.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. THE NUMBERS ARE HONEST. Every figure on the spec row is measured or counted.
 *    596 ms is the live rep-to-first-audio measurement (596 / 619 ms, 2026-09-18);
 *    the landmark count is imported from the pose package rather than typed out;
 *    the coach count is the length of the persona list; the rep count is the
 *    target the shell actually runs. Nothing here is a marketing number, and
 *    nothing measures anything we do not measure.
 * 2. START IS ONE DELIBERATE CLICK. `onStart` is wired straight to the button with
 *    no wrapper, because App unlocks the AudioContext inside that handler and a
 *    gesture that has been through a setTimeout or a promise is no longer a gesture.
 */
import { LANDMARK_COUNT } from '../pose/landmarks'
import { PERSONA_ORDER } from './PersonaRail'
import { REVEAL_MS, revealAt } from './introMotion'

/** Measured live, browser to first audio sample: 596 / 619 ms on two runs. */
const REP_TO_REPLY_MS = 596

/** Each line is its own clipping mask, so the rag is a decision and not a wrap. */
const HEADLINE: readonly string[] = ['Your coach', 'can actually', 'see you.']

interface Spec {
  readonly label: string
  readonly value: string
  readonly unit?: string
}

const SPECS: readonly Spec[] = [
  { label: 'Rep to reply', value: String(REP_TO_REPLY_MS), unit: 'ms' },
  { label: 'Coaches', value: String(PERSONA_ORDER.length) },
  { label: 'Pose landmarks', value: String(LANDMARK_COUNT), unit: 'pts' },
]

interface IntroLedeProps {
  readonly target: number
  readonly onStart: () => void
  /** Sound state in words. Empty string = nothing to say, so nothing is shown. */
  readonly status: string
}

export default function IntroLede({ target, onStart, status }: IntroLedeProps) {
  return (
    <div className="copy">
      <p className="eyebrow" data-reveal="" style={revealAt(REVEAL_MS.eyebrow)}>
        <em>AI pushup coach</em>
        <i />
        Three personalities
      </p>

      <h1 className="headline">
        {HEADLINE.map((line, index) => (
          <span
            key={line}
            className={index === HEADLINE.length - 1 ? 'line line--accent' : 'line'}
          >
            <span style={revealAt(REVEAL_MS.headline[index] ?? 0)}>{line}</span>
          </span>
        ))}
      </h1>

      <p className="deck" data-reveal="" style={revealAt(REVEAL_MS.deck)}>
        Your webcam measures depth, lockout and hip line thirty times a second. The coach answers
        out loud in under a second — and <b>which</b> coach you pick changes every word of it.
      </p>

      <div className="actions" data-reveal="" style={revealAt(REVEAL_MS.actions)}>
        <button type="button" className="cta" onClick={onStart}>
          <span>Start workout</span>
          <span className="cta__arrow" aria-hidden="true">
            <svg viewBox="0 0 12 12" fill="none">
              <path
                d="M1 6h9M6.5 2.2 10.3 6l-3.8 3.8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        <p className="metaline">
          <span>{target} reps</span>
          <span>camera stays on your device</span>
          <span>press ? for demo keys</span>
        </p>

        <p className="status" role="status" aria-live="polite" data-on={status ? 'true' : 'false'}>
          {status}
        </p>
      </div>

      <dl className="specs" data-reveal="" style={revealAt(REVEAL_MS.specs)}>
        {SPECS.map((spec) => (
          // column-reverse in CSS: the DOM keeps dt-then-dd, the eye gets value-then-label.
          <div className="spec" key={spec.label}>
            <dt className="spec__k">{spec.label}</dt>
            <dd className="spec__v">
              {spec.value}
              {spec.unit ? <span className="spec__u">{spec.unit}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
