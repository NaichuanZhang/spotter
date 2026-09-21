/**
 * THE FOUR WAYS "LET THE USER PICK A CAMERA" BREAKS A WORKING APP.
 *
 * `poseEngine.ts` is the only impure file in the package and cannot be unit-tested — it
 * needs a real `<video>`, a real camera and requestAnimationFrame. Everything in it that
 * is a DECISION rather than DOM was therefore moved into `cameraStream.ts`, and this file
 * drives all of it through an injected `getUserMedia` and a fake stream.
 *
 *   1. A PINNED DEVICE THAT IS GONE MUST NOT BRICK STARTUP. `deviceId: {exact}` answers
 *      OverconstrainedError / NotFoundError, and a remembered Continuity iPhone is gone
 *      every time the phone sleeps or leaves the room. One retry without the pin, and the
 *      caller is told it happened — silently opening the lid camera while the UI still
 *      says "iPhone" is the version of this that makes the user distrust the app.
 *   2. A DENIAL IS NOT A MISSING DEVICE. Retrying a `NotAllowedError` without the pin
 *      either re-prompts or succeeds on a DIFFERENT camera than the one the user chose.
 *      Exactly one getUserMedia call is allowed to leave on that path.
 *   3. WHAT OPENED IS NOT WHAT WAS ASKED FOR. The tests below have the fake report a
 *      deviceId that differs from the request on purpose: anything reading back the
 *      REQUEST would pass while lying to the UI after a fallback.
 *   4. TWO CLICKS MUST NOT LEAVE TWO STREAMS LIVE. getUserMedia is slow enough to
 *      out-click. The loser of a race must stop the stream it opened — an orphan stream is
 *      a camera light with nothing reading it, and on macOS it is also the reason the next
 *      open of that iPhone fails as "already in use".
 *
 * The fakes count `stop()` calls and record ORDER, because "stop the old tracks first" is
 * an ordering claim and an assertion on final state cannot see it.
 */
import { describe, expect, it } from 'vitest'
import type { CameraStream, CameraTrack } from '../cameraStream'
import {
  CAMERA_STREAM,
  classifyCameraError,
  createCameraOwner,
  openCameraStream,
  streamDeviceId,
  videoConstraints,
} from '../cameraStream'

const BASE: MediaTrackConstraints = { width: 960, height: 720, facingMode: 'user' }
const IPHONE = 'iphone-device-id'
const LID = 'lid-device-id'

// --------------------------------------------------------------------- fakes

class FakeTrack implements CameraTrack {
  readonly kind = 'video'
  stopped = 0
  private listeners: readonly (() => void)[] = []

  constructor(
    private readonly deviceId: string,
    private readonly log: string[],
    private readonly name: string,
  ) {}

  getSettings(): { readonly deviceId?: string } {
    return { deviceId: this.deviceId }
  }

  stop(): void {
    this.stopped += 1
    this.log.push(`stop:${this.name}`)
  }

  addEventListener(_type: 'ended', listener: () => void): void {
    this.listeners = [...this.listeners, listener]
  }

  removeEventListener(_type: 'ended', listener: () => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener)
  }

  /** What a sleeping iPhone does to its track. */
  end(): void {
    for (const listener of this.listeners) listener()
  }
}

class FakeStream implements CameraStream {
  readonly track: FakeTrack
  constructor(deviceId: string, log: string[], name: string) {
    this.track = new FakeTrack(deviceId, log, name)
  }
  getTracks(): readonly CameraTrack[] {
    return [this.track]
  }
}

class Overconstrained extends Error {
  override readonly name = 'OverconstrainedError'
  readonly constraint = 'deviceId'
  constructor() {
    super('Could not satisfy deviceId')
  }
}

function denied(): Error {
  const error = new Error('Permission denied')
  error.name = 'NotAllowedError'
  return error
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-scheduled microtask and timer callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Records every constraint set it is asked for, and answers with scripted streams. */
function recorder(answers: readonly (FakeStream | Error)[], log: string[] = []) {
  const calls: MediaStreamConstraints[] = []
  let index = 0
  const getUserMedia = async (constraints: MediaStreamConstraints): Promise<FakeStream> => {
    calls.push(constraints)
    log.push('open')
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    if (answer instanceof Error) throw answer
    if (!answer) throw new Error('fake ran out of answers')
    return answer
  }
  const videoOf = (call: number): MediaTrackConstraints => calls[call]?.video as MediaTrackConstraints
  return { calls, getUserMedia, videoOf, log }
}

// --------------------------------------------------------------- constraints

describe('videoConstraints', () => {
  it('asks for nothing but the base when no device is pinned', () => {
    const constraints = videoConstraints(BASE, null)
    expect(constraints).toEqual({ video: { width: 960, height: 720, facingMode: 'user' }, audio: false })
  })

  it('pins the device with exact, because ideal would silently open another camera', () => {
    const video = videoConstraints(BASE, IPHONE).video as MediaTrackConstraints
    expect(video.deviceId).toEqual({ exact: IPHONE })
    expect(video.width).toBe(960)
    expect(video.height).toBe(720)
  })

  it('drops facingMode once a device is pinned', () => {
    // An advisory front/back preference can only lower the fitness score of the camera the
    // user explicitly chose — a Continuity iPhone is not facingMode "user".
    const video = videoConstraints(BASE, IPHONE).video as MediaTrackConstraints
    expect(video.facingMode).toBeUndefined()
  })

  it('never mutates the base constraints', () => {
    const base: MediaTrackConstraints = { width: 960, facingMode: 'user' }
    videoConstraints(base, IPHONE)
    expect(base).toEqual({ width: 960, facingMode: 'user' })
  })

  it('always requests video only', () => {
    expect(videoConstraints(BASE, IPHONE).audio).toBe(false)
    expect(videoConstraints(BASE, null).audio).toBe(false)
  })
})

describe('classifyCameraError', () => {
  it('separates a denial from a missing device', () => {
    expect(classifyCameraError(denied(), IPHONE)).toBe('denied')
    expect(classifyCameraError(new Overconstrained(), IPHONE)).toBe('device_unavailable')
  })

  it('treats every name in the unavailable table as retryable and no denial as retryable', () => {
    for (const name of CAMERA_STREAM.unavailableNames) {
      const error = new Error(name)
      error.name = name
      expect(classifyCameraError(error, IPHONE)).toBe('device_unavailable')
    }
    for (const name of CAMERA_STREAM.deniedNames) {
      const error = new Error(name)
      error.name = name
      expect(classifyCameraError(error, IPHONE)).toBe('denied')
    }
    // A name in both tables would make a denial retry. This is the invariant that forbids it.
    const overlap = CAMERA_STREAM.deniedNames.filter((name) => CAMERA_STREAM.unavailableNames.includes(name))
    expect(overlap).toEqual([])
  })

  it('believes an error that names the requested device even under an unknown name', () => {
    const odd = new Error(`Failed to open ${IPHONE}`)
    odd.name = 'SomeVendorError'
    expect(classifyCameraError(odd, IPHONE)).toBe('device_unavailable')
    // ...and does not generalise that to a request with no device in it.
    expect(classifyCameraError(odd, null)).toBe('failed')
  })

  it('calls anything else a plain failure', () => {
    expect(classifyCameraError(new Error('boom'), null)).toBe('failed')
    expect(classifyCameraError('a string', null)).toBe('failed')
    expect(classifyCameraError(null, IPHONE)).toBe('failed')
  })
})

// ------------------------------------------------------------- acquisition

describe('openCameraStream', () => {
  it('reads the deviceId back off the live track, not off the request', async () => {
    // The fake answers with a DIFFERENT id than the one requested: reading back the
    // request instead of the track would pass every other test in this file.
    const fake = recorder([new FakeStream(LID, [], 'lid')])
    const opened = await openCameraStream({ base: BASE, deviceId: IPHONE, getUserMedia: fake.getUserMedia })
    expect(opened.deviceId).toBe(LID)
    expect(opened.requestedDeviceId).toBe(IPHONE)
  })

  it('falls back to the default camera ONCE when the pinned device is gone', async () => {
    const fake = recorder([new Overconstrained(), new FakeStream(LID, [], 'lid')])
    const opened = await openCameraStream({ base: BASE, deviceId: IPHONE, getUserMedia: fake.getUserMedia })

    expect(fake.calls).toHaveLength(2)
    expect(fake.videoOf(0).deviceId).toEqual({ exact: IPHONE })
    // The retry must carry NO pin at all — a second exact request is the same failure twice.
    expect(fake.videoOf(1).deviceId).toBeUndefined()
    expect(opened.fellBack).toBe(true)
    expect(opened.deviceId).toBe(LID)
    expect(opened.requestedDeviceId).toBe(IPHONE)
  })

  it('reports fellBack false when the pinned device opened', async () => {
    const fake = recorder([new FakeStream(IPHONE, [], 'iphone')])
    const opened = await openCameraStream({ base: BASE, deviceId: IPHONE, getUserMedia: fake.getUserMedia })
    expect(opened.fellBack).toBe(false)
    expect(fake.calls).toHaveLength(1)
  })

  it('does NOT retry a permission denial', async () => {
    const fake = recorder([denied(), new FakeStream(LID, [], 'lid')])
    await expect(
      openCameraStream({ base: BASE, deviceId: IPHONE, getUserMedia: fake.getUserMedia }),
    ).rejects.toThrow(/Permission denied/)
    expect(fake.calls).toHaveLength(1)
  })

  it('does not retry at all when nothing was pinned', async () => {
    const fake = recorder([new Overconstrained()])
    await expect(openCameraStream({ base: BASE, deviceId: null, getUserMedia: fake.getUserMedia })).rejects.toThrow(
      Overconstrained,
    )
    expect(fake.calls).toHaveLength(1)
  })

  it('gives up after the single fallback rather than looping', async () => {
    const fake = recorder([new Overconstrained(), new Overconstrained(), new FakeStream(LID, [], 'lid')])
    await expect(
      openCameraStream({ base: BASE, deviceId: IPHONE, getUserMedia: fake.getUserMedia }),
    ).rejects.toThrow(Overconstrained)
    expect(fake.calls).toHaveLength(2)
  })

  it('returns a null deviceId when the browser withholds it', async () => {
    const withheld: CameraStream = { getTracks: () => [] }
    expect(streamDeviceId(withheld)).toBeNull()
  })
})

// ----------------------------------------------------------------- the owner

/**
 * An owner wired to scripted streams. `log` is SHARED with the fake streams and the fake
 * getUserMedia, so the test can assert the order of stop / open / attach rather than only
 * the final state — "stop the old tracks first" is an ordering claim.
 */
function owner(
  log: string[],
  answers: readonly (FakeStream | Error)[],
  attach?: (stream: FakeStream) => Promise<void> | void,
) {
  const fake = recorder(answers, log)
  const attached: FakeStream[] = []
  const ended: (string | null)[] = []
  const subject = createCameraOwner<FakeStream>({
    base: BASE,
    getUserMedia: fake.getUserMedia,
    attach: (stream) => {
      log.push('attach')
      attached.push(stream)
      return attach?.(stream)
    },
    onTrackEnded: (deviceId) => ended.push(deviceId),
  })
  return { subject, fake, log, attached, ended }
}

describe('createCameraOwner', () => {
  it('stops the old tracks BEFORE opening the new camera', async () => {
    const log: string[] = []
    const first = new FakeStream(LID, log, 'lid')
    const second = new FakeStream(IPHONE, log, 'iphone')
    const rig = owner(log, [first, second])
    await rig.subject.acquire(null)
    log.length = 0
    await rig.subject.acquire(IPHONE)

    // Not just "both happened" — the ORDER is the claim. Acquiring first would put two
    // streams live at once, which is two camera lights and, for a Continuity iPhone,
    // a second open that fails as already-in-use.
    expect(log).toEqual(['stop:lid', 'open', 'attach'])
    expect(first.track.stopped).toBe(1)
    expect(rig.attached).toEqual([first, second])
  })

  it('exposes the live stream and its real deviceId', async () => {
    const log: string[] = []
    const stream = new FakeStream(IPHONE, log, 'iphone')
    const rig = owner(log, [stream])
    await rig.subject.acquire(IPHONE)
    expect(rig.subject.current()).toBe(stream)
    expect(rig.subject.deviceId()).toBe(IPHONE)
  })

  it('lets the LAST of two overlapping switches win, and the loser strands nothing', async () => {
    const slow = deferred<FakeStream>()
    const first = new FakeStream(LID, [], 'lid')
    const second = new FakeStream(IPHONE, [], 'iphone')
    let call = 0
    const attached: FakeStream[] = []
    const subject = createCameraOwner<FakeStream>({
      base: BASE,
      getUserMedia: async () => {
        call += 1
        // The first request is the slow one: the user clicked again while it was in flight.
        return call === 1 ? slow.promise : second
      },
      attach: (stream) => {
        attached.push(stream)
      },
    })

    const loser = subject.acquire(LID)
    const winner = subject.acquire(IPHONE)
    slow.resolve(first)

    expect(await loser).toBeNull()
    expect(await winner).not.toBeNull()
    // The loser's stream is stopped rather than left running the camera light...
    expect(first.track.stopped).toBe(1)
    // ...and never reaches the screen, so the element cannot end up showing the camera
    // the user clicked away from.
    expect(attached).toEqual([second])
    expect(subject.current()).toBe(second)
    expect(subject.deviceId()).toBe(IPHONE)
    expect(second.track.stopped).toBe(0)
  })

  it('stops a stream that arrives after release() instead of attaching it', async () => {
    const slow = deferred<FakeStream>()
    const late = new FakeStream(IPHONE, [], 'iphone')
    const attached: FakeStream[] = []
    const subject = createCameraOwner<FakeStream>({
      base: BASE,
      getUserMedia: () => slow.promise,
      attach: (stream) => {
        attached.push(stream)
      },
    })

    const pending = subject.acquire(IPHONE)
    // The set ended while the permission prompt was still on screen.
    subject.release()
    slow.resolve(late)

    expect(await pending).toBeNull()
    expect(late.track.stopped).toBe(1)
    expect(attached).toEqual([])
    expect(subject.current()).toBeNull()
  })

  it('stops the stream when attaching it fails, and does not swallow the failure', async () => {
    const log: string[] = []
    const stream = new FakeStream(IPHONE, log, 'iphone')
    const rig = owner(log, [stream], () => {
      throw new Error('the video element refused to play')
    })
    await expect(rig.subject.acquire(IPHONE)).rejects.toThrow(/refused to play/)
    expect(stream.track.stopped).toBe(1)
    expect(rig.subject.current()).toBeNull()
  })

  it('reports the live track ending, with the deviceId that died', async () => {
    const log: string[] = []
    const stream = new FakeStream(IPHONE, log, 'iphone')
    const rig = owner(log, [stream])
    await rig.subject.acquire(IPHONE)
    stream.track.end()
    expect(rig.ended).toEqual([IPHONE])
  })

  it('ignores `ended` from a track that has already been replaced', async () => {
    const log: string[] = []
    const first = new FakeStream(IPHONE, log, 'iphone')
    const second = new FakeStream(LID, log, 'lid')
    const rig = owner(log, [first, second])
    await rig.subject.acquire(IPHONE)
    await rig.subject.acquire(LID)

    // `stop()` is not supposed to fire `ended`, but a superseded iPhone going to sleep a
    // moment after being switched away from is a real sequence — and reacting to it would
    // fall back off a camera that is working.
    first.track.end()
    expect(rig.ended).toEqual([])

    second.track.end()
    expect(rig.ended).toEqual([LID])
  })

  it('treats an attach that failed BECAUSE it was superseded as a loss, not an error', async () => {
    // This is the AbortError this repo already fixed once, arriving through the new door:
    // the winner assigning srcObject is what aborts the loser's pending play(). Reporting
    // that as "could not switch cameras" would put an error on screen about a camera that
    // is working perfectly.
    const log: string[] = []
    const first = new FakeStream(LID, log, 'lid')
    const second = new FakeStream(IPHONE, log, 'iphone')
    const stalled = deferred<void>()
    const attached: FakeStream[] = []
    let call = 0
    const subject = createCameraOwner<FakeStream>({
      base: BASE,
      getUserMedia: async () => {
        call += 1
        return call === 1 ? first : second
      },
      attach: (stream) => {
        attached.push(stream)
        // The first play() never settles until the element is reassigned under it.
        return stream === first ? stalled.promise : undefined
      },
    })

    const loser = subject.acquire(LID)
    await settle()
    const winner = subject.acquire(IPHONE)
    await winner
    const aborted = new Error('The play() request was interrupted')
    aborted.name = 'AbortError'
    stalled.reject(aborted)

    await expect(loser).resolves.toBeNull()
    expect(first.track.stopped).toBe(1)
    expect(attached).toEqual([first, second])
    expect(subject.current()).toBe(second)
  })

  it('surfaces the raw acquisition failure, having already stopped the old camera', async () => {
    const log: string[] = []
    const first = new FakeStream(LID, log, 'lid')
    const rig = owner(log, [first, denied()])
    await rig.subject.acquire(null)
    await expect(rig.subject.acquire(IPHONE)).rejects.toThrow(/Permission denied/)
    // The old stream is gone — there is no third state where a failed switch silently
    // keeps the previous camera. The caller is told, and says so on screen.
    expect(first.track.stopped).toBe(1)
    expect(rig.subject.current()).toBeNull()
  })
})
