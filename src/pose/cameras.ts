/**
 * WHICH CAMERA IS LOOKING AT YOU. Enumeration, naming, and remembering — no stream opening.
 *
 * A laptop lid camera cannot see someone on the floor doing pushups; a propped-up iPhone can.
 * On macOS a Continuity Camera needs no special API at all — the phone simply shows up as
 * another `videoinput` once it is nearby and awake. So the whole feature is device
 * enumeration done honestly, and this file is the honest part: pure queries over
 * `navigator.mediaDevices` plus one localStorage slot. It opens no streams and touches no
 * DOM, which is what makes it testable without a browser and safe to call from anywhere.
 *
 * THE FOUR FACTS THAT SHAPE EVERY FUNCTION HERE:
 *
 *   1. LABELS ARE WITHHELD UNTIL A GRANT EXISTS. Before a successful getUserMedia,
 *      `enumerateDevices()` returns entries whose `label` is `''` — and in some browsers a
 *      `deviceId` that is `''` too. A picker that renders those raw shows three nameless
 *      rows, so `labelWithheld` exists to let the UI say "allow the camera to see device
 *      names" instead. That state is legitimate, not an error: the device COUNT is real
 *      even when the names are not.
 *   2. A CONTINUITY IPHONE COMES AND GOES. It appears when the phone wakes near the Mac and
 *      vanishes when it sleeps or leaves. A list fetched once is wrong within a minute,
 *      which is why `onCameraChange` is not optional garnish — without it the iPhone the
 *      user is hunting for is simply absent from the list they are staring at.
 *   3. `navigator.mediaDevices` MAY NOT EXIST AT ALL. On an insecure origin it is undefined
 *      rather than throwing, so every entry point guards the API instead of assuming it.
 *      Nothing here throws; an unavailable API is an empty list and a dead unsubscribe.
 *   4. STORAGE CAN THROW ON WRITE. Safari private mode throws from `setItem`, and a
 *      sandboxed iframe throws from the `localStorage` GETTER itself. Persistence is a
 *      convenience, so it degrades to no-persistence rather than taking the app with it.
 *
 * TUNABLES AND COPY LIVE IN: `CAMERA_PICKER`. Label matching lives in
 * `CAMERA_LABEL_PATTERNS`, deliberately one constant so it can be tuned without hunting.
 */

export type CameraKind = 'builtin' | 'iphone' | 'external' | 'unknown'

export interface CameraDevice {
  /**
   * Exactly what the browser reported, never invented.
   *
   * MAY BE `''` while `labelWithheld` is true: some browsers zero the id along with the
   * label until a grant exists. An empty id cannot be passed to `getUserMedia` and must not
   * be used as a list key — when `labelWithheld` is true the correct UI is "grant
   * permission", not "pick one of these".
   */
  readonly deviceId: string
  /** Human label. Synthesised ("Camera 1") when the browser withholds it. */
  readonly label: string
  readonly kind: CameraKind
  /** True when the browser reports no usable label yet — i.e. permission is still needed. */
  readonly labelWithheld: boolean
}

/**
 * LABEL MATCHING IS A HEURISTIC. There is no API that says "this is the iPhone"; all we get
 * is a human-readable string chosen by the OS, which varies by platform, browser, and
 * locale, and which the user can rename. Every pattern below is therefore a guess whose
 * only job is to pick an icon and a badge. Nothing functional may depend on it: a device
 * that classifies as `unknown` or `external` must still be selectable, and a failed match
 * must never remove a row from the list.
 *
 * WHY `/iphone/i` IS UNANCHORED. `\biphone\b` looks tidier and is worse: it misses
 * "iPhone12Pro Camera" because the digit after "iPhone" leaves no word boundary. The
 * asymmetry of the errors decides it — a false positive costs a wrong badge, a false
 * negative hides the exact device the user came here to select.
 *
 * NO `g` FLAG ON ANY PATTERN, because these are module-level regexes reused across calls and
 * a sticky `lastIndex` would make `test()` return alternating answers for one string.
 *
 * Checked in the order the properties appear: iPhone first, since a Continuity label is the
 * specific case and the internal-camera words are the broad one.
 */
export const CAMERA_LABEL_PATTERNS = {
  /** macOS says "<Name>'s iPhone Camera"; some builds say "Continuity Camera". */
  iphone: [/iphone/i, /continuity/i],
  /** The obvious internal names across macOS, Windows, and Linux. */
  builtin: [/facetime/i, /built[\s_-]?in/i, /\bintegrated\b/i, /\binternal\b/i],
} as const

/** Badge text per kind. Exhaustive by construction — a new `CameraKind` will not compile. */
const KIND_LABEL: Readonly<Record<CameraKind, string>> = {
  builtin: 'BUILT-IN',
  iphone: 'IPHONE',
  external: 'USB',
  unknown: 'CAMERA',
}

/** Camera-picker behaviour and wording. Recalibrate here, nowhere else. */
export const CAMERA_PICKER = {
  /**
   * localStorage slot for the remembered choice. Namespaced because this app shares an
   * origin with anything else served from the same host in development.
   */
  STORAGE_KEY: 'spotter.camera.deviceId',
  /** The `MediaDevices` event name. Named so the subscribe and unsubscribe cannot drift. */
  DEVICE_CHANGE_EVENT: 'devicechange',
  /** Prefix for a synthesised name when the browser withholds the real one. */
  FALLBACK_LABEL_PREFIX: 'Camera',
  /**
   * Sanity cap on a recalled id. Real `deviceId`s are ~44-64 base64/hex characters; 512
   * accepts every plausible one while refusing a corrupted or hostile localStorage value
   * before it reaches `getUserMedia`.
   */
  MAX_REMEMBERED_ID_LENGTH: 512,
  /**
   * How long a caller should wait after a `devicechange` before re-enumerating. The event
   * arrives two or three times in a burst when one device appears (the OS publishes the
   * camera and its microphone separately), and each `enumerateDevices()` is a round trip
   * into the media stack, so coalescing the burst is worth a quarter second of latency.
   */
  REFRESH_DEBOUNCE_MS: 250,
  KIND_LABEL,
  /** User-facing copy: SHOUTY for pills and buttons, sentences for explanations. */
  COPY: {
    TITLE: 'CAMERA',
    /** The option that lets the browser choose — i.e. no remembered deviceId. */
    SYSTEM_DEFAULT: 'System default',
    REFRESH: 'REFRESH',
    /** Labels are withheld: the honest ask, rendered instead of nameless rows. */
    NEEDS_PERMISSION: 'Allow the camera once and the device names will appear here.',
    NO_CAMERAS: 'No camera found. Connect one, or wake an iPhone nearby.',
    /** Nudge for the feature nobody knows exists. */
    IPHONE_HINT: 'An unlocked iPhone near this Mac shows up here as a camera.',
    /** A remembered device that is gone — startup fell back rather than failing. */
    REMEMBERED_MISSING: 'That camera is no longer connected. Using the default one instead.',
    /** An active stream ended under us, e.g. the iPhone went to sleep mid-set. */
    TRACK_ENDED: 'The camera stopped. Falling back to another one.',
    /**
     * NOT "staying on the current one", which is what this used to say and what the code
     * cannot deliver: `createCameraOwner.acquire` stops the old tracks BEFORE it opens the
     * new device (two live streams mean two camera lights, and a Continuity iPhone refuses
     * a second open), so by the time a switch has failed there is no current camera left to
     * stay on. Reaching this means the chosen camera AND the default both refused.
     */
    SWITCH_FAILED: 'Could not switch cameras, and the last one has already let go. Pick a camera again.',
    UNAVAILABLE_API: 'This browser exposes no camera list — SPOTTER needs https or localhost.',
  },
} as const

/** Frozen so the "no cameras" answer cannot be mutated by a caller. */
const NO_CAMERAS: readonly CameraDevice[] = Object.freeze([])

const NO_OP = (): void => undefined

function matchesAny(label: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(label))
}

/** See `CAMERA_LABEL_PATTERNS`: a guess for a badge, never a functional gate. */
function classify(label: string): CameraKind {
  if (label === '') return 'unknown'
  if (matchesAny(label, CAMERA_LABEL_PATTERNS.iphone)) return 'iphone'
  if (matchesAny(label, CAMERA_LABEL_PATTERNS.builtin)) return 'builtin'
  return 'external'
}

/**
 * One enumerated entry, described.
 *
 * `position` is the 1-based index among video inputs, and it is the whole stability story
 * for synthesised names: the same camera in the same slot gets the same "Camera 2" on every
 * call, so the UI does not shuffle between refreshes.
 *
 * WHY THE BROWSER'S ORDER IS PRESERVED RATHER THAN SORTED. Sorting by id or label would also
 * be stable, and would throw away the one piece of information the order carries — the
 * first video input is the system default. A picker whose first row is not the default
 * camera lies about what "System default" will open.
 */
function describe(device: MediaDeviceInfo, position: number): CameraDevice {
  // Defensive reads: this is an external API surface, and a withheld label is sometimes
  // whitespace rather than an empty string.
  const rawLabel = typeof device.label === 'string' ? device.label.trim() : ''
  const deviceId = typeof device.deviceId === 'string' ? device.deviceId : ''
  const labelWithheld = rawLabel === ''
  return {
    deviceId,
    label: labelWithheld ? `${CAMERA_PICKER.FALLBACK_LABEL_PREFIX} ${position}` : rawLabel,
    kind: classify(rawLabel),
    labelWithheld,
  }
}

/** `undefined` on an insecure origin or a non-browser runtime, never a throw. */
function mediaDevices(): MediaDevices | undefined {
  const nav: Navigator | undefined = globalThis.navigator
  return nav?.mediaDevices
}

/**
 * Enumerate video inputs. Never throws; returns [] when the API is absent.
 *
 * Empty means one of three different things — no API, no cameras, or a failed query — and
 * the UI distinguishes them with `CAMERA_PICKER.COPY`, not by inspecting this result.
 */
export async function listCameras(): Promise<readonly CameraDevice[]> {
  const media = mediaDevices()
  if (!media || typeof media.enumerateDevices !== 'function') return NO_CAMERAS

  let devices: readonly MediaDeviceInfo[]
  try {
    devices = await media.enumerateDevices()
  } catch (cause) {
    // Not silent, and not fatal: a picker that cannot list is a picker that shows the
    // "no camera" copy, while the already-running stream keeps running.
    console.warn('[cameras] enumerateDevices failed', cause)
    return NO_CAMERAS
  }
  if (!Array.isArray(devices)) return NO_CAMERAS

  const cameras: CameraDevice[] = []
  for (const device of devices) {
    if (device?.kind !== 'videoinput') continue
    cameras.push(describe(device, cameras.length + 1))
  }
  return cameras
}

/**
 * Subscribe to devicechange. Returns an unsubscribe function.
 *
 * `addEventListener`, NOT `ondevicechange`: the property form has exactly one slot, so the
 * second subscriber silently evicts the first — and the overlay that wants to re-measure
 * and the picker that wants to re-list are two subscribers. Distinct handler objects
 * coexist here with no registry of our own.
 */
export function onCameraChange(listener: () => void): () => void {
  const media = mediaDevices()
  if (!media || typeof media.addEventListener !== 'function') return NO_OP

  const handler = (): void => {
    try {
      listener()
    } catch (cause) {
      // One subscriber's bug must not cost the others their notification — losing it means
      // a stale camera list, which is precisely the failure this subscription exists to
      // prevent. Reported, not swallowed.
      console.error('[cameras] devicechange listener threw', cause)
    }
  }
  media.addEventListener(CAMERA_PICKER.DEVICE_CHANGE_EVENT, handler)

  // No `already unsubscribed` latch: `removeEventListener` for a handler that is not
  // registered is a no-op by spec, so the double call a StrictMode effect cleanup makes is
  // already harmless and a flag would only be untestable weight. `media` and `handler` are
  // captured, so this removes THIS subscription even if `navigator.mediaDevices` is replaced.
  return () => media.removeEventListener(CAMERA_PICKER.DEVICE_CHANGE_EVENT, handler)
}

/** `null` when storage is unavailable — including when the getter itself throws. */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch (cause) {
    // A sandboxed iframe or blocked-cookie Safari throws on the PROPERTY ACCESS, before any
    // method call, so this try wraps the read itself rather than the write below.
    console.warn('[cameras] localStorage is unavailable', cause)
    return undefined
  }
}

/**
 * Persist the user's choice across reloads. `null` (or `''`) forgets it.
 *
 * Forgetting matters: it is how the UI says "go back to the system default" without
 * inventing a sentinel id that `getUserMedia` would then reject.
 */
export function rememberCamera(deviceId: string | null): void {
  const store = storage()
  if (!store) return
  try {
    if (deviceId === null || deviceId === '') store.removeItem(CAMERA_PICKER.STORAGE_KEY)
    else store.setItem(CAMERA_PICKER.STORAGE_KEY, deviceId)
  } catch (cause) {
    // Private-mode Safari throws from setItem even though the object exists. The choice
    // still applies to this session; it just will not survive a reload.
    console.warn('[cameras] could not persist the camera choice', cause)
  }
}

/**
 * Recall the user's choice, or `null`.
 *
 * VALIDATED, because localStorage is external data: another tab, an extension, or a stale
 * build could have left anything here, and this value is destined for a `deviceId`
 * constraint. A remembered id is also allowed to be STALE — yesterday's iPhone may simply
 * not exist today — so the caller must treat a non-null answer as a request, not a promise,
 * and fall back to the default camera when the device is gone.
 */
export function recalledCamera(): string | null {
  const store = storage()
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(CAMERA_PICKER.STORAGE_KEY)
  } catch (cause) {
    console.warn('[cameras] could not read the remembered camera', cause)
    return null
  }
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (id === '' || id.length > CAMERA_PICKER.MAX_REMEMBERED_ID_LENGTH) return null
  return id
}
