/**
 * Mic and music indicators for the HUD status strip.
 *
 * They live in the strip, beside COACH LIVE, because that is the row this design
 * system already reserves for "what is the machine doing" — the same peer group as
 * the connection state, OFFLINE and OUT OF FRAME. That placement is also what keeps
 * them SUBORDINATE: 10px uppercase against the ~104px rep numeral, which stays the
 * only thing the eye lands on from fifteen feet away.
 *
 * ── WHY THE MIC HAS THREE STATES AND NOT TWO ────────────────────────────────
 * To a user on the floor, "not hearing you" has three completely different meanings
 * and only one of them is a problem:
 *
 *   LISTENING  the gate is open and buffers are going upstream — talk now.
 *   MIC MUTED  the coach is speaking, so the uplink is deliberately closed. EXPECTED,
 *              not an error: the mic is shut so the model cannot hear itself through
 *              the speakers and answer its own voice. Styled neutral for that reason.
 *   MIC OFF    there is no microphone, or permission was refused. The only one that
 *   MIC DENIED is degraded, so it is the only one that carries a warning hue — amber,
 *              not --fault, because the app still works: the pose-driven coaching is
 *              unaffected and only the talking-back half is missing.
 *
 * --fault is deliberately NOT used here. It is the truth colour for a form fault, and
 * a red pill in the HUD while someone is mid-set would read as "your form is wrong".
 */
import type { MicState } from '../coach/micUplink'
import { MUSIC_CONFIG } from '../coach/musicPlayer'
import type { TrackId } from '../coach/musicPlayer'

export type MicIndicator = 'listening' | 'muted' | 'off'

/**
 * RMS thresholds for the three meter segments, on the same 0..1 scale as
 * AUDIO_IN_CONFIG.silenceFloor (0.004). The first segment lights just above that
 * floor, so a user who is speaking at all sees something move — the whole purpose of
 * the meter is answering "is it hearing me?" without waiting for the coach to reply.
 */
export const MIC_METER_STEPS: readonly number[] = Object.freeze([0.006, 0.03, 0.12])

export function micIndicator(state: MicState): MicIndicator {
  if (state.error !== null || !state.capturing) return 'off'
  return state.gated ? 'muted' : 'listening'
}

export function micLabel(state: MicState): string {
  const indicator = micIndicator(state)
  if (indicator === 'listening') return 'LISTENING'
  if (indicator === 'muted') return 'MIC MUTED'
  return state.error?.code === 'mic_denied' ? 'MIC DENIED' : 'MIC OFF'
}

/**
 * The full failure message, for a hover and for screen readers. A denied mic that
 * explains itself is the difference between a fixable demo and a mystery.
 */
export function micDetail(state: MicState): string {
  if (state.error) return state.error.message
  const indicator = micIndicator(state)
  if (indicator === 'listening') return 'Microphone is open — the coach can hear you.'
  if (indicator === 'muted') return 'Microphone is muted while the coach speaks.'
  return 'Microphone is not running.'
}

export function MicPill({ state }: { readonly state: MicState }) {
  const indicator = micIndicator(state)
  return (
    <span className="hud__mic" data-mic={indicator} title={micDetail(state)}>
      <span className="hud__micMeter" aria-hidden="true">
        {MIC_METER_STEPS.map((threshold) => (
          <span
            key={threshold}
            className="hud__micBar"
            data-lit={indicator === 'listening' && state.level >= threshold ? 'true' : 'false'}
          />
        ))}
      </span>
      <span className="hud__micLabel">{micLabel(state)}</span>
      {/* The label is an abbreviation on screen; the sentence is what gets read out. */}
      <span className="hud__srOnly">{micDetail(state)}</span>
    </span>
  )
}

/** Renders nothing at all when no track is on — an idle indicator is just noise. */
export function MusicPill({ track }: { readonly track: TrackId | null }) {
  if (!track) return null
  return (
    <span className="hud__music" title={`${MUSIC_CONFIG.tracks[track].label} is playing`}>
      <span aria-hidden="true">♪</span>
      {MUSIC_CONFIG.tracks[track].label.toUpperCase()}
    </span>
  )
}
