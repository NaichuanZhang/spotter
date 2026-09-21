/**
 * The open picker's markup, with the two effect-owning hooks faked at the module seam.
 *
 * WHY FAKE THE HOOKS AND NOT THE BROWSER: the interesting states of this component are
 * reached through effects — a device list that arrives asynchronously, a preview stream
 * that opens. `renderToStaticMarkup` never runs effects, and this repo has no jsdom, so
 * the only way to see the open state at all is to hand the component the state those
 * effects would have produced. Faking `useCameraDevices` and `useCameraPreview` does
 * exactly that, and it keeps the fixture honest: the devices below are CameraDevice
 * values per the contract in src/pose/cameras.ts, nothing more.
 *
 * WHAT THIS CATCHES that the pure tests cannot: that a row is a radio in a radiogroup,
 * that exactly one row is in the tab order, that the iPhone is visibly marked, and that
 * the preview element ships `muted` and `playsinline` with NO autoplay attribute — the
 * three attributes that decide whether iOS Safari plays it and whether it fights the
 * pose engine for the element. Those live in JSX, where a type checker cannot see them.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CameraDevice } from '../../pose/cameras'
import { CAMERA_PICKER } from '../../pose/cameras'
import { CAMERA_PICKER_COPY, PREVIEW_STATUS_TEXT } from '../cameraPickerView'

const LID: CameraDevice = {
  deviceId: 'lid',
  label: 'FaceTime HD Camera',
  kind: 'builtin',
  labelWithheld: false,
}
const IPHONE: CameraDevice = {
  deviceId: 'phone',
  label: "Nai's iPhone Camera",
  kind: 'iphone',
  labelWithheld: false,
}

const devices = {
  cameras: [LID, IPHONE] as readonly CameraDevice[],
  apiAvailable: true,
  listing: false,
  grantError: null as string | null,
  freshIds: [IPHONE.deviceId] as readonly string[],
  arrival: CAMERA_PICKER_COPY.iphoneArrived as string | null,
  refresh: () => undefined,
  requestLabels: () => undefined,
}

vi.mock('../useCameraDevices', () => ({
  useCameraDevices: () => devices,
  cameraApiAvailable: () => true,
}))

vi.mock('../useCameraPreview', () => ({
  useCameraPreview: () => ({ videoRef: { current: null }, status: 'live', error: null }),
}))

const { default: CameraPicker } = await import('../CameraPicker')

function render(deviceId: string | null): string {
  return renderToStaticMarkup(
    <CameraPicker deviceId={deviceId} onSelect={() => undefined} defaultOpen />,
  )
}

describe('CameraPicker, open on two cameras', () => {
  it('is a radiogroup of radios, like the persona cards beside it', () => {
    const html = render(IPHONE.deviceId)
    expect(html).toContain('role="radiogroup"')
    expect(html.match(/role="radio"/g)).toHaveLength(2)
  })

  it('puts EXACTLY ONE row in the tab order — the rest are reachable by arrow key', () => {
    const html = render(IPHONE.deviceId)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1)
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
  })

  it('marks the iPhone, which is the device this whole feature exists for', () => {
    const html = render(null)
    expect(html).toContain(CAMERA_PICKER.KIND_LABEL.iphone)
    // Not the whole label: macOS puts an apostrophe in it and the serialiser escapes it.
    expect(html).toContain('iPhone Camera')
    // It arrived on the last refresh, so it is also marked as new for a moment.
    expect(html).toContain('data-fresh="true"')
  })

  it('checks the DEFAULT row when the user has chosen nothing, and says "default"', () => {
    const html = render(null)
    expect(html).toContain('Default')
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
  })

  it('ships the preview muted and inline, and with no autoplay attribute at all', () => {
    const html = render(IPHONE.deviceId)
    expect(html).toContain('<video')
    expect(html).toContain('muted=""')
    // React's server renderer spells it playsInline; the DOM attribute is lowercase.
    expect(html).toMatch(/playsinline=""/i)
    expect(html).not.toMatch(/autoplay/i)
  })

  it('labels the preview with its own state rather than leaving a dark box unexplained', () => {
    expect(render(null)).toContain(PREVIEW_STATUS_TEXT.live)
  })

  it('announces the arrival in a live region', () => {
    const html = render(null)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain(CAMERA_PICKER_COPY.iphoneArrived)
  })

  it('explains why the phone is worth picking now that there is one', () => {
    expect(render(null)).toContain(CAMERA_PICKER_COPY.floorHint)
  })

  it('offers no permission button when every camera already has a real name', () => {
    expect(render(null)).not.toContain(CAMERA_PICKER_COPY.grant)
  })

  it('names the fallback out loud when the remembered camera is not in the list', () => {
    const html = render('an-iphone-that-went-home')
    expect(html).toContain(CAMERA_PICKER_COPY.missing(LID.label))
    // And it does not leave the radiogroup with nothing checked.
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
  })
})
