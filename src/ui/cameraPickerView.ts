/**
 * The camera picker's presentation logic — every decision that can be made WITHOUT a
 * camera, a DOM or a permission prompt, so all of it can be tested without any of
 * them. The component (CameraPicker.tsx) and the two hooks beside it hold the effects;
 * this file holds the judgements.
 *
 * THE FOUR JUDGEMENTS, and why each one is here rather than inline in JSX:
 *
 * 1. WHETHER TO SHOW A CONTROL AT ALL (`pickerMode`). A device list is only a
 *    question worth asking when there is more than one answer. Five states, not two:
 *    no API at all, an API and no cameras, cameras whose names the browser is still
 *    withholding, exactly one camera, and a real choice. Each renders something
 *    different, and rendering an EMPTY radiogroup for the middle three is the failure
 *    this function exists to prevent.
 * 2. WHAT THE SELECTION ACTUALLY RESOLVES TO (`resolveSelection`). The id we are
 *    handed may name a camera that walked out of the room — a Continuity iPhone
 *    remembered from yesterday is the normal case, not the edge case. The resolved
 *    selection therefore carries `missingId`, so the UI can fall back to the default
 *    camera AND say so, instead of either lying or breaking.
 * 3. WHAT A ROW SAYS (`cameraRows`). Labels arrive synthesised ("Camera 1") when the
 *    browser withholds them, so a row never invents a name; the kind becomes a badge,
 *    and 'iphone' also becomes a recommendation, because that is the device the user
 *    came here for.
 * 4. WHAT JUST CHANGED (`arrivedIds` / `arrivalNote`). The iPhone appears when the
 *    phone wakes and disappears when it sleeps. A row that materialises silently
 *    reads as a glitch; the same row announced reads as the feature working.
 *
 * KIND IS A HEURISTIC, LABEL IS NOT A PROMISE. Every function here treats an unknown
 * kind and a withheld label as ordinary, expected inputs — nothing throws, nothing
 * filters a device out of the list for failing to match a pattern.
 */
import type { CameraDevice, CameraKind } from '../pose/cameras'
import { CAMERA_PICKER } from '../pose/cameras'

/**
 * Tunables for the picker's own behaviour — the ones that are about THIS screen.
 * Anything shared with the device layer or the engine (the devicechange debounce, the
 * kind badges, the storage key) stays in `CAMERA_PICKER` over in src/pose/cameras.ts
 * and is read from there, so there is one number and one spelling per decision.
 */
export const CAMERA_PICKER_UI = {
  /** A preview is a thumbnail, not the workout feed — ask for little. */
  previewWidthIdeal: 640,
  previewHeightIdeal: 360,
  /** How long a row that has just appeared stays marked as new. */
  arrivalMarkMs: 2600,
  /**
   * Mirrors the workout screen's own default constraint, so an unconstrained preview
   * is the same shot the workout will open rather than a different camera.
   */
  defaultFacingMode: 'user',
  /** HTMLMediaElement.HAVE_CURRENT_DATA — enough to have painted one frame. */
  canPaint: 2,
  /**
   * How far to scroll a freshly opened panel into view. MEASURED, not decorative: the
   * intro is a fixed-height scroller (`main.intro` is the scroll container) and the
   * camera block is the LAST thing in it, so at 1440x900 exactly 9 px of a 111 px panel
   * was on screen after a click, and at 390x844 none of it was. Opening a panel nobody
   * can see is indistinguishable from a dead button — except that the camera light comes
   * on. 'nearest' scrolls the minimum distance, so the coach cards the user was just
   * looking at stay where they were.
   */
  panelScrollBlock: 'nearest',
} as const

/**
 * Every string the picker can say, in one place, so the whole script can be read at
 * once. Two of them are functions because they name a device, and a sentence that
 * names the wrong device is worse than no sentence.
 *
 * THE THREE STATE SENTENCES ARE NOT RETYPED HERE. "No camera API", "no cameras" and
 * "names are withheld" are the same facts the engine and the device layer report, so
 * they come from `CAMERA_PICKER.COPY`; a second wording of the same state would drift.
 * What IS written here is the intro's own voice — sentence case, because the caps in
 * this design come from `text-transform`, not from the string.
 */
export const CAMERA_PICKER_COPY = {
  /** Sentence case on purpose: the CSS uppercases it, and AT should not be shouted at. */
  heading: 'Camera',
  keyHint: 'to switch',
  open: 'Change camera',
  /** One camera: there is nothing to change TO, but the shot is still worth seeing. */
  openOne: 'Check the shot',
  close: 'Done',
  grant: 'Allow camera access to see device names',
  grantNote: CAMERA_PICKER.COPY.NEEDS_PERMISSION,
  grantRefused: 'Camera access was refused, so the names stay hidden.',
  unsupported: CAMERA_PICKER.COPY.UNAVAILABLE_API,
  empty: CAMERA_PICKER.COPY.NO_CAMERAS,
  looking: 'Looking for cameras…',
  one: (label: string) => `${label} — the only camera here.`,
  iphoneFlag: 'iPhone available',
  iphoneArrived: 'An iPhone camera just appeared in the list.',
  /** Why to pick the phone, once one is actually there. */
  floorHint: 'A propped-up iPhone can see the floor; a laptop lid cannot.',
  /** That a phone CAN be there, when none is — the discovery half of the feature. */
  iphoneTeach: CAMERA_PICKER.COPY.IPHONE_HINT,
  previewLost: 'That camera stopped sending frames — it may have gone to sleep.',
  previewGone: 'That camera is no longer connected. Falling back to the default camera.',
  previewDenied: 'Camera access was refused, so there is no preview.',
  previewFailed: 'That camera would not open a preview.',
  previewUnsupported: 'No camera API here, so there is no preview.',
  missing: (label: string) => `The camera you used last is not here — using ${label}.`,
  defaultLabel: 'the default camera',
} as const

/**
 * The preview's own five states. 'off' and 'starting' are separate because they look
 * identical in a boolean and must not look identical on screen: one is a dark box the
 * user turned off, the other is a dark box that is about to fill.
 */
export type PreviewStatus = 'off' | 'starting' | 'live' | 'lost' | 'failed'

/** The label ON the preview. Short — the full sentence goes in the notice line. */
export const PREVIEW_STATUS_TEXT: Readonly<Record<PreviewStatus, string>> = Object.freeze({
  off: 'Preview off',
  starting: 'Opening camera…',
  live: 'Live preview',
  lost: 'Frames stopped',
  failed: 'No preview',
})

/**
 * 'unsupported' — no camera API. 'empty' — an API and no cameras. 'locked' — cameras
 * whose names are all still withheld. 'single' — one camera, so no question to ask.
 * 'choice' — a real decision.
 */
export type PickerMode = 'unsupported' | 'empty' | 'locked' | 'single' | 'choice'

/** 'selected' — chosen by the user. 'default' — what the browser will pick anyway. */
export type RowState = 'selected' | 'default' | 'idle'

export interface CameraRow {
  readonly deviceId: string
  readonly label: string
  readonly kind: CameraKind
  /**
   * From CAMERA_PICKER.KIND_LABEL, so the badge and the engine agree on the words —
   * except for 'unknown', which gets none. Labelling an unidentified camera "CAMERA"
   * beside its own name is noise, and the kind is a heuristic, so a shrug is honest.
   */
  readonly badge: string | null
  /** True for the device this feature exists for, so the UI can mark it. */
  readonly recommended: boolean
  readonly state: RowState
}

export interface ResolvedSelection {
  /** The id to open, or null to let the browser choose. */
  readonly deviceId: string | null
  /** True when nothing was chosen, or the choice is gone. */
  readonly usingDefault: boolean
  /** A remembered id that is not in the list — the UI must say so, not hide it. */
  readonly missingId: string | null
}

export function pickerMode(cameras: readonly CameraDevice[], apiAvailable: boolean): PickerMode {
  if (!apiAvailable) return 'unsupported'
  if (cameras.length === 0) return 'empty'
  // SOME withheld is not locked: a partly-named list is still a usable list.
  if (cameras.every((camera) => camera.labelWithheld)) return 'locked'
  return cameras.length === 1 ? 'single' : 'choice'
}

/** A device list is only worth rendering when a device can actually be picked. */
export function showsDeviceList(mode: PickerMode): boolean {
  return mode === 'single' || mode === 'choice'
}

/**
 * The withheld-label state gets an affordance, not three nameless rows — and so does
 * the PARTIAL case, where one camera is named and another is not. That happens on a
 * device that appears after the grant was taken, and "Camera 2" beside a real name is
 * exactly the moment the button is worth offering.
 */
export function needsGrant(cameras: readonly CameraDevice[], mode: PickerMode): boolean {
  if (mode === 'locked') return true
  if (mode === 'unsupported' || mode === 'empty') return false
  return cameras.some((camera) => camera.labelWithheld)
}

/**
 * How loudly the block presents itself. One camera is a fact, not a decision, so it
 * gets no material at all; a real choice — or a permission we need — earns a surface.
 */
export function emphasis(mode: PickerMode): 'quiet' | 'offered' {
  return mode === 'choice' || mode === 'locked' ? 'offered' : 'quiet'
}

export function resolveSelection(
  cameras: readonly CameraDevice[],
  selectedId: string | null,
): ResolvedSelection {
  if (selectedId === null) return { deviceId: null, usingDefault: true, missingId: null }
  const found = cameras.some((camera) => camera.deviceId === selectedId)
  if (found) return { deviceId: selectedId, usingDefault: false, missingId: null }
  // The remembered camera has left the room. Default, and report the id so the caller
  // can say which choice it could not honour.
  return { deviceId: null, usingDefault: true, missingId: selectedId }
}

/** The camera the picker is really showing: the choice, else the presumed default. */
export function effectiveCamera(
  cameras: readonly CameraDevice[],
  resolved: ResolvedSelection,
): CameraDevice | null {
  if (resolved.deviceId !== null) {
    return cameras.find((camera) => camera.deviceId === resolved.deviceId) ?? null
  }
  return cameras[0] ?? null
}

/** Best guess at what "the default camera" is called, for a sentence that names it. */
export function defaultCameraLabel(cameras: readonly CameraDevice[]): string {
  return cameras[0]?.label ?? CAMERA_PICKER_COPY.defaultLabel
}

/**
 * A ROW IS SOMETHING THAT CAN BE PICKED, which is why this filters on `deviceId`.
 * Some browsers zero the id along with the label until a grant exists (see the
 * CameraDevice contract), and an empty id is neither a usable getUserMedia constraint
 * nor a usable React key. Such an entry is not dropped from the PICTURE — `pickerMode`
 * still counts it, so the list is 'locked' or the grant button is offered — it is only
 * dropped from the set of things the user is invited to click.
 */
export function cameraRows(
  cameras: readonly CameraDevice[],
  resolved: ResolvedSelection,
): readonly CameraRow[] {
  return cameras
    .filter((camera) => camera.deviceId !== '')
    .map((camera, index) => ({
      deviceId: camera.deviceId,
      label: camera.label,
      kind: camera.kind,
      badge: camera.kind === 'unknown' ? null : CAMERA_PICKER.KIND_LABEL[camera.kind],
      recommended: camera.kind === 'iphone',
      state: rowState(camera, index, resolved),
    }))
}

/**
 * The browser's default is listed first by every engine we target, so marking row 0
 * 'default' rather than 'selected' keeps the radiogroup well formed without claiming
 * the user chose it. If that guess is ever wrong the row still opens the same camera.
 */
function rowState(camera: CameraDevice, index: number, resolved: ResolvedSelection): RowState {
  if (resolved.deviceId === camera.deviceId) return 'selected'
  if (resolved.usingDefault && index === 0) return 'default'
  return 'idle'
}

export const ROW_STATE_TEXT: Readonly<Record<RowState, string>> = Object.freeze({
  selected: 'Selected',
  default: 'Default',
  idle: 'Select',
})

/**
 * What the one button says. "Change camera" in front of a user who has exactly one
 * camera promises something that cannot happen; the preview is still worth opening, so
 * the offer changes rather than disappearing.
 */
export function toggleLabel(mode: PickerMode, open: boolean): string {
  if (open) return CAMERA_PICKER_COPY.close
  return mode === 'single' ? CAMERA_PICKER_COPY.openOne : CAMERA_PICKER_COPY.open
}

/** Ids present in `next` and not in `previous`. Empty on a first load, by definition. */
export function arrivedIds(
  previous: readonly CameraDevice[],
  next: readonly CameraDevice[],
): readonly string[] {
  if (previous.length === 0) return []
  const known = new Set(previous.map((camera) => camera.deviceId))
  return next.filter((camera) => !known.has(camera.deviceId)).map((camera) => camera.deviceId)
}

/**
 * Spoken only for the iPhone. A USB camera being plugged in is the user's own doing
 * and needs no narration; a phone waking up across the room is the thing that looks
 * like a glitch unless it is named.
 */
export function arrivalNote(
  previous: readonly CameraDevice[],
  next: readonly CameraDevice[],
): string | null {
  const fresh = new Set(arrivedIds(previous, next))
  const iphone = next.some((camera) => fresh.has(camera.deviceId) && camera.kind === 'iphone')
  return iphone ? CAMERA_PICKER_COPY.iphoneArrived : null
}

export function hasIphone(cameras: readonly CameraDevice[]): boolean {
  return cameras.some((camera) => camera.kind === 'iphone')
}

/** The one line the collapsed strip shows. Never empty: every mode says something. */
export function summaryLine(
  mode: PickerMode,
  cameras: readonly CameraDevice[],
  resolved: ResolvedSelection,
): string {
  if (mode === 'unsupported') return CAMERA_PICKER_COPY.unsupported
  if (mode === 'empty') return CAMERA_PICKER_COPY.empty
  if (mode === 'locked') return CAMERA_PICKER_COPY.grantNote
  const camera = effectiveCamera(cameras, resolved)
  if (!camera) return CAMERA_PICKER_COPY.empty
  if (mode === 'single') return CAMERA_PICKER_COPY.one(camera.label)
  return camera.label
}

/**
 * The strip's line, including the one state `summaryLine` cannot know about: the gap
 * before the first enumeration comes back. "No camera found" is a claim, and claiming
 * it while still asking is how a picker calls a working camera missing for one frame.
 *
 * Only 'empty' can be premature. 'unsupported' is decided synchronously — there is no
 * API to wait for — and the other three already have devices in hand, which is why
 * this is not a blanket "if (listing)" in front of everything.
 */
export function barLine(
  mode: PickerMode,
  cameras: readonly CameraDevice[],
  resolved: ResolvedSelection,
  listing: boolean,
): string {
  if (listing && mode === 'empty') return CAMERA_PICKER_COPY.looking
  return summaryLine(mode, cameras, resolved)
}

export interface NoticeInput {
  /** From the live preview: gone, denied, lost, or would not open. */
  readonly previewError: string | null
  readonly grantError: string | null
  /** Set when a remembered choice could not be honoured. */
  readonly missingId: string | null
  readonly missingFallbackLabel: string
  readonly arrival: string | null
}

/**
 * One line beneath the picker, by priority: a failure the user is looking at beats a
 * failure they asked for, which beats a choice we could not honour, which beats good
 * news. Anything lower is still true, just not what to read first.
 */
export function noticeLine(input: NoticeInput): string | null {
  if (input.previewError) return input.previewError
  if (input.grantError) return input.grantError
  if (input.missingId) return CAMERA_PICKER_COPY.missing(input.missingFallbackLabel)
  return input.arrival
}

/**
 * `exact`, deliberately: a preview of the wrong camera is a lie, and the failure is
 * both cheap and legible (OverconstrainedError → `previewFailure` below). With no id
 * we mirror the workout screen's own default instead, so "default" previews what
 * "default" will actually open.
 */
export function previewConstraints(deviceId: string | null): MediaTrackConstraints {
  const size = {
    width: { ideal: CAMERA_PICKER_UI.previewWidthIdeal },
    height: { ideal: CAMERA_PICKER_UI.previewHeightIdeal },
  }
  if (deviceId === null) return { ...size, facingMode: CAMERA_PICKER_UI.defaultFacingMode }
  // Never both: facingMode plus an exact id over-constrains an external camera.
  return { ...size, deviceId: { exact: deviceId } }
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  const name = (error as { readonly name: unknown }).name
  return typeof name === 'string' ? name : ''
}

/** Turns a getUserMedia rejection into a sentence that says what to do about it. */
export function previewFailure(error: unknown): string {
  switch (errorName(error)) {
    case 'OverconstrainedError':
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return CAMERA_PICKER_COPY.previewGone
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return CAMERA_PICKER_COPY.previewDenied
    default:
      return CAMERA_PICKER_COPY.previewFailed
  }
}

/**
 * How to bring the opened panel into view. The behaviour is a decision, not a taste:
 * this scroll happens because the user clicked, so it is animated by default — but the
 * stylesheet already flattens every other animation under `prefers-reduced-motion`, and a
 * smooth scroll is exactly the kind of motion that setting exists to refuse.
 */
export function panelScrollOptions(reducedMotion: boolean): ScrollIntoViewOptions {
  return { block: CAMERA_PICKER_UI.panelScrollBlock, behavior: reducedMotion ? 'auto' : 'smooth' }
}

/** Same map as the persona cards': one tab stop, arrows move the selection. */
const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/** Index the arrows should move to, or null when the key is not ours to handle. */
export function arrowTarget(key: string, fromIndex: number, count: number): number | null {
  const step = ARROW_STEP[key]
  if (step === undefined || count <= 0) return null
  const from = fromIndex < 0 ? 0 : fromIndex
  return (from + step + count) % count
}
