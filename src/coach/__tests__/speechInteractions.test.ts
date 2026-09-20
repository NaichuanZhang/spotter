/**
 * WHERE THE TWO BRAKES MEET. The cases neither the speech policy nor barge-in can be tested
 * for alone, because each one is the other's input.
 *
 * `speechPolicy.test.ts` owns the listen window. `bargeIn.test.ts` owns the detector.
 * `bargeInWiring.test.ts` owns whether the session arms it at all. None of them can answer
 * these two, and both are the kind of thing that deadlocks a demo rather than merely sounding
 * wrong:
 *
 *   1. A SEVERE FAULT ARRIVES DURING A LISTEN WINDOW. The window exists so the user can talk;
 *      a collapsing back is the one thing allowed to break it (`windowBreakMinRank: severe`).
 *      So it must speak — and exactly once, because the same frame can propose a rep callout
 *      and a fault, and the pre-emption floor exists because that used to make the coach cut
 *      ITSELF off and say the same thing twice.
 *   2. THE USER BARGES IN WHILE A ROUTINE CALLOUT IS BEING WITHHELD. This is the state the two
 *      features create together and neither creates alone: the coach is mid-utterance, a rep
 *      has just been suppressed, and the user starts talking over it. The failure modes are a
 *      DEADLOCK (nothing can ever speak again, because the interrupt left a drain time in the
 *      future or the bucket claimed) and a DOUBLE-SPEAK (the withheld rep surfaces as its own
 *      sentence the moment the coach is silenced, so interrupting the coach makes it say MORE).
 *
 * The withheld rep is the interesting half. It must not come back as a line of its own — it is
 * a TALLY, not a queue — but it must not vanish from the coach's account of the set either. The
 * assertion is therefore both: no extra utterance, and the digest clause present on the next
 * line the coach was going to say anyway.
 */

import { describe, expect, it } from 'vitest'
import { createCoachSession } from '../session'
import { BARGE_IN_TUNING } from '../bargeIn'
import { SPEECH_TUNING } from '../speechTuning'
import { REP_CALLOUT_LINE } from '../repCallout'
import type { AudioIn, AudioInOptions } from '../audioIn'
import type { AudioOut } from '../audioOut'
import type { CoachEvent } from '../../types/events'
import { faultEvent, FakeSocket, flush, repEvent, replay, tokenFetch, UTTERANCE_SEC } from './setReplay'

// ---------------------------------------------- 1. a severe fault inside the listen window

describe('a severe fault arriving DURING a listen window', () => {
  /**
   * Rep 1 always speaks ('first'), so everything within `listenWindowMs` of its audio draining
   * is inside a window by construction. The fault is placed one second after the push, i.e.
   * deep inside the 5.55 s of audio — the hardest position, because the coach is still audible.
   */
  const REP_AT = 1_000
  const FAULT_AT = REP_AT + 1_000

  it('breaks the window and speaks, rather than waiting for the user who is not talking', async () => {
    const withFault: CoachEvent[] = [repEvent(1, REP_AT), faultEvent('severe', FAULT_AT)]
    const quiet: CoachEvent[] = [repEvent(1, REP_AT)]

    const loud = await replay({ events: withFault, endMs: 30_000, throttled: true })
    const base = await replay({ events: quiet, endMs: 30_000, throttled: true })

    // The fault is heard, and it is the ONLY extra thing heard.
    expect(loud.utterances).toBe(base.utterances + 1)
    expect(loud.lines.some((line) => line.includes('sagging_hips'))).toBe(true)
  })

  it('speaks it ONCE, even when a rep callout is proposed from the same instant', async () => {
    // The double-speak case the pre-emption floor exists for: a partial rep emits a rep callout
    // and a fault from the same frame, at the same millisecond.
    const events: CoachEvent[] = [
      repEvent(1, REP_AT),
      repEvent(2, FAULT_AT, { partial: true, clean: false, depthPct: 41 }),
      faultEvent('severe', FAULT_AT),
    ]
    const result = await replay({ events, endMs: 30_000, throttled: true })

    const sagLines = result.lines.filter((line) => line.includes('sagging_hips'))
    expect(sagLines).toHaveLength(1)
    // And nothing was said twice, whatever it was.
    expect(new Set(result.lines).size).toBe(result.lines.length)
  })

  it('does not deadlock: ordinary reps resume speaking afterwards', async () => {
    const events: CoachEvent[] = [repEvent(1, REP_AT), faultEvent('severe', FAULT_AT)]
    // Ten more reps at a realistic cadence, long after the fault.
    for (let n = 2; n <= 11; n += 1) events.push(repEvent(n, 20_000 + n * 2_500))

    const result = await replay({ events, endMs: 60_000, throttled: true })
    const afterFault = result.lines.filter((line) => line.includes('rep '))
    // The coach is still talking about reps after the severe interruption, and still not about
    // all of them — the brake survived the pre-emption rather than being cleared by it.
    expect(afterFault.length).toBeGreaterThan(1)
    expect(result.utterances).toBeLessThan(events.length)
  })
})

// ------------------------------------- 2. a barge-in during a withheld routine rep callout

/** Past the echo-guarded bar, so the trigger is not suppressed as suspected echo. */
const VOICE_LEVEL = 0.9
/** One audioIn buffer at the shipped bufferSize, in ms — the step the detector expects. */
const BUFFER_MS = 85

interface BargeRig {
  push(event: CoachEvent): void
  /** Advances the injected clock, sampling nothing — the coach's audio drains against it. */
  advance(ms: number): void
  /** Talks over the coach for `count` buffers, mirroring audioIn's real per-buffer order. */
  talk(count: number): void
  utterances(): number
  lines(): string[]
  appends(): number
  coachSpeaking(): boolean
  stops(): number
}

/**
 * The real `createCoachSession` with BOTH halves live: the speech policy deciding what to push,
 * and the mic uplink with barge-in armed. Everything runs on one injected clock, which is only
 * possible because the session now passes its `now` into the uplink — see `bargeInWiring.test.ts`.
 */
async function bargeRig(): Promise<BargeRig> {
  let clock = 0
  let audioUntil = 0
  let stops = 0
  const queuedSec = () => Math.max(0, audioUntil - clock) / 1000

  const audio: AudioOut = {
    unlock: () => Promise.resolve(),
    unlocked: () => true,
    enqueue: () => {},
    stop: () => {
      stops += 1
      audioUntil = clock
    },
    isSpeaking: () => queuedSec() > 0,
    level: () => 0,
    queuedSec,
    setEmphasis: () => {},
    close: () => Promise.resolve(),
  }

  let captured: AudioInOptions | null = null
  const sockets: FakeSocket[] = []
  const session = createCoachSession({
    persona: 'mean',
    now: () => clock,
    audio,
    createAudioIn: (options: AudioInOptions): AudioIn => {
      captured = options
      return {
        start: () => Promise.resolve(),
        stop: () => {},
        level: () => 0,
        isCapturing: () => true,
        isGated: () => !options.gateOpen(),
      }
    },
    socket: {
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.onopen?.())
        return socket as unknown as WebSocket
      },
      fetchImpl: tokenFetch,
    },
  })

  const connecting = session.connect()
  await flush()
  const socket = sockets[0]!
  socket.emit({ type: 'session.created' })
  await connecting
  // `connect` fires `startMic()` fire-and-forget; let it install the audioIn.
  await flush()

  const mic = captured as AudioInOptions | null
  if (mic === null) throw new Error('the session never constructed an audioIn')

  const lines: string[] = []
  let seen = socket.sent.length

  function answer(): void {
    const fresh = socket.sent.slice(seen)
    seen = socket.sent.length
    for (const frame of fresh) {
      if (frame.type === 'conversation.item.create') {
        const item = frame.item as { content?: { text?: unknown }[] } | undefined
        const text = item?.content?.[0]?.text
        if (typeof text === 'string') lines.push(text)
        continue
      }
      if (frame.type !== 'response.create') continue
      audioUntil = Math.max(audioUntil, clock) + UTTERANCE_SEC * 1000
      socket.emit({ type: 'response.output_audio.done' })
      socket.emit({ type: 'response.done' })
      seen = socket.sent.length
    }
  }

  return {
    push: (event) => {
      session.pushEvent(event)
      answer()
    },
    advance: (ms) => {
      clock += ms
    },
    talk: (count) => {
      for (let i = 0; i < count; i += 1) {
        clock += BUFFER_MS
        // audioIn's real order: gate, monitor, RE-CONSULT the gate, then chunk.
        const shut = !mic.gateOpen()
        mic.onBuffer?.({ level: VOICE_LEVEL, gated: shut, takeBase64: () => 'QUJD' })
        if (shut && !mic.gateOpen()) continue
        mic.onChunk('QUJD')
      }
      answer()
    },
    utterances: () => lines.length,
    lines: () => [...lines],
    appends: () =>
      socket.sent.filter((frame) => frame.type === 'input_audio_buffer.append').length,
    coachSpeaking: () => audio.isSpeaking(),
    stops: () => stops,
  }
}

describe('the user barges in while a routine rep callout is being withheld', () => {
  /** Enough buffers to clear `holdMs` (250 ms) with margin at ~85 ms each. */
  const TALKING_BUFFERS = 8

  it('sets the scene: rep 1 speaks, rep 2 is withheld, the coach is still audible', async () => {
    const rig = await bargeRig()
    rig.advance(1_000)
    rig.push(repEvent(1, 1_000))
    expect(rig.utterances()).toBe(1)

    rig.advance(2_500)
    rig.push(repEvent(2, 3_500))
    // Withheld, not queued — and still audible, which is what makes barge-in the only way in.
    expect(rig.utterances()).toBe(1)
    expect(rig.coachSpeaking()).toBe(true)
  })

  it('cuts the coach off and transmits the user, without the withheld rep double-speaking', async () => {
    const rig = await bargeRig()
    rig.advance(1_000)
    rig.push(repEvent(1, 1_000))
    rig.advance(2_500)
    rig.push(repEvent(2, 3_500))
    const before = rig.utterances()

    rig.talk(TALKING_BUFFERS)

    // The interruption worked: coach silenced, user's audio on the wire.
    expect(rig.stops()).toBeGreaterThan(0)
    expect(rig.coachSpeaking()).toBe(false)
    expect(rig.appends()).toBeGreaterThan(0)
    // THE DOUBLE-SPEAK CHECK. Silencing the coach must not release the withheld rep as its own
    // line — interrupting the coach cannot be what makes it say more.
    expect(rig.utterances()).toBe(before)
  })

  /**
   * Sets the scene for the two cases below: rep 1 spoken, rep 2 withheld, user barges in.
   * `lastSpokenRep` is therefore 1, and `repCadence` is counted from THAT — so the next rep
   * that can earn a cadence callout is rep 5 (5 - 1 >= 4), not the next rep to arrive. Getting
   * this wrong is how a draft of these two cases "found a deadlock" that was just arithmetic.
   */
  async function bargedInAfterRepOne(): Promise<BargeRig> {
    const rig = await bargeRig()
    rig.advance(1_000)
    rig.push(repEvent(1, 1_000))
    rig.advance(2_500)
    rig.push(repEvent(2, 3_500))
    rig.talk(TALKING_BUFFERS)
    return rig
  }

  it('does not deadlock: the coach speaks again on the next rep that earns it', async () => {
    const rig = await bargedInAfterRepOne()
    const atBargeIn = rig.utterances()

    /**
     * A rep arriving immediately after the barge-in is still held, and for the RIGHT reason:
     * the user has just spoken, so the listen window now runs from the interruption rather than
     * from a drain time that no longer exists. That is `noteSilenceStart` working, not a stall.
     */
    rig.advance(500)
    rig.push(repEvent(3, 10_000))
    expect(rig.utterances()).toBe(atBargeIn)

    // Past the listen window and the user's grace period, and past the cadence: it speaks.
    rig.advance(SPEECH_TUNING.listenWindowMs + SPEECH_TUNING.userTurnGraceMs + 1_000)
    rig.push(repEvent(4, 20_000))
    rig.advance(2_500)
    rig.push(repEvent(5, 22_500))
    expect(rig.utterances()).toBe(atBargeIn + 1)
  })

  it('accounts for the withheld reps in the next line instead of losing them', async () => {
    const rig = await bargedInAfterRepOne()
    rig.advance(SPEECH_TUNING.listenWindowMs + SPEECH_TUNING.userTurnGraceMs + 1_000)
    for (const n of [3, 4, 5]) {
      rig.advance(2_500)
      rig.push(repEvent(n, 20_000 + n * 2_500))
    }

    const last = rig.lines()[rig.lines().length - 1] ?? ''
    // Collapsed into one clause on a line the coach was going to say anyway — the tally, not a
    // queue. Reps 2, 3 and 4 went by silently, including the one the barge-in landed on.
    expect(last).toContain(REP_CALLOUT_LINE.instruction)
    expect(last).toMatch(/reps went by without comment/)
    // And the silenced rep is not separately re-spoken anywhere: one line per spoken rep.
    expect(rig.lines().filter((line) => line.includes('rep 2 completed'))).toHaveLength(0)
  })

  it('never opens the mic onto a coach that is still talking', async () => {
    // The safety invariant barge-in must not cost: an open gate on an audible coach is the
    // feedback loop the gate exists for, and is strictly worse than no barge-in at all.
    const rig = await bargeRig()
    rig.advance(1_000)
    rig.push(repEvent(1, 1_000))
    rig.talk(TALKING_BUFFERS)
    if (rig.appends() > 0) {
      expect(rig.stops()).toBeGreaterThan(0)
      expect(rig.coachSpeaking()).toBe(false)
      return
    }
    expect(rig.coachSpeaking()).toBe(true)
  })

  it('is only reachable because barge-in ships armed', () => {
    // If this fails, every case above is passing for the wrong reason.
    expect(BARGE_IN_TUNING.enabled).toBe(true)
  })
})
