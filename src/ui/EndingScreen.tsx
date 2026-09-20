/**
 * The third screen: what you did, what the coach makes of it, and one way onward.
 *
 * IT IS COMPLETE WITHOUT THE VIDEO, and that is the load-bearing design decision.
 * The stats panel and the closing words are the screen; the avatar verdict is a
 * 22-31 second render that arrives as a bonus beat, or never arrives at all. So:
 *   - no reserved empty square where a clip might go (the grid is one column until
 *     bytes exist, then two — the arrival is the only reflow),
 *   - no spinner standing in for content (one quiet line of caps, at most),
 *   - and on failure NOTHING is said on screen. It reads as a screen that was never
 *     going to have a video, which is kinder than a broken promise. The failure is
 *     not swallowed — useVerdict logs the code and the message.
 *
 * THE WORDS COME FROM THE SERVER, not from here. /api/verdict templates them from the
 * same stats in the same persona voice the avatar will speak, so the text on screen
 * and the text in the clip cannot drift. When the route cannot be reached at all the
 * headline falls back to a plain factual line — never to an invented coach character,
 * because a fabricated persona line is exactly the thing this product must not do.
 *
 * SOUND: the user clicked START, so the document is interacted-with and an audible
 * clip should play. A refusal lands on 'blocked', which restores the affordance and
 * says so, exactly as the intro screen does.
 */
import { useCallback, useMemo, useState } from 'react'
import type { PersonaId } from '../types/tools'
import { FINISH_LABEL } from './finishGate'
import { personaView } from './PersonaRail'
import EndingStats from './EndingStats'
import VerdictStage from './VerdictStage'
import { useVerdict } from './useVerdict'
import { verdictRequestFrom } from './verdictClient'
import type { SetSummary } from './setSummary'

interface EndingScreenProps {
  readonly summary: SetSummary
  readonly persona: PersonaId
  readonly onAgain: () => void
}

const BLOCKED_MESSAGE = 'Your browser held the sound back — tap to hear your coach.'

/** Shown while the render is out. One line, never the main event. */
const RENDERING_HINT = 'Your coach is recording a verdict'

/** No coach words reached us. Factual, never in character. */
function plainHeadline(summary: SetSummary): string {
  if (summary.reps === 0) return 'No reps this time.'
  return `${summary.reps} rep${summary.reps === 1 ? '' : 's'} down.`
}

export default function EndingScreen({ summary, persona, onAgain }: EndingScreenProps) {
  const [sound, setSound] = useState<'on' | 'blocked'>('on')
  const coach = personaView(persona)

  // Identity IS the trigger for the render, so it must change once per set, not once
  // per commit. Persona is frozen while this screen is up (App ignores the 1/2/3
  // hotkeys here) — the verdict belongs to the coach that took the set.
  const request = useMemo(() => verdictRequestFrom(summary, persona), [summary, persona])
  const verdict = useVerdict(request)

  const requestSound = useCallback(() => setSound('on'), [])
  const refuseSound = useCallback(() => setSound('blocked'), [])

  const words = verdict.words
  const showHint = verdict.phase === 'working' && verdict.clip === null

  return (
    <main className="ending">
      <div className="ending__atmos" aria-hidden="true" />

      <div className="ending__shell">
        <p className="ending__eyebrow">
          <span className="ending__eyebrowDot" aria-hidden="true" />
          {FINISH_LABEL[summary.reason]} · {coach.name}
        </p>

        {words ? (
          <blockquote className="ending__words">{words}</blockquote>
        ) : (
          <p className="ending__words ending__words--plain">{plainHeadline(summary)}</p>
        )}

        <div className="ending__body" data-clip={verdict.clip ? 'true' : 'false'}>
          <EndingStats summary={summary} />

          {verdict.clip ? (
            <VerdictStage
              src={verdict.clip}
              coachName={coach.name}
              audible={sound === 'on'}
              onSoundRequest={requestSound}
              onSoundRefused={refuseSound}
              voice={verdict.meta?.voice ?? null}
              renderMs={verdict.meta?.renderMs ?? 0}
            />
          ) : null}
        </div>

        <div className="ending__actions">
          <button type="button" className="ending__cta" onClick={onAgain}>
            <span>Go again</span>
            <span className="ending__ctaArrow" aria-hidden="true">
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
          <p className="ending__hint" role="status" aria-live="polite">
            {sound === 'blocked'
              ? BLOCKED_MESSAGE
              : showHint
                ? RENDERING_HINT
                : 'Counters reset to zero and the camera restarts.'}
          </p>
        </div>
      </div>
    </main>
  )
}
