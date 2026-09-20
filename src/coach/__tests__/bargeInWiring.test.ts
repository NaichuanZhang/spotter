/**
 * IS BARGE-IN ACTUALLY ARMED IN THE SHIPPED APP? Measured, not assumed. It is now — and for
 * most of this feature's life it was not, which is what this file exists to keep true.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * `bargeIn.test.ts` pins the detector and `micUplinkBargeIn.test.ts` pins the uplink acting
 * on it. Fifty-odd cases passed, which read exactly like a working feature. It was not one:
 * `createMicUplink` arms barge-in only when it is handed a way to SILENCE the coach —
 *
 *     const bargeInArmed = tuning.enabled && typeof options.interruptCoach === 'function'
 *
 * — and `session.ts` used to construct the uplink WITHOUT `interruptCoach`. So in the real
 * app `bargeInArmed` was false, `audioIn` was never given an `onBuffer` monitor, the level of
 * the gated buffers was never even measured, and the user could not interrupt at all. Every
 * test in those two files supplies its own hook and therefore could not see it. Measured
 * through the real `createCoachSession` at the time: `monitorInstalled: false`,
 * `coachStopped: 0`, `appends: 0`, coach still talking after a full second of 0.5-RMS speech
 * over it.
 *
 * So the unit under test HERE is deliberately not the detector — it is the wiring. This file
 * drives the real `createCoachSession` and asserts the two options that arm the feature are
 * actually passed, because those are invisible to every other test in the suite.
 *
 * ── WHAT FIXED IT, AND WHY IT HAD TO BE THAT EXACT CALL ─────────────────────────────────
 * Two options on `session.ts`'s `createMicUplink({...})`:
 *
 *     interruptCoach: () => interrupt('user barged in', true),
 *     now,
 *
 * `interrupt` and not `audio.stop()`: only the former also clears the caption, restarts the
 * listen window and — via `discardUntil` — throws away the remainder of the response the
 * server is still streaming. With only a stop the coach resumes mid-sentence as the next
 * deltas land. `force: true` is required, not defensive: unforced, `interrupt` returns early
 * unless the connection `isResponding()` or the queue is past `bargeInBacklogSec`, and
 * barge-in's whole case is a coach mid-utterance from audio ALREADY queued locally, which is
 * exactly when both of those are false.
 *
 * `now` is a second, independent fix: without it the uplink runs on `Date.now()` while the
 * session runs on `performance.now()` — the mixed-clock-domain bug this repo has already paid
 * for once (the since-removed heart-rate mock read a resting pulse for a whole set; the mock
 * is gone, the clock rule it bought is not). See the last case.
 *
 * Verified load-bearing by mutation, both reverted: dropping `interruptCoach` fails 3 of the
 * 6 cases here, dropping `now` fails 1.
 *
 * ── WHY THE SESSION-LEVEL CASES USE REAL TIME ───────────────────────────────────────────
 * `rig()` does not inject a clock, so it exercises the same default path a browser takes and
 * the detector's hysteresis accumulates against the wall clock. A fake clock there would see
 * `dt === 0` on every buffer, `aboveMs` would never reach `holdMs`, and barge-in would never
 * fire NO MATTER HOW IT IS WIRED — which is exactly how an early draft of this file "passed"
 * against a session that had been correctly fixed. Hence the real `sleep`s. The final case
 * covers the injected-clock path separately, and is what guards `now` being passed at all.
 */
import { describe, expect, it } from 'vitest'
import { createCoachSession } from '../session'
import { createMicUplink } from '../micUplink'
import { BARGE_IN_TUNING } from '../bargeIn'
import type { AudioIn, AudioInOptions } from '../audioIn'
import type { AudioOut } from '../audioOut'

/**
 * WAS THE PINNED GAP, now the asserted state: `true` = session.ts passes `interruptCoach`, so
 * barge-in is live. It is kept as a named flag rather than inlined because it is the one
 * switch that flips this file between "assert the feature" and "assert the gap" — if barge-in
 * ever has to be un-wired, set it to `false` rather than deleting the cases, and the suite
 * goes back to documenting the inert behaviour instead of silently passing on nothing.
 */
const armsBargeInInTheRealSession = true

/**
 * A person talking over the coach. Deliberately past the ECHO-GUARDED bar, not just the
 * ordinary one: the guard multiplies the trigger by `echoGuardFactor` for `echoGuardMs` after
 * the coach starts, and this test interrupts immediately, so a quieter level here would be
 * suppressed as suspected echo and prove nothing about the wiring.
 */
const VOICE = 0.9
/** Real ms between buffers. Shorter than `maxSampleGapBuffers` allows, so none is clamped. */
const BUFFER_GAP_MS = 45
/** 12 x 45 ms ≈ 540 ms of continuous speech — comfortably past `holdMs` (250). */
const TALKING_BUFFERS = 12

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

class FakeSocket {
  static readonly OPEN = 1
  readyState = FakeSocket.OPEN
  readonly sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  emit(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const tokenFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ value: 'bai-eph-test' }),
  } as Response)

const flush = () => new Promise((done) => setTimeout(done, 0))

interface Rig {
  /** What `audioIn` was constructed with. `onBuffer` present == barge-in armed. */
  readonly mic: AudioInOptions
  /** How many times the coach's audio was stopped. */
  stops(): number
  /** `input_audio_buffer.append` frames that reached the wire. */
  appends(): number
  coachSpeaking(): boolean
  /** Talks over the coach for `count` buffers, mirroring audioIn's per-buffer order. */
  talk(count: number, level: number): Promise<void>
}

/**
 * Drives the REAL `createCoachSession` — its real uplink, its real gate, its real audio
 * accounting — with the microphone and the speakers faked at the same seams the app injects.
 *
 * The coach's audio is modelled as a plain "audible" flag rather than a draining queue,
 * because the only thing the gate reads is `isSpeaking()`, and a flag keeps the test honest
 * about the wall clock the detector actually uses.
 */
async function rig(): Promise<Rig> {
  let coachAudible = false
  let stops = 0

  let captured: AudioInOptions | null = null
  let capturing = false

  const audio: AudioOut = {
    unlock: () => Promise.resolve(),
    unlocked: () => true,
    enqueue: () => {},
    stop: () => {
      stops += 1
      coachAudible = false
    },
    isSpeaking: () => coachAudible,
    level: () => 0,
    queuedSec: () => (coachAudible ? 6 : 0),
    setEmphasis: () => {},
    close: () => Promise.resolve(),
  }

  const sockets: FakeSocket[] = []
  const session = createCoachSession({
    persona: 'mean',
    audio,
    createAudioIn: (options: AudioInOptions): AudioIn => {
      captured = options
      return {
        start: () => {
          capturing = true
          return Promise.resolve()
        },
        stop: () => {
          capturing = false
        },
        level: () => 0,
        isCapturing: () => capturing,
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
  const socket = sockets[0]
  socket.emit({ type: 'session.created' })
  await connecting
  // `connect` fires `startMic()` fire-and-forget; let it settle.
  await flush()

  const mic = captured as AudioInOptions | null
  if (mic === null) throw new Error('the session never constructed an audioIn')

  // The coach is now mid-utterance.
  coachAudible = true
  const baseline = socket.sent.length

  return {
    mic,
    stops: () => stops,
    appends: () =>
      socket.sent
        .slice(baseline)
        .filter((frame) => frame.type === 'input_audio_buffer.append').length,
    coachSpeaking: () => coachAudible,
    talk: async (count, level) => {
      for (let i = 0; i < count; i += 1) {
        await sleep(BUFFER_GAP_MS)
        // audioIn's real order: gate, monitor, RE-CONSULT the gate, silence floor, chunk.
        const shut = !mic.gateOpen()
        mic.onBuffer?.({ level, gated: shut, takeBase64: () => 'QUJD' })
        if (shut && !mic.gateOpen()) continue
        mic.onChunk('QUJD')
      }
    },
  }
}

describe('barge-in, as the shipped session wires it', () => {
  it(
    armsBargeInInTheRealSession
      ? 'lets a talking user cut the coach off'
      : 'PINNED GAP: cannot cut the coach off, because session.ts passes no interruptCoach',
    async () => {
      const r = await rig()
      expect(r.coachSpeaking()).toBe(true)

      await r.talk(TALKING_BUFFERS, VOICE)

      if (armsBargeInInTheRealSession) {
        expect(r.stops()).toBeGreaterThan(0)
        expect(r.appends()).toBeGreaterThan(0)
        expect(r.coachSpeaking()).toBe(false)
        return
      }
      // The measured reality. Half a second of speech over the coach achieves nothing:
      // never silenced, not one byte transmitted, still talking.
      expect(r.stops()).toBe(0)
      expect(r.appends()).toBe(0)
      expect(r.coachSpeaking()).toBe(true)
    },
  )

  it('does not even MEASURE the gated buffers, so no room is ever learned', async () => {
    const r = await rig()
    // `onBuffer` is installed only when armed — this is the single observable that decides
    // whether bargeIn.ts runs at all in production.
    expect(r.mic.onBuffer !== undefined).toBe(armsBargeInInTheRealSession)
  })

  /**
   * THE SAFETY INVARIANT, and the one case here that is deliberately NOT switched on
   * `armsBargeInInTheRealSession` — because it must hold either way, and a test that only
   * describes today's behaviour would have to be rewritten by the very change it should be
   * guarding.
   *
   * Unwired, it says the gap is merely a wait: the mic stays shut, so the model never hears
   * itself. Wired, it says the gate opened only because the coach had been silenced first.
   * The forbidden state both arms rule out is an OPEN MIC ON A TALKING COACH — the feedback
   * loop the gate exists to prevent, and strictly worse than no barge-in at all.
   */
  it('never opens the mic onto a coach that is still talking', async () => {
    const r = await rig()
    await r.talk(TALKING_BUFFERS, VOICE)
    if (r.appends() > 0) {
      expect(r.stops()).toBeGreaterThan(0)
      expect(r.coachSpeaking()).toBe(false)
      return
    }
    // Nothing transmitted: half-duplex, the user waits, and that is safe.
    expect(r.coachSpeaking()).toBe(true)
  })
})

describe('the gap is one missing option, not a broken detector', () => {
  /**
   * The control arm, and the reason the report can say "one line". The same
   * `createMicUplink`, the same shipped `BARGE_IN_TUNING`, the same fake mic — with the hook
   * supplied and a clock injected. If this passes while the suite above pins a gap, the
   * detector, the hysteresis, the floor tracker, the pre-roll and the gate are all working
   * and the only thing missing is the wiring in `session.ts`.
   */
  it('interrupts as soon as an interruptCoach hook exists', () => {
    let clock = 0
    let coachSpeaking = true
    let interrupts = 0
    const appended: string[] = []
    let captured: AudioInOptions | null = null

    const uplink = createMicUplink({
      send: (frame) => {
        if (frame.type === 'input_audio_buffer.append') appended.push(String(frame.audio))
        return true
      },
      isCoachSpeaking: () => coachSpeaking,
      interruptCoach: () => {
        interrupts += 1
        coachSpeaking = false
      },
      // Injected here, which the shipped session does NOT do — see the header.
      now: () => clock,
      setInterval: () => 0,
      clearInterval: () => {},
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
    })
    void uplink.start()
    const mic = captured as AudioInOptions | null
    if (mic === null) throw new Error('no audioIn')

    expect(mic.onBuffer).toBeDefined()
    for (let i = 0; i < TALKING_BUFFERS; i += 1) {
      clock += 85
      const shut = !mic.gateOpen()
      mic.onBuffer?.({ level: VOICE, gated: shut, takeBase64: () => 'QUJD' })
      if (shut && !mic.gateOpen()) continue
      mic.onChunk('QUJD')
    }

    expect(interrupts).toBe(1)
    expect(appended.length).toBeGreaterThan(0)
    expect(uplink.bargeIn().triggers).toBe(1)
  })

  it('ships with the master switch ON, so the gap really is the only thing in the way', () => {
    // If this ever fails, the gap above has a second cause and the report is out of date.
    expect(BARGE_IN_TUNING.enabled).toBe(true)
  })

  /**
   * THE CLOCK DOMAIN, now asserted positively rather than pinned as a gap.
   *
   * `createMicUplink`'s own default is `Date.now()`, and the session runs on
   * `performance.now()`. Mixing the two is the class of bug that already cost this repo a
   * whole set of readings from the since-removed heart-rate mock, and `Date.now()` is not
   * monotonic — an NTP or DST step mid-set would corrupt the hold and refractory windows.
   *
   * This case cannot check the two clocks are equal (they are both real clocks in the app),
   * so it checks the property that only holds if the session THREADS ITS OWN clock through:
   * an injected clock, advancing with no real time passing at all, drives barge-in end to
   * end. Delete `now` from the `createMicUplink({...})` call and this fails immediately —
   * `dt` collapses to ~0 on every buffer, `aboveMs` never reaches `holdMs`, and nothing
   * fires. That makes it the regression guard for the fix, not a description of it.
   */
  it('runs the detector on the SESSION clock, so an injected clock drives barge-in', async () => {
    let clock = 0
    let coachAudible = true
    let stops = 0
    let captured: AudioInOptions | null = null
    const sockets: FakeSocket[] = []

    const audio: AudioOut = {
      unlock: () => Promise.resolve(),
      unlocked: () => true,
      enqueue: () => {},
      stop: () => {
        stops += 1
        coachAudible = false
      },
      isSpeaking: () => coachAudible,
      level: () => 0,
      queuedSec: () => (coachAudible ? 6 : 0),
      setEmphasis: () => {},
      close: () => Promise.resolve(),
    }

    const session = createCoachSession({
      persona: 'mean',
      audio,
      // The one thing under test: this clock has to reach bargeIn.ts's hysteresis.
      now: () => clock,
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
    sockets[0].emit({ type: 'session.created' })
    await connecting
    await flush()

    const mic = captured as AudioInOptions | null
    if (mic === null) throw new Error('the session never constructed an audioIn')
    expect(mic.onBuffer).toBeDefined()

    // NO real sleeping anywhere: every millisecond below is the injected clock's.
    for (let i = 0; i < TALKING_BUFFERS; i += 1) {
      clock += 85
      const shut = !mic.gateOpen()
      mic.onBuffer?.({ level: VOICE, gated: shut, takeBase64: () => 'QUJD' })
      if (shut && !mic.gateOpen()) continue
      mic.onChunk('QUJD')
    }

    expect(stops).toBeGreaterThan(0)
    expect(coachAudible).toBe(false)
    session.disconnect()
  })
})
