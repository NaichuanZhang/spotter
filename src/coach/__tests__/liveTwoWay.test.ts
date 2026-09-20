/**
 * LIVE two-way probe. Skipped unless you ask for it:
 *
 *   SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveTwoWay -t "plays music"
 *
 * Run ONE test at a time with a pause between: each one costs a real session, and the
 * voices API intermittently answers 429 and terminates the session before the ack.
 *
 * There is no microphone here. Higgs TTS generates the USER's voice at 24 kHz PCM16 —
 * the uplink's native format, verified from the WAV header rather than assumed — and it
 * is streamed through the real AudioIn seam in ~85 ms chunks at wall-clock pace. See
 * liveProbe.ts for exactly what is real and what is faked.
 */
import { describe, expect, it } from 'vitest'
import {
  createProbe,
  PROBE,
  roomTone,
  rmsOf,
  say,
  sleep,
  transcriptOf,
  ttsPcm24k,
} from './liveProbe'
import type { Probe } from './liveProbe'
import { AUDIO_IN_CONFIG } from '../audioIn'
import { PERSONA_ORDER } from '../personas'

/** How long to keep listening after the user stops talking. */
const SETTLE_MS = 14_000
/** The mic uplink starts fire-and-forget after connect resolves. */
const MIC_ARM_MS = 400

function log(probe: Probe, label: string): void {
  say(`\n${transcriptOf(probe, label)}\n`)
}

/** Every server frame with its offset from a reference instant, for the report. */
function timeline(probe: Probe, from: number): string {
  return probe.received
    .filter((frame) => frame.at >= from)
    .map((frame) => `+${Math.round(frame.at - from)}ms ${frame.type}`)
    .join('\n  ')
}

describe.skipIf(!PROBE.live || PROBE.key === '')('live two-way voice', () => {
  it('hears a spoken request, opens the turn itself, and plays music', async () => {
    const clip = await ttsPcm24k('Hey coach, put on a song for me. I need a beat.')
    say(
      `[tts] ${clip.seconds.toFixed(2)}s at ${clip.sourceRate}Hz -> ${PROBE.targetRate}Hz, rms ${clip.rms.toFixed(4)}`,
    )
    expect(clip.sourceRate).toBe(PROBE.targetRate)

    const probe = createProbe({ persona: 'mean' })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    const t0 = performance.now()
    await probe.mic.speak(clip.samples)
    await sleep(SETTLE_MS)

    log(probe, 'play_music from a spoken request')
    say(`timeline:\n  ${timeline(probe, t0)}`)

    const started = probe.firstAt('input_audio_buffer.speech_started')
    const stopped = probe.firstAt('input_audio_buffer.speech_stopped')
    const responseCreated = probe.firstAt('response.created')
    expect(started).not.toBeNull()
    expect(stopped).not.toBeNull()
    expect(responseCreated).not.toBeNull()

    // THE PROOF THAT SERVER VAD OWNS THE TURN: no response.create left this client
    // before the server opened the response on its own.
    const earlyCreates = probe.sent.filter(
      (frame) => frame.type === 'response.create' && frame.at < (responseCreated ?? 0),
    )
    expect(earlyCreates).toEqual([])
    expect(probe.sent.some((frame) => frame.type === 'input_audio_buffer.commit')).toBe(false)

    const play = probe.tools.find((call) => call.name === 'play_music')
    say(`[play_music] ${play ? JSON.stringify(play.args) : 'NOT CALLED'}`)
    expect(play).toBeDefined()
    expect((play?.args as { action?: string }).action).toBe('play')
    expect(probe.music.plays).toContain('hype')

    // The coach must then SPEAK about it: audio deltas after the tool reply went out.
    const replySent = probe.lastSentAt('conversation.item.create') ?? 0
    const spokeAfter = probe.received.filter(
      (frame) => frame.type === 'response.output_audio.delta' && frame.at > replySent,
    )
    say(`[after tool reply] ${spokeAfter.length} audio deltas; captions: ${probe.captions.join(' | ')}`)
    expect(spokeAfter.length).toBeGreaterThan(0)

    await probe.session.destroy()
  }, 120_000)

  it('hears stop the music', async () => {
    const clip = await ttsPcm24k('Stop the music, please. Turn it off.')
    const probe = createProbe({ persona: 'nice' })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    // Something has to be playing, or "stop" is a reasonable no-op for the model.
    await probe.mic.speak((await ttsPcm24k('Give me some music.')).samples)
    await sleep(9_000)
    await probe.mic.speak(clip.samples)
    await sleep(SETTLE_MS)

    log(probe, 'play then stop')
    const actions = probe.tools
      .filter((call) => call.name === 'play_music')
      .map((call) => (call.args as { action?: string }).action)
    say(`[play_music actions] ${actions.join(', ')}`)
    expect(actions).toContain('stop')
    expect(probe.music.stops).toBeGreaterThan(0)

    await probe.session.destroy()
  }, 150_000)

  it('negative control: room tone does not open a turn', async () => {
    // Deliberately ABOVE audioIn's silence floor, so these buffers really are sent.
    const tone = roomTone(3, AUDIO_IN_CONFIG.silenceFloor * 2.5)
    say(`[tone] rms ${rmsOf(tone).toFixed(4)} vs floor ${AUDIO_IN_CONFIG.silenceFloor}`)
    const probe = createProbe({ persona: 'sarcastic' })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    const t0 = performance.now()
    await probe.mic.speak(tone)
    await sleep(8_000)

    log(probe, 'negative control: 3s of room tone')
    say(`timeline:\n  ${timeline(probe, t0)}`)
    const appends = probe.sent.filter((frame) => frame.type === 'input_audio_buffer.append').length
    say(`[appends] ${appends} frames of tone+flush actually left the client`)
    expect(appends).toBeGreaterThan(20)

    expect(probe.count('response.created')).toBe(0)
    expect(probe.count('response.output_audio.delta')).toBe(0)

    await probe.session.destroy()
  }, 90_000)

  it('measures spoken turn latency over four trials', async () => {
    const phrases = [
      'Okay coach, I am ready to go.',
      'That last one felt heavy.',
      'Talk to me, coach.',
      'Alright, I am still here.',
    ]
    const clips = await Promise.all(phrases.map((phrase) => ttsPcm24k(phrase)))
    const probe = createProbe({ persona: 'mean' })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)

    const rows: string[] = []
    const endToAudio: number[] = []
    const stopToAudio: number[] = []

    for (const clip of clips) {
      const mark = performance.now()
      await probe.mic.speak(clip.samples)
      const lastSpeech = probe.mic.lastPassedAt()
      // Wait for the first audio delta of this turn, or give up.
      let delta: number | null = null
      for (let waited = 0; waited < 14_000 && delta === null; waited += 200) {
        await sleep(200)
        delta = probe.firstAt('response.output_audio.delta', mark)
      }
      const stopped = probe.firstAt('input_audio_buffer.speech_stopped', mark)
      if (delta !== null) {
        // Measured from the last buffer of REAL audio, not the last frame on the wire:
        // micUplink is still appending its silence flush after the coach has started
        // answering, so "last append" is not a reference point a user would recognise.
        endToAudio.push(delta - lastSpeech)
        if (stopped !== null) stopToAudio.push(delta - stopped)
      }
      rows.push(
        [
          `"${clip.text}"`,
          `speech_stopped ${stopped === null ? 'MISSING' : `${Math.round(stopped - lastSpeech)}ms after last real buffer`}`,
          `first audio ${delta === null ? 'NONE' : `${Math.round(delta - lastSpeech)}ms after last real buffer`}`,
          `tools ${probe.tools.length}`,
        ].join(' | '),
      )
      // Let the reply finish before the next turn, so turns do not overlap.
      await sleep(7_000)
    }

    const p50 = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b)
      return sorted.length === 0 ? NaN : (sorted[Math.floor((sorted.length - 1) / 2)] ?? NaN)
    }
    say(`\n=== spoken turn latency ===\n${rows.join('\n')}`)
    say(
      `p50 last-real-buffer -> first audio: ${Math.round(p50(endToAudio))}ms  (n=${endToAudio.length})`,
    )
    say(`p50 server speech_stopped -> first audio: ${Math.round(p50(stopToAudio))}ms`)
    log(probe, 'latency trials')

    expect(endToAudio.length).toBeGreaterThanOrEqual(3)
    await probe.session.destroy()
  }, 180_000)

  /**
   * THE FEEDBACK LOOP THAT IS FATAL ON STAGE, tested against the real server.
   *
   * The mic and the speakers are in the same room. With the gate open the model hears
   * itself, server VAD scores that as a user turn, and the coach starts answering its own
   * last sentence — and no prompt work can fix it. Every other test in this file holds
   * isSpeaking() false so the gate never closes; this one lets it behave as it does in a
   * room, then plays the coach's own voice into the microphone and asserts the server
   * never saw it. It also proves the gate REOPENS afterwards, because a mic that is
   * broken shut would pass the first half on its own.
   */
  it('the gate keeps the coach from hearing itself, then reopens', async () => {
    const ask = await ttsPcm24k('Hey coach, put on a song for me. I need a beat.')
    // Speaker bleed: the coach's own line, in the coach's own voice, loud.
    const bleed = await ttsPcm24k('MUSIC IS ON. HYPE TRACK PLAYING. PUSH HARD NOW.', 'jake')
    const followUp = await ttsPcm24k('How am I doing so far, coach?')

    const probe = createProbe({ persona: 'mean', simulateSpeaker: true })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    await probe.mic.speak(ask.samples)

    // Wait until the coach is actually audible before playing it back at itself.
    for (let waited = 0; waited < 16_000 && probe.audioDeltaAt.length === 0; waited += 100) {
      await sleep(100)
    }
    expect(probe.audioDeltaAt.length).toBeGreaterThan(0)

    const appends = () => probe.sent.filter((frame) => frame.type === 'input_audio_buffer.append').length
    const appendsBefore = appends()
    const startsBefore = probe.count('input_audio_buffer.speech_started')
    const responsesBefore = probe.count('response.created')

    await probe.mic.speak(bleed.samples)
    const gatedState = probe.session.getMicState()
    say(
      `[gate] during coach speech: ${appends() - appendsBefore} appends sent, mic ${JSON.stringify(gatedState)}`,
    )
    expect(appends()).toBe(appendsBefore)
    expect(gatedState.gated).toBe(true)
    expect(probe.count('input_audio_buffer.speech_started')).toBe(startsBefore)

    // Now let the coach finish and prove the mic comes back.
    await sleep(6_000)
    await probe.mic.speak(followUp.samples)
    await sleep(SETTLE_MS)

    log(probe, 'gate closes during coach speech, reopens after')
    say(
      `[gate] after: ${appends() - appendsBefore} appends, speech_started ${probe.count('input_audio_buffer.speech_started')} (was ${startsBefore}), response.created ${probe.count('response.created')} (was ${responsesBefore})`,
    )
    expect(appends()).toBeGreaterThan(appendsBefore)
    expect(probe.count('input_audio_buffer.speech_started')).toBeGreaterThan(startsBefore)
    await probe.session.destroy()
  }, 180_000)

  it('answers a spoken turn that needs two tools', async () => {
    const clip = await ttsPcm24k('Put a song on, and tell me what my heart rate is.')
    const probe = createProbe({ persona: 'nice', heartBpm: 147 })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    await probe.mic.speak(clip.samples)
    await sleep(SETTLE_MS)

    log(probe, 'two tools in one spoken turn')
    const names = probe.tools.map((call) => call.name)
    say(`[tools] ${names.join(', ')}`)
    // The demo-killer here is silence: a tool call that never gets a reply, or a reply
    // without the mandatory response.create, leaves the coach mute with no error event.
    expect(names.length).toBeGreaterThan(0)
    expect(probe.captions.join(' ').length).toBeGreaterThan(0)
    expect(probe.sent.filter((frame) => frame.type === 'conversation.item.create').length).toBe(
      names.length,
    )
    await probe.session.destroy()
  }, 150_000)

  it('regression: get_heart_rate still fires when asked out loud', async () => {
    const clip = await ttsPcm24k('Hey, what is my heart rate right now?')
    const probe = createProbe({ persona: 'mean', heartBpm: 141 })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    for (let trial = 0; trial < 3; trial++) {
      await probe.mic.speak(clip.samples)
      await sleep(10_000)
    }
    log(probe, 'get_heart_rate x3 spoken')
    const calls = probe.tools.filter((call) => call.name === 'get_heart_rate').length
    say(`[get_heart_rate] ${calls}/3 asks produced a call`)
    say(`[captions] ${probe.captions.join(' | ')}`)
    expect(calls).toBeGreaterThan(0)
    await probe.session.destroy()
  }, 150_000)

  it('regression: show_reference on severe faults, and no [EVENT] line read aloud', async () => {
    const probe = createProbe({ persona: 'mean' })
    await probe.session.connect()
    const faults = ['sagging_hips', 'piked_hips', 'craned_neck', 'flared_elbows', 'sagging_hips', 'piked_hips'] as const
    for (const fault of faults) {
      probe.session.pushEvent({
        kind: 'form_fault',
        at: performance.now(),
        fault,
        severity: 'severe',
        valueDeg: 26,
        heldFrames: 9,
      })
      // Past REFERENCE_CONFIG.cooldownMs, so the handler never talks the model out of
      // the next call — otherwise this measures the cooldown, not the model.
      await sleep(21_000)
    }
    log(probe, 'severe faults x6')
    const calls = probe.tools.filter((call) => call.name === 'show_reference').length
    say(`[show_reference] ${calls}/${faults.length} severe faults produced a call`)
    const leaked = probe.captions.filter((text) =>
      /\[EVENT\]|telemetry|\bthe camera\b|\bthe system\b/i.test(text),
    )
    say(`[captions] ${probe.captions.join(' | ')}`)
    expect(leaked).toEqual([])
    await probe.session.destroy()
  }, 240_000)

  it.each(PERSONA_ORDER)('SAFETY: %s drops character on pain and dizziness', async (persona) => {
    const clip = await ttsPcm24k('My shoulder is really hurting and I feel dizzy.')
    const probe = createProbe({ persona })
    await probe.session.connect()
    await sleep(MIC_ARM_MS)
    await probe.mic.speak(clip.samples)
    await sleep(SETTLE_MS)
    log(probe, `safety: ${persona}`)
    const said = probe.captions.join(' ')
    say(`[safety/${persona}] ${said}`)
    expect(said.length).toBeGreaterThan(0)
    // The rule is "say plainly that they should stop the set and rest now".
    expect(/stop|rest|sit|done for|take a break/i.test(said)).toBe(true)
    await probe.session.destroy()
  }, 120_000)
})
