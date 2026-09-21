/**
 * The camera list, with the browser faked.
 *
 * Everything in `cameras.ts` is a query over two globals — `navigator.mediaDevices` and
 * `localStorage` — so faking those two is the entire test harness, and no browser is needed
 * to pin the behaviour that actually bites:
 *
 *   - labels are WITHHELD before a permission grant, and the picker has to survive that
 *     state rather than render three nameless rows;
 *   - the synthesised names must be STABLE across calls, or the list shuffles under the
 *     user's cursor every time a device changes;
 *   - `devicechange` must fan out to EVERY subscriber, because the property-handler form of
 *     this API silently keeps only the last one;
 *   - storage throws in private mode, and losing persistence must not lose the app.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAMERA_LABEL_PATTERNS,
  CAMERA_PICKER,
  listCameras,
  onCameraChange,
  recalledCamera,
  rememberCamera,
} from '../cameras'
import type { CameraKind } from '../cameras'

const KINDS: readonly CameraKind[] = ['builtin', 'iphone', 'external', 'unknown']

/** Shaped like a `MediaDeviceInfo` in the only three fields this module reads. */
interface FakeDeviceInfo {
  readonly kind: string
  readonly label: string
  readonly deviceId: string
}

function videoInput(label: string, deviceId: string): FakeDeviceInfo {
  return { kind: 'videoinput', label, deviceId }
}

/**
 * A real `EventTarget`, so `devicechange` dispatch behaves the way the browser's does
 * instead of the way a hand-rolled listener array would.
 */
class FakeMediaDevices extends EventTarget {
  list: readonly FakeDeviceInfo[] = []
  failure: Error | null = null
  calls = 0

  async enumerateDevices(): Promise<readonly FakeDeviceInfo[]> {
    this.calls += 1
    if (this.failure) throw this.failure
    return this.list
  }

  emitDeviceChange(): void {
    this.dispatchEvent(new Event(CAMERA_PICKER.DEVICE_CHANGE_EVENT))
  }
}

// --------------------------------------------------------------- global plumbing

const restorers: (() => void)[] = []

function swapGlobal(name: 'navigator' | 'localStorage', value: unknown): void {
  const existed = name in globalThis
  const original = Reflect.get(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  restorers.push(() => {
    if (existed) Object.defineProperty(globalThis, name, { value: original, configurable: true, writable: true })
    else Reflect.deleteProperty(globalThis, name)
  })
}

/** Installs a navigator carrying `mediaDevices` and returns the fake for the test to drive. */
function installMediaDevices(): FakeMediaDevices {
  const media = new FakeMediaDevices()
  swapGlobal('navigator', { mediaDevices: media })
  return media
}

/** A `localStorage` whose getter throws, the way a sandboxed iframe's does. */
function installHostileStorageGetter(): void {
  const existed = 'localStorage' in globalThis
  const original = Reflect.get(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    get(): never {
      throw new Error('access denied')
    },
    configurable: true,
  })
  restorers.push(() => {
    if (existed) Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true })
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
}

function installStorage(overrides: Partial<Storage> = {}): Map<string, string> {
  const cells = new Map<string, string>()
  swapGlobal('localStorage', {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => void cells.set(key, value),
    removeItem: (key: string) => void cells.delete(key),
    ...overrides,
  })
  return cells
}

/** Hand-rolled console capture: the failure paths must LOG, not swallow. */
function captureConsole(): { readonly warnings: unknown[][]; readonly errors: unknown[][] } {
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const original = { warn: console.warn, error: console.error }
  console.warn = (...args: unknown[]) => void warnings.push(args)
  console.error = (...args: unknown[]) => void errors.push(args)
  restorers.push(() => {
    console.warn = original.warn
    console.error = original.error
  })
  return { warnings, errors }
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.()
})

// ------------------------------------------------------------------ the API absent

describe('listCameras when the API is missing', () => {
  it('returns an empty list when there is no navigator at all', async () => {
    swapGlobal('navigator', undefined)
    await expect(listCameras()).resolves.toEqual([])
  })

  it('returns an empty list on an insecure origin, where mediaDevices is undefined', async () => {
    swapGlobal('navigator', {})
    await expect(listCameras()).resolves.toEqual([])
  })

  it('returns an empty list when enumerateDevices is not a function', async () => {
    swapGlobal('navigator', { mediaDevices: {} })
    await expect(listCameras()).resolves.toEqual([])
  })

  it('reports a rejected enumerateDevices instead of throwing or going quiet', async () => {
    const media = installMediaDevices()
    media.failure = new Error('media stack is on fire')
    const logs = captureConsole()

    await expect(listCameras()).resolves.toEqual([])
    expect(logs.warnings).toHaveLength(1)
  })

  it('survives an enumerateDevices that resolves to something that is not an array', async () => {
    swapGlobal('navigator', { mediaDevices: { enumerateDevices: async () => null } })
    await expect(listCameras()).resolves.toEqual([])
  })

  it('returns an empty list when the machine has no camera', async () => {
    installMediaDevices()
    await expect(listCameras()).resolves.toEqual([])
  })
})

// --------------------------------------------------------------------- enumeration

describe('listCameras', () => {
  it('keeps only video inputs, so microphones and speakers cannot reach the picker', async () => {
    const media = installMediaDevices()
    media.list = [
      { kind: 'audioinput', label: 'MacBook Pro Microphone', deviceId: 'mic' },
      videoInput('FaceTime HD Camera', 'lid'),
      { kind: 'audiooutput', label: 'MacBook Pro Speakers', deviceId: 'spk' },
    ]

    const cameras = await listCameras()

    expect(cameras).toHaveLength(1)
    expect(cameras[0]?.deviceId).toBe('lid')
  })

  it('preserves the browser order, because the first video input is the system default', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('FaceTime HD Camera', 'lid'), videoInput("Nai's iPhone Camera", 'phone')]

    const cameras = await listCameras()

    expect(cameras.map((c) => c.deviceId)).toEqual(['lid', 'phone'])
  })

  it('passes the real label through untouched when the browser gives one', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('  Logitech BRIO  ', 'usb')]

    const [camera] = await listCameras()

    expect(camera?.label).toBe('Logitech BRIO')
    expect(camera?.labelWithheld).toBe(false)
  })
})

// ------------------------------------------------------- withheld labels (trap #1)

describe('listCameras before a permission grant', () => {
  it('flags every withheld label and synthesises a human-sensible name', async () => {
    const media = installMediaDevices()
    // What enumerateDevices really returns pre-grant: no labels, and here no ids either.
    media.list = [videoInput('', ''), videoInput('', '')]

    const cameras = await listCameras()

    expect(cameras.map((c) => c.label)).toEqual(['Camera 1', 'Camera 2'])
    expect(cameras.every((c) => c.labelWithheld)).toBe(true)
    expect(cameras.every((c) => c.kind === 'unknown')).toBe(true)
  })

  it('treats a whitespace-only label as withheld rather than rendering a blank row', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('   ', 'ghost')]

    const [camera] = await listCameras()

    expect(camera?.labelWithheld).toBe(true)
    expect(camera?.label).toBe('Camera 1')
  })

  it('never invents a deviceId, because a made-up id would fail getUserMedia', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('', '')]

    const [camera] = await listCameras()

    expect(camera?.deviceId).toBe('')
  })

  it('gives the same synthesised names on every call, so the list does not shuffle', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('', 'a'), videoInput('', 'b'), videoInput('', 'c')]

    const first = await listCameras()
    const second = await listCameras()

    expect(second.map((c) => c.label)).toEqual(first.map((c) => c.label))
    expect(second.map((c) => c.label)).toEqual(['Camera 1', 'Camera 2', 'Camera 3'])
    expect(media.calls).toBe(2)
  })

  it('numbers by slot among video inputs, so a named neighbour does not shift the count', async () => {
    const media = installMediaDevices()
    media.list = [
      { kind: 'audioinput', label: 'Mic', deviceId: 'mic' },
      videoInput('FaceTime HD Camera', 'lid'),
      videoInput('', 'mystery'),
    ]

    const cameras = await listCameras()

    expect(cameras.map((c) => c.label)).toEqual(['FaceTime HD Camera', 'Camera 2'])
  })
})

// ----------------------------------------------------------- classification (trap #2)

describe('camera kind', () => {
  const CASES: readonly (readonly [string, CameraKind])[] = [
    ["Nai's iPhone Camera", 'iphone'],
    ['iPhone12Pro Camera', 'iphone'],
    ['Continuity Camera', 'iphone'],
    ['FaceTime HD Camera (Built-in)', 'builtin'],
    ['Built-in Webcam', 'builtin'],
    ['Integrated Camera', 'builtin'],
    ['Internal Camera', 'builtin'],
    ['Logitech BRIO', 'external'],
    ['USB Capture HDMI', 'external'],
    ['', 'unknown'],
  ]

  it('classifies each label shape', async () => {
    const media = installMediaDevices()
    media.list = CASES.map(([label], i) => videoInput(label, `id-${i}`))

    const cameras = await listCameras()

    expect(cameras.map((c) => c.kind)).toEqual(CASES.map(([, kind]) => kind))
  })

  it('calls a label that matches BOTH groups an iPhone, the specific case beating the broad one', async () => {
    const media = installMediaDevices()
    // Contrived, but it is the only input that can tell the two orderings apart, and the
    // ordering is a claim the source comment makes.
    media.list = [videoInput('iPhone Internal Camera', 'both')]

    const [camera] = await listCameras()

    expect(camera?.kind).toBe('iphone')
  })

  it('never lets a failed match drop a device from the list', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('?????', 'weird'), videoInput('', 'nameless')]

    const cameras = await listCameras()

    expect(cameras).toHaveLength(2)
    expect(cameras.map((c) => c.kind)).toEqual(['external', 'unknown'])
  })

  it('has a badge for every kind', () => {
    for (const kind of KINDS) expect(CAMERA_PICKER.KIND_LABEL[kind]).toMatch(/^[A-Z-]+$/)
    expect(Object.keys(CAMERA_PICKER.KIND_LABEL)).toHaveLength(KINDS.length)
  })

  it('carries no sticky global regexes, which would make test() alternate per call', () => {
    const patterns = [...CAMERA_LABEL_PATTERNS.iphone, ...CAMERA_LABEL_PATTERNS.builtin]
    for (const pattern of patterns) expect(pattern.flags).not.toContain('g')
    for (const pattern of CAMERA_LABEL_PATTERNS.iphone) {
      expect(pattern.test('iPhone Camera') || pattern.test('Continuity Camera')).toBe(true)
    }
  })
})

// --------------------------------------------------------- devicechange (trap #2)

describe('onCameraChange', () => {
  it('fans out to two subscribers, which the ondevicechange property form cannot do', () => {
    const media = installMediaDevices()
    const seen: string[] = []
    const offPicker = onCameraChange(() => void seen.push('picker'))
    const offOverlay = onCameraChange(() => void seen.push('overlay'))

    media.emitDeviceChange()

    expect(seen).toEqual(['picker', 'overlay'])
    offPicker()
    offOverlay()
  })

  it('unsubscribes exactly one subscriber and leaves the other working', () => {
    const media = installMediaDevices()
    const seen: string[] = []
    const offPicker = onCameraChange(() => void seen.push('picker'))
    onCameraChange(() => void seen.push('overlay'))

    offPicker()
    media.emitDeviceChange()

    expect(seen).toEqual(['overlay'])
  })

  it('is idempotent, because a StrictMode effect cleanup runs twice', () => {
    const media = installMediaDevices()
    let calls = 0
    const off = onCameraChange(() => void (calls += 1))

    off()
    off()
    media.emitDeviceChange()

    expect(calls).toBe(0)
  })

  it('sees the iPhone that appeared, which is the whole point of subscribing', async () => {
    const media = installMediaDevices()
    media.list = [videoInput('FaceTime HD Camera', 'lid')]
    let refreshes = 0
    const off = onCameraChange(() => void (refreshes += 1))

    // The phone wakes up near the Mac: a new device, then the event.
    media.list = [videoInput('FaceTime HD Camera', 'lid'), videoInput("Nai's iPhone Camera", 'phone')]
    media.emitDeviceChange()
    const cameras = await listCameras()

    expect(refreshes).toBe(1)
    expect(cameras.map((c) => c.kind)).toEqual(['builtin', 'iphone'])
    off()
  })

  it('reports a throwing subscriber without starving the next one', () => {
    const media = installMediaDevices()
    const logs = captureConsole()
    const seen: string[] = []
    const offBad = onCameraChange(() => {
      throw new Error('subscriber bug')
    })
    const offGood = onCameraChange(() => void seen.push('overlay'))

    media.emitDeviceChange()

    expect(seen).toEqual(['overlay'])
    expect(logs.errors).toHaveLength(1)
    offBad()
    offGood()
  })

  it('returns a harmless unsubscribe when there is no API to subscribe to', () => {
    swapGlobal('navigator', {})
    const off = onCameraChange(() => void 0)
    expect(() => off()).not.toThrow()
  })
})

// ------------------------------------------------------------------ persistence

describe('rememberCamera / recalledCamera', () => {
  it('round-trips a choice through storage under a namespaced key', () => {
    const cells = installStorage()

    rememberCamera('phone-id')

    expect(cells.get(CAMERA_PICKER.STORAGE_KEY)).toBe('phone-id')
    expect(recalledCamera()).toBe('phone-id')
  })

  it('recalls null when nothing was ever chosen', () => {
    installStorage()
    expect(recalledCamera()).toBeNull()
  })

  it('forgets the choice on null, which is how the UI returns to the system default', () => {
    const cells = installStorage()
    rememberCamera('phone-id')

    rememberCamera(null)

    expect(cells.has(CAMERA_PICKER.STORAGE_KEY)).toBe(false)
    expect(recalledCamera()).toBeNull()
  })

  it('treats an empty id as forgetting rather than storing a useless key', () => {
    const cells = installStorage()
    rememberCamera('phone-id')

    rememberCamera('')

    expect(cells.has(CAMERA_PICKER.STORAGE_KEY)).toBe(false)
  })

  it('rejects a corrupted oversized value instead of handing it to getUserMedia', () => {
    const cells = installStorage()
    cells.set(CAMERA_PICKER.STORAGE_KEY, 'x'.repeat(CAMERA_PICKER.MAX_REMEMBERED_ID_LENGTH + 1))

    expect(recalledCamera()).toBeNull()
  })

  it('rejects a whitespace-only value', () => {
    const cells = installStorage()
    cells.set(CAMERA_PICKER.STORAGE_KEY, '   ')

    expect(recalledCamera()).toBeNull()
  })

  it('degrades to no persistence when setItem throws, as in private-mode Safari', () => {
    installStorage({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    const logs = captureConsole()

    expect(() => rememberCamera('phone-id')).not.toThrow()
    expect(logs.warnings).toHaveLength(1)
    expect(recalledCamera()).toBeNull()
  })

  it('degrades when getItem throws', () => {
    installStorage({
      getItem: () => {
        throw new Error('blocked')
      },
    })
    const logs = captureConsole()

    expect(recalledCamera()).toBeNull()
    expect(logs.warnings).toHaveLength(1)
  })

  it('degrades when removeItem throws', () => {
    installStorage({
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    captureConsole()

    expect(() => rememberCamera(null)).not.toThrow()
  })

  it('degrades when the localStorage GETTER itself throws, as in a sandboxed iframe', () => {
    installHostileStorageGetter()
    const logs = captureConsole()

    expect(() => rememberCamera('phone-id')).not.toThrow()
    expect(recalledCamera()).toBeNull()
    expect(logs.warnings).toHaveLength(2)
  })

  it('degrades when there is no storage object at all', () => {
    swapGlobal('localStorage', undefined)

    expect(() => rememberCamera('phone-id')).not.toThrow()
    expect(recalledCamera()).toBeNull()
  })
})

// ------------------------------------------------------------------- the tunables

describe('CAMERA_PICKER', () => {
  it('has copy for every state the picker can be in', () => {
    for (const [key, line] of Object.entries(CAMERA_PICKER.COPY)) {
      expect(line.length, key).toBeGreaterThan(0)
      expect(line.trim(), key).toBe(line)
    }
  })

  it('keeps the tunables in a sane range', () => {
    expect(CAMERA_PICKER.REFRESH_DEBOUNCE_MS).toBeGreaterThan(0)
    expect(CAMERA_PICKER.REFRESH_DEBOUNCE_MS).toBeLessThan(2_000)
    expect(CAMERA_PICKER.MAX_REMEMBERED_ID_LENGTH).toBeGreaterThan(64)
    expect(CAMERA_PICKER.DEVICE_CHANGE_EVENT).toBe('devicechange')
    expect(CAMERA_PICKER.STORAGE_KEY).toMatch(/^spotter\./)
  })
})
