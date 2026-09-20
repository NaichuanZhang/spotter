/**
 * HOW MUCH THE COACH TALKS — the one place to tune it, BY EAR.
 *
 * The problem this file exists for, in the user's words: "on every rep, coach speaks too
 * eager, probably due to the data streaming in, anyway to tune this behavior and actually
 * leave room for user to speak?"
 *
 * That is one bug wearing two hats. Every scored rep used to be pushed to the model as a
 * synthetic user turn, and reps land every 2-3 seconds, so the coach talked essentially
 * without stopping. And the mic uplink is HALF-DUPLEX on purpose — `micUplink`'s gate is
 * `() => !audio.isSpeaking()`, because the microphone hears the same speakers the coach
 * plays through and an open gate makes the model answer its own voice. Multiply the two
 * and the gate is almost never open, so there is no such thing as the user getting a word
 * in. Talking less IS how two-way conversation gets restored; they are not two features.
 *
 * WHAT IS DELIBERATELY NOT HERE. No second rate limiter. Selection still runs through
 * `canSpeak` / `noteUtterance` / `UTTERANCE_RANK` in src/pose/faults.ts, so a severe fault
 * can still pre-empt a routine rep callout and every rank stays comparable with every
 * other. The knobs below only NARROW that gate; none of them widens it.
 *
 * The AI-facing wording of a callout lives in `REP_CALLOUT_LINE` (repCallout.ts), not here:
 * these are numbers you turn, those are sentences the model quotes back.
 *
 * Every comment says what RAISING or LOWERING the value does to what a person in the room
 * hears, because that is the only way any of it can be judged.
 *
 * ── MEASURED: WHICH KNOB ACTUALLY BINDS ──────────────────────────────────────────────
 *
 * Simulated 20-rep set, one rep every 2.5s (50s of reps), driven through the real session
 * by `src/coach/__tests__/repCadence.test.ts`. One utterance = **5.55s** of audio, which is
 * MEASURED live, not assumed: six real rep-callout lines through Mean's real prompt and
 * voice returned 4.89 / 5.75 / 6.39 / 5.14 / 5.46 / 5.68s of 24 kHz PCM16. Untrimmed on
 * purpose — `audioOut.isSpeaking()` is `queuedSec() > 0`, so an utterance's padding silence
 * holds the mic gate shut exactly as its speech does.
 *
 *   BEFORE (every rep pushed)   20 utterances   111.0s audio   97.8% speaking
 *   AFTER  (shipped tuning)      5 utterances    27.5s audio   55.0% speaking
 *
 * The two knobs below are NOT independent, and this is the thing to know before turning
 * either. `repCadence` sets the floor on a CLEAN set; `listenWindowMs` sets the ceiling once
 * faults and notable reps start competing for the bucket. Utterances over the same set:
 *
 *   repCadence  (window 3500)    3 → 5    4 → 5    5 → 4    6 → 4    8 → 3
 *   listenWindow (cadence 4)     0 → 5    1500 → 5    3500 → 5    5000 → 4    6500 → 4
 *   ...and with a MINOR fault on every rep, where the window is what holds the line:
 *   listenWindow (cadence 4)     0 → 7    1500 → 7    3500 → 5    5000 → 4    6500 → 4
 *
 * So raising `repCadence` from 3 to 4 changes NOTHING at the shipped window — 5.55s of audio
 * plus 3500ms of silence is already ~3.6 reps of enforced quiet. If the coach still feels
 * pushy, `listenWindowMs` is the knob with leverage; `repCadence` only helps once it is above
 * what the window already enforces.
 */

import { GATE_CONFIG, UTTERANCE_RANK } from '../pose/faults'

export const SPEECH_TUNING = {
  /**
   * Speak on every Nth rep when nothing more interesting happened.
   *
   * RAISE IT (6, 8) if the middle of a set still feels chatty — the coach then only marks
   * milestones and notable reps. LOWER IT (2, 3) if a set feels lonely and you want a
   * running commentary again. 1 restores the old behaviour of narrating every single rep,
   * which is the bug this file exists to fix.
   *
   * MEASURED CAVEAT (see the sweep in the file header): at the shipped `listenWindowMs` this
   * knob does nothing below 5, because the window already enforces a longer gap than a
   * 4-rep cadence does. Turn `listenWindowMs` first.
   *
   * Counted from the last rep the coach actually SPOKE about, not from the last rep
   * performed, so a callout swallowed by the listen window is retried on the next rep
   * rather than skipped for another four.
   */
  repCadence: 4,

  /**
   * How many reps before the target start earning a callout of their own ("two to go").
   *
   * RAISE IT for a bigger, louder finish; LOWER IT (or 0) if the end of the set feels like
   * a countdown you did not ask for. Note the listen window still applies to these, so in
   * practice one or two of the final stretch land rather than all of them.
   */
  finalStretchReps: 3,

  /**
   * Whether hitting the target is allowed to interrupt the listen window.
   *
   * TRUE (default) because finishing the set is the single most important thing the coach
   * says and there is no second chance to say it — every other callout is retried on the
   * next rep, this one is not. Set FALSE if you would rather the coach never cut in at all,
   * accepting that the moment the set is finished can pass in silence.
   */
  callTargetReached: true,

  /**
   * THE LISTEN WINDOW. Silence held open after the coach's audio has finished DRAINING —
   * not after the event was pushed, and not after `response.done`, which fires while
   * seconds of audio are still scheduled. Nothing below `windowBreakMinRank` is pushed
   * during it, so `micUplink`'s gate is open and the user has a real chance to talk.
   *
   * RAISE THIS FIRST if you still cannot get a word in — measured, it is the knob with the
   * leverage: 5000 takes a clean set from 5 utterances to 4 and a fault-on-every-rep set
   * from 5 to 4, where `repCadence` alone cannot move either. LOWER IT (1500) if the coach
   * feels absent or slow to react. 0 turns the window off entirely and hands pacing back to
   * the utterance bucket alone (`GATE_CONFIG.globalIntervalMs`), which is the behaviour that
   * was too eager — and measured, 0 is what lets a minor fault on every rep push the coach
   * back up to 7 utterances and 72.6% of the set.
   */
  listenWindowMs: 3500,

  /**
   * The lowest utterance rank allowed to speak INSIDE the listen window.
   *
   * `severe` — only a safety-grade fault (a back collapsing, a rep 45 degrees short of
   * lockout) interrupts the user's turn. Everything else waits, including every rep
   * callout. LOWER IT to `major` if you want ordinary form faults to cut in sooner, at the
   * cost of the silence the user speaks into.
   *
   * It cannot be raised above `severe` or lowered to `routine` — see
   * `validateSpeechTuning`. A window a rep callout may break is not a window.
   */
  windowBreakMinRank: UTTERANCE_RANK.severe,

  /**
   * The lowest rank allowed to CUT THE COACH OFF mid-line, i.e. to pre-empt inside
   * `GATE_CONFIG.globalIntervalMs` (3000ms) instead of waiting it out.
   *
   * This is the knob for the coach interrupting ITSELF. A partial rep emits a rep callout
   * and a `partial_depth` fault from the same frame; at `minor` the fault barged in on a
   * sentence that had just started and said the same thing twice. At `major` the ordinary
   * duplicate waits (and is usually dropped, since the rep line already says "PARTIAL"),
   * while a genuinely severe fault still lands immediately.
   *
   * RAISE IT to `severe` if the coach still talks over itself. LOWER IT to `minor` to
   * restore the old always-pre-empt behaviour. Like the window rank it may not exceed
   * `severe`: a severe fault must ALWAYS be able to pre-empt a routine callout, which is
   * the whole reason the ranks exist.
   */
  preemptMinRank: UTTERANCE_RANK.major,

  /**
   * Extra silence after the server reports the user STOPPED talking, on top of whatever
   * the coach's own reply then occupies. The server's VAD end-points a turn ~570ms after
   * the last real mic buffer (measured), so this is the margin for a user who pauses
   * mid-thought and carries on.
   *
   * RAISE IT if the coach steps on the end of your sentences; LOWER IT if it feels slow to
   * answer a question.
   */
  userTurnGraceMs: 1500,

  /**
   * The rank a user turn — typed or spoken — occupies in the shared bucket, so pose events
   * cannot trample the coach's ANSWER to the user.
   *
   * `major`: only a severe fault interrupts an answer. LOWER IT to `minor` if you would
   * rather form faults always win over conversation; RAISE IT to `severe` to make an answer
   * uninterruptible.
   */
  userTurnRank: UTTERANCE_RANK.major,

  /**
   * How many silently-counted reps it takes before the next callout MENTIONS them as a
   * group ("three more, all clean") instead of talking only about the newest rep.
   *
   * This is what keeps a backlog from becoming a queue: reps the coach stayed quiet for are
   * never spoken one by one, they are collapsed into the next line it was going to say
   * anyway. RAISE IT if the catch-up clause feels like nagging; LOWER IT to 1 if the coach
   * feels like it lost count of the set.
   */
  mentionSilentRepsFrom: 2,

  /**
   * Percentage points of depth a rep must beat the set's best by to count as a NEW BEST and
   * earn a callout on its own.
   *
   * RAISE IT if the coach keeps congratulating reps that look the same as the last one;
   * LOWER IT if a genuinely deeper rep goes unremarked. Depth is capped at 100%, so once a
   * user is bottoming out this stops firing by itself.
   */
  newBestDepthPct: 4,

  /**
   * Fractional change in a rep's total duration that counts as a BIG tempo change —
   * 0.3 means 30% faster or slower than the previous rep.
   *
   * LOWER IT (0.15) to have the coach notice fatigue earlier; RAISE IT (0.5) if it keeps
   * remarking on ordinary rep-to-rep variation, which on real footage is wide.
   */
  tempoShiftRatio: 0.3,

  /**
   * Reps shorter than this (descent + ascent) are not compared for tempo at all. Below
   * about half a second the timing is dominated by frame quantisation, and "you sped up
   * 40%" would be a claim about noise. Raise it if tempo callouts feel random.
   */
  tempoFloorMs: 500,
} as const

/** Same shape widened to plain numbers, so a candidate set can be checked. */
export type SpeechTuning = {
  readonly repCadence: number
  readonly finalStretchReps: number
  readonly callTargetReached: boolean
  readonly listenWindowMs: number
  readonly windowBreakMinRank: number
  readonly preemptMinRank: number
  readonly userTurnGraceMs: number
  readonly userTurnRank: number
  readonly mentionSilentRepsFrom: number
  readonly newBestDepthPct: number
  readonly tempoShiftRatio: number
  readonly tempoFloorMs: number
}

/**
 * Fails fast on a tuning set that has been turned into a contradiction. Called at module
 * load, the same contract as `validateRepThresholds` and `validateFaultThresholds`: these
 * are frozen constants, so this can only fire just after a human moved one by ear — which
 * is exactly when a loud failure beats a coach that has quietly gone mute or deaf.
 */
export function validateSpeechTuning(t: SpeechTuning = SPEECH_TUNING): void {
  const problems: string[] = []
  if (!Number.isInteger(t.repCadence) || t.repCadence < 1) {
    problems.push(`repCadence (${t.repCadence}) must be a whole number of reps, at least 1`)
  }
  if (!Number.isInteger(t.finalStretchReps) || t.finalStretchReps < 0) {
    problems.push(`finalStretchReps (${t.finalStretchReps}) must be a whole number, at least 0`)
  }
  if (!Number.isFinite(t.listenWindowMs) || t.listenWindowMs < 0) {
    problems.push(`listenWindowMs (${t.listenWindowMs}) must be a non-negative number of ms`)
  }
  if (!Number.isFinite(t.userTurnGraceMs) || t.userTurnGraceMs < 0) {
    problems.push(`userTurnGraceMs (${t.userTurnGraceMs}) must be a non-negative number of ms`)
  }
  problems.push(...rankProblems(t))
  if (!Number.isInteger(t.mentionSilentRepsFrom) || t.mentionSilentRepsFrom < 1) {
    problems.push(`mentionSilentRepsFrom (${t.mentionSilentRepsFrom}) must be at least 1`)
  }
  if (!Number.isFinite(t.newBestDepthPct) || t.newBestDepthPct < 0) {
    problems.push(`newBestDepthPct (${t.newBestDepthPct}) must be a non-negative percentage`)
  }
  if (!(t.tempoShiftRatio > 0)) {
    problems.push(`tempoShiftRatio (${t.tempoShiftRatio}) must be positive; 0 would flag every rep`)
  }
  if (!(t.tempoFloorMs > 0)) {
    problems.push(`tempoFloorMs (${t.tempoFloorMs}) must be positive`)
  }
  if (problems.length > 0) {
    throw new Error(`SPEECH_TUNING is inconsistent:\n - ${problems.join('\n - ')}`)
  }
}

/**
 * The two rank floors are the invariant that keeps severity meaningful. Above `severe`
 * nothing could ever interrupt anything, so a collapsing back would wait behind "nice rep";
 * at `routine` a rep callout could break the listen window, which is not a window at all.
 */
function rankProblems(t: SpeechTuning): string[] {
  const out: string[] = []
  const floors: [name: string, value: number][] = [
    ['windowBreakMinRank', t.windowBreakMinRank],
    ['preemptMinRank', t.preemptMinRank],
  ]
  for (const [name, value] of floors) {
    if (value > UTTERANCE_RANK.severe) {
      out.push(
        `${name} (${value}) must not exceed UTTERANCE_RANK.severe (${UTTERANCE_RANK.severe}) — ` +
          'a severe fault has to stay able to interrupt, on safety grounds',
      )
    }
    if (value <= UTTERANCE_RANK.routine) {
      out.push(
        `${name} (${value}) must be above UTTERANCE_RANK.routine (${UTTERANCE_RANK.routine}), ` +
          'otherwise an ordinary rep callout can interrupt and the brake does nothing',
      )
    }
  }
  if (t.userTurnRank < UTTERANCE_RANK.routine || t.userTurnRank > UTTERANCE_RANK.severe) {
    out.push(
      `userTurnRank (${t.userTurnRank}) must be a real UTTERANCE_RANK value ` +
        `(${UTTERANCE_RANK.routine}..${UTTERANCE_RANK.severe})`,
    )
  }
  return out
}

validateSpeechTuning()

/**
 * Re-exported so callers tuning this file can see the interval they are working against
 * without importing from src/pose. It is NOT a knob here: it belongs to the fault gate,
 * and the point of this module is that there is only one bucket.
 */
export const SHARED_UTTERANCE_INTERVAL_MS: number = GATE_CONFIG.globalIntervalMs
