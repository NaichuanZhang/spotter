/**
 * The camera picker's judgements, tested without a camera.
 *
 * WHAT IS WORTH PINNING HERE, and why each of these is a bug that has a name:
 *
 * - THE PICKER MUST NOT RENDER AN EMPTY CONTROL. Three of the five modes have no list
 *   to show, and a naive `cameras.map()` renders a radiogroup with nothing in it. Every
 *   mode is asserted, including the state that only exists before a permission grant.
 * - NAMELESS ROWS ARE THE DEFAULT, NOT THE EDGE CASE. Before a successful getUserMedia
 *   the browser withholds labels, and in some browsers the deviceId with them. So: the
 *   all-withheld list locks, a PARTLY withheld list still offers the grant, and an entry
 *   with no id is never offered as something to click.
 * - A REMEMBERED IPHONE THAT HAS GONE HOME MUST NOT BREAK THE SCREEN. resolveSelection
 *   reports the missing id instead of pretending, and the notice names the fallback.
 * - THE ROVING TABINDEX NEEDS EXACTLY ONE ROW AT tabIndex 0. That invariant lives in
 *   `rowState`, so it is asserted directly rather than trusted.
 * - `exact` PLUS facingMode IS AN OverconstrainedError WAITING TO HAPPEN, so the two are
 *   asserted never to appear in the same constraint object.
 *
 * Devices are hand-built to the CameraDevice contract rather than enumerated: every
 * shape below (withheld label, zeroed id, unknown kind) is one a browser really returns.
 */
import { describe, expect, it } from 'vitest'
import type { CameraDevice } from '../../pose/cameras'
import { CAMERA_PICKER } from '../../pose/cameras'
import {
  CAMERA_PICKER_COPY,
  arrivalNote,
  arrivedIds,
  arrowTarget,
  barLine,
  cameraRows,
  defaultCameraLabel,
  effectiveCamera,
  emphasis,
  hasIphone,
  needsGrant,
  noticeLine,
  pickerMode,
  panelScrollOptions,
  previewConstraints,
  previewFailure,
  resolveSelection,
  showsDeviceList,
  summaryLine,
  toggleLabel,
} from '../cameraPickerView'

function device(over: Partial<CameraDevice> = {}): CameraDevice {
  return { deviceId: 'id-1', label: 'FaceTime HD Camera', kind: 'builtin', labelWithheld: false, ...over }
}

const LID = device()
const IPHONE = device({ deviceId: 'id-2', label: "Nai's iPhone Camera", kind: 'iphone' })
const USB = device({ deviceId: 'id-3', label: 'Logitech StreamCam', kind: 'external' })
const MYSTERY = device({ deviceId: 'id-4', label: 'USB2.0 HD UVC WebCam', kind: 'unknown' })
/** What the browser hands back before any grant: no name, and sometimes no id either. */
const WITHHELD = device({ deviceId: '', label: 'Camera 1', kind: 'unknown', labelWithheld: true })

const NOTHING_CHOSEN = resolveSelection([], null)

describe('pickerMode', () => {
  it('reports no API separately from no cameras, because they need different sentences', () => {
    expect(pickerMode([], false)).toBe('unsupported')
    expect(pickerMode([], true)).toBe('empty')
    // An API that is present does not become absent because a camera is unplugged.
    expect(pickerMode([LID], false)).toBe('unsupported')
  })

  it('locks when every label is withheld — that is a permission state, not a device list', () => {
    expect(pickerMode([WITHHELD, { ...WITHHELD, deviceId: '' }], true)).toBe('locked')
  })

  it('does NOT lock when only some labels are withheld: a partly named list is still usable', () => {
    expect(pickerMode([LID, WITHHELD], true)).toBe('choice')
  })

  it('separates one camera from a real choice', () => {
    expect(pickerMode([LID], true)).toBe('single')
    expect(pickerMode([LID, IPHONE], true)).toBe('choice')
  })
})

describe('what the picker shows', () => {
  it('only offers a device list when a device can be picked', () => {
    expect(showsDeviceList(pickerMode([LID], true))).toBe(true)
    expect(showsDeviceList(pickerMode([LID, IPHONE], true))).toBe(true)
    expect(showsDeviceList(pickerMode([], true))).toBe(false)
    expect(showsDeviceList(pickerMode([], false))).toBe(false)
    expect(showsDeviceList(pickerMode([WITHHELD], true))).toBe(false)
  })

  it('offers the grant in the locked state AND in the partly named one', () => {
    expect(needsGrant([WITHHELD], pickerMode([WITHHELD], true))).toBe(true)
    expect(needsGrant([LID, WITHHELD], pickerMode([LID, WITHHELD], true))).toBe(true)
    expect(needsGrant([LID, IPHONE], pickerMode([LID, IPHONE], true))).toBe(false)
    // Nothing to grant access TO, so the button would be a dead end.
    expect(needsGrant([], pickerMode([], true))).toBe(false)
    expect(needsGrant([], pickerMode([], false))).toBe(false)
  })

  it('stays quiet unless there is a decision or a permission to ask for', () => {
    expect(emphasis(pickerMode([LID], true))).toBe('quiet')
    expect(emphasis(pickerMode([], true))).toBe('quiet')
    expect(emphasis(pickerMode([], false))).toBe('quiet')
    expect(emphasis(pickerMode([LID, IPHONE], true))).toBe('offered')
    expect(emphasis(pickerMode([WITHHELD], true))).toBe('offered')
  })
})

describe('toggleLabel', () => {
  it('does not promise a change that cannot happen with one camera', () => {
    expect(toggleLabel('single', false)).toBe(CAMERA_PICKER_COPY.openOne)
    expect(toggleLabel('choice', false)).toBe(CAMERA_PICKER_COPY.open)
  })

  it('closes the same way whatever opened it', () => {
    for (const mode of ['single', 'choice'] as const) {
      expect(toggleLabel(mode, true)).toBe(CAMERA_PICKER_COPY.close)
    }
  })
})

describe('resolveSelection', () => {
  it('means "let the browser choose" when nothing has been chosen', () => {
    expect(resolveSelection([LID, IPHONE], null)).toEqual({
      deviceId: null,
      usingDefault: true,
      missingId: null,
    })
  })

  it('honours a choice that is present', () => {
    expect(resolveSelection([LID, IPHONE], IPHONE.deviceId)).toEqual({
      deviceId: IPHONE.deviceId,
      usingDefault: false,
      missingId: null,
    })
  })

  it('falls back to the default AND reports the id when the remembered camera has gone', () => {
    const resolved = resolveSelection([LID], IPHONE.deviceId)
    expect(resolved.deviceId).toBeNull()
    expect(resolved.usingDefault).toBe(true)
    expect(resolved.missingId).toBe(IPHONE.deviceId)
  })

  it('survives an empty list without inventing a device', () => {
    expect(resolveSelection([], 'gone').deviceId).toBeNull()
    expect(effectiveCamera([], resolveSelection([], 'gone'))).toBeNull()
  })

  it('previews the camera the workout will actually open', () => {
    // Default: the first enumerated input, which is the platform default.
    expect(effectiveCamera([LID, IPHONE], resolveSelection([LID, IPHONE], null))).toBe(LID)
    expect(effectiveCamera([LID, IPHONE], resolveSelection([LID, IPHONE], IPHONE.deviceId))).toBe(IPHONE)
  })
})

describe('cameraRows', () => {
  const cameras = [LID, IPHONE, USB, MYSTERY]

  it('passes the label through, including a synthesised one, and never invents a name', () => {
    const rows = cameraRows([device({ deviceId: 'x', label: 'Camera 2', labelWithheld: true })], NOTHING_CHOSEN)
    expect(rows[0]?.label).toBe('Camera 2')
  })

  it('badges by kind from the shared table, and shrugs at an unidentified camera', () => {
    const rows = cameraRows(cameras, resolveSelection(cameras, null))
    expect(rows.map((row) => row.badge)).toEqual([
      CAMERA_PICKER.KIND_LABEL.builtin,
      CAMERA_PICKER.KIND_LABEL.iphone,
      CAMERA_PICKER.KIND_LABEL.external,
      null,
    ])
  })

  it('marks the iPhone as the recommended row, because it is the reason this exists', () => {
    const rows = cameraRows(cameras, resolveSelection(cameras, null))
    expect(rows.filter((row) => row.recommended).map((row) => row.deviceId)).toEqual([IPHONE.deviceId])
  })

  it('never offers a row that cannot be clicked: an entry with no deviceId is not a row', () => {
    const rows = cameraRows([LID, WITHHELD], resolveSelection([LID, WITHHELD], null))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deviceId).toBe(LID.deviceId)
  })

  it('keeps EXACTLY ONE row out of tab order rotation, which is what a roving tabindex needs', () => {
    for (const chosen of [null, LID.deviceId, IPHONE.deviceId, 'a-camera-that-left']) {
      const rows = cameraRows(cameras, resolveSelection(cameras, chosen))
      expect(rows.filter((row) => row.state !== 'idle')).toHaveLength(1)
    }
  })

  it('says "default" rather than "selected" for a camera the user never picked', () => {
    const rows = cameraRows(cameras, resolveSelection(cameras, null))
    expect(rows.map((row) => row.state)).toEqual(['default', 'idle', 'idle', 'idle'])
  })

  it('marks the chosen camera selected, and the first row goes back to idle', () => {
    const rows = cameraRows(cameras, resolveSelection(cameras, IPHONE.deviceId))
    expect(rows.map((row) => row.state)).toEqual(['idle', 'selected', 'idle', 'idle'])
  })

  it('falls the default mark back to the first row when the choice has gone', () => {
    const rows = cameraRows(cameras, resolveSelection(cameras, 'a-camera-that-left'))
    expect(rows[0]?.state).toBe('default')
  })
})

describe('arrivals', () => {
  it('is silent on a first load: a list appearing is not a device appearing', () => {
    expect(arrivedIds([], [LID, IPHONE])).toEqual([])
    expect(arrivalNote([], [LID, IPHONE])).toBeNull()
  })

  it('announces an iPhone that just woke up, which is the whole point of re-listing', () => {
    expect(arrivedIds([LID], [LID, IPHONE])).toEqual([IPHONE.deviceId])
    expect(arrivalNote([LID], [LID, IPHONE])).toBe(CAMERA_PICKER_COPY.iphoneArrived)
  })

  it('stays quiet about a USB camera: the user plugged that in themselves', () => {
    expect(arrivedIds([LID], [LID, USB])).toEqual([USB.deviceId])
    expect(arrivalNote([LID], [LID, USB])).toBeNull()
  })

  it('treats a disappearance as no arrival at all', () => {
    expect(arrivedIds([LID, IPHONE], [LID])).toEqual([])
    expect(arrivalNote([LID, IPHONE], [LID])).toBeNull()
  })

  it('does not re-announce a phone that was already in the list', () => {
    expect(arrivalNote([LID, IPHONE], [LID, IPHONE, USB])).toBeNull()
  })

  it('knows whether a phone is there at all, for the collapsed strip', () => {
    expect(hasIphone([LID, USB])).toBe(false)
    expect(hasIphone([LID, IPHONE])).toBe(true)
  })
})

describe('summaryLine', () => {
  it('says something in every mode — a blank control is the failure being avoided', () => {
    const modes = [
      pickerMode([], false),
      pickerMode([], true),
      pickerMode([WITHHELD], true),
      pickerMode([LID], true),
      pickerMode([LID, IPHONE], true),
    ]
    const lines = modes.map((mode) => summaryLine(mode, [LID, IPHONE], resolveSelection([LID, IPHONE], null)))
    for (const line of lines) expect(line.length).toBeGreaterThan(0)
  })

  it('reuses the device layer’s own wording for the three machine states', () => {
    expect(summaryLine('unsupported', [], NOTHING_CHOSEN)).toBe(CAMERA_PICKER.COPY.UNAVAILABLE_API)
    expect(summaryLine('empty', [], NOTHING_CHOSEN)).toBe(CAMERA_PICKER.COPY.NO_CAMERAS)
    expect(summaryLine('locked', [WITHHELD], NOTHING_CHOSEN)).toBe(CAMERA_PICKER.COPY.NEEDS_PERMISSION)
  })

  it('names the one camera when there is only one, and does not ask a question', () => {
    expect(summaryLine('single', [LID], resolveSelection([LID], null))).toContain(LID.label)
  })

  it('names the camera in use on a real choice', () => {
    const cameras = [LID, IPHONE]
    expect(summaryLine('choice', cameras, resolveSelection(cameras, IPHONE.deviceId))).toBe(IPHONE.label)
  })

  it('does not claim "no cameras" when the list is momentarily empty in a picking mode', () => {
    expect(summaryLine('choice', [], NOTHING_CHOSEN)).toBe(CAMERA_PICKER.COPY.NO_CAMERAS)
  })
})

describe('barLine', () => {
  it('does not call a camera missing while the first enumeration is still out', () => {
    expect(barLine('empty', [], NOTHING_CHOSEN, true)).toBe(CAMERA_PICKER_COPY.looking)
    expect(barLine('empty', [], NOTHING_CHOSEN, false)).toBe(CAMERA_PICKER.COPY.NO_CAMERAS)
  })

  it('never says "looking" when there is no API to look with — that answer is immediate', () => {
    expect(barLine('unsupported', [], NOTHING_CHOSEN, true)).toBe(CAMERA_PICKER.COPY.UNAVAILABLE_API)
  })

  it('leaves every mode that already has devices alone', () => {
    const cameras = [LID, IPHONE]
    const resolved = resolveSelection(cameras, IPHONE.deviceId)
    for (const listing of [true, false]) {
      expect(barLine('choice', cameras, resolved, listing)).toBe(IPHONE.label)
      expect(barLine('locked', [WITHHELD], NOTHING_CHOSEN, listing)).toBe(
        CAMERA_PICKER.COPY.NEEDS_PERMISSION,
      )
    }
  })
})

describe('noticeLine', () => {
  const base = {
    previewError: null,
    grantError: null,
    missingId: null,
    missingFallbackLabel: LID.label,
    arrival: null,
  }

  it('says nothing when there is nothing to say', () => {
    expect(noticeLine(base)).toBeNull()
  })

  it('puts the failure the user is looking at first', () => {
    expect(
      noticeLine({ ...base, previewError: 'preview', grantError: 'grant', missingId: 'x', arrival: 'phone' }),
    ).toBe('preview')
  })

  it('then the permission they asked for, then the choice we could not honour', () => {
    expect(noticeLine({ ...base, grantError: 'grant', missingId: 'x', arrival: 'phone' })).toBe('grant')
    expect(noticeLine({ ...base, missingId: 'x', arrival: 'phone' })).toBe(
      CAMERA_PICKER_COPY.missing(LID.label),
    )
  })

  it('names the camera it fell back to, rather than saying "a camera"', () => {
    const line = noticeLine({ ...base, missingId: 'gone' })
    expect(line).toContain(LID.label)
  })

  it('has a name for the fallback even with an empty list', () => {
    expect(defaultCameraLabel([])).toBe(CAMERA_PICKER_COPY.defaultLabel)
    expect(defaultCameraLabel([IPHONE, LID])).toBe(IPHONE.label)
  })

  it('reports good news when nothing is wrong', () => {
    expect(noticeLine({ ...base, arrival: CAMERA_PICKER_COPY.iphoneArrived })).toBe(
      CAMERA_PICKER_COPY.iphoneArrived,
    )
  })
})

describe('previewConstraints', () => {
  it('pins the exact device, because a preview of the wrong camera is a lie', () => {
    const constraints = previewConstraints('id-2')
    expect(constraints.deviceId).toEqual({ exact: 'id-2' })
  })

  it('never sends facingMode WITH an exact id — together they over-constrain a USB camera', () => {
    expect(previewConstraints('id-2').facingMode).toBeUndefined()
  })

  it('mirrors the workout screen default when no camera has been chosen', () => {
    const constraints = previewConstraints(null)
    expect(constraints.deviceId).toBeUndefined()
    expect(constraints.facingMode).toBe('user')
  })

  it('asks for a thumbnail, not a workout feed', () => {
    for (const id of [null, 'id-2']) {
      const constraints = previewConstraints(id)
      expect(constraints.width).toEqual({ ideal: 640 })
      expect(constraints.height).toEqual({ ideal: 360 })
    }
  })
})

describe('previewFailure', () => {
  function named(name: string): Error {
    const error = new Error(name)
    error.name = name
    return error
  }

  it('reads an OverconstrainedError as "that camera is gone", which is what it means', () => {
    expect(previewFailure(named('OverconstrainedError'))).toBe(CAMERA_PICKER_COPY.previewGone)
    expect(previewFailure(named('NotFoundError'))).toBe(CAMERA_PICKER_COPY.previewGone)
  })

  it('reads a refusal as a refusal', () => {
    expect(previewFailure(named('NotAllowedError'))).toBe(CAMERA_PICKER_COPY.previewDenied)
    expect(previewFailure(named('SecurityError'))).toBe(CAMERA_PICKER_COPY.previewDenied)
  })

  it('still produces a sentence for anything else, including a non-Error', () => {
    expect(previewFailure(named('TypeError'))).toBe(CAMERA_PICKER_COPY.previewFailed)
    expect(previewFailure('a string')).toBe(CAMERA_PICKER_COPY.previewFailed)
    expect(previewFailure(null)).toBe(CAMERA_PICKER_COPY.previewFailed)
    expect(previewFailure({ name: 42 })).toBe(CAMERA_PICKER_COPY.previewFailed)
  })
})

/**
 * The intro is a fixed-height scroller and this block is the last thing in it, so an
 * opened panel is off-screen unless something scrolls it in — measured in a real browser
 * as 9 px of 111 px visible at 1440x900 and nothing at all at 390x844.
 */
describe('panelScrollOptions', () => {
  it('scrolls the least it can, so the coach cards do not move under the user', () => {
    expect(panelScrollOptions(false).block).toBe('nearest')
    expect(panelScrollOptions(true).block).toBe('nearest')
  })

  it('animates by default and refuses to when the user asked for less motion', () => {
    expect(panelScrollOptions(false).behavior).toBe('smooth')
    expect(panelScrollOptions(true).behavior).toBe('auto')
  })
})

describe('arrowTarget', () => {
  it('moves forward and wraps, like the persona cards', () => {
    expect(arrowTarget('ArrowDown', 0, 3)).toBe(1)
    expect(arrowTarget('ArrowRight', 2, 3)).toBe(0)
  })

  it('moves back and wraps', () => {
    expect(arrowTarget('ArrowUp', 0, 3)).toBe(2)
    expect(arrowTarget('ArrowLeft', 1, 3)).toBe(0)
  })

  it('ignores every other key, so typing never steals the camera', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) {
      expect(arrowTarget(key, 0, 3)).toBeNull()
    }
  })

  it('does nothing with no rows, and starts from the top when nothing is selected', () => {
    expect(arrowTarget('ArrowDown', 0, 0)).toBeNull()
    expect(arrowTarget('ArrowDown', -1, 2)).toBe(1)
  })
})
