/**
 * One render of the real component, with no DOM and no camera.
 *
 * This repo's test runner has no jsdom, so this is not an interaction test — it is the
 * only thing that proves the JSX compiles AND that the no-API path renders a sentence
 * rather than an empty control. That path is the one a reviewer cannot check by hand
 * (every laptop they would open it on HAS a camera) and it is exactly the state a
 * headless browser, an insecure origin, or a locked-down machine lands in.
 *
 * `renderToStaticMarkup` runs render only: effects never fire, so nothing here can open
 * a camera or subscribe to devicechange. Node's `navigator` has no `mediaDevices`, which
 * is precisely the 'unsupported' mode, so the fixture is the runtime itself.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import CameraPicker from '../CameraPicker'
import { CAMERA_PICKER } from '../../pose/cameras'

function render(): string {
  return renderToStaticMarkup(<CameraPicker deviceId={null} onSelect={() => undefined} />)
}

describe('CameraPicker, rendered without a camera API', () => {
  it('says so plainly', () => {
    expect(render()).toContain(CAMERA_PICKER.COPY.UNAVAILABLE_API)
  })

  it('renders NO radiogroup, because there is nothing in it to pick', () => {
    expect(render()).not.toContain('radiogroup')
  })

  it('renders no video element, so nothing can light a camera indicator', () => {
    expect(render()).not.toContain('<video')
  })

  it('does not shout: an unpickable camera list gets no glass', () => {
    expect(render()).toContain('data-emphasis="quiet"')
  })

  it('offers no permission button — there is no permission that would help', () => {
    expect(render()).not.toContain('Allow camera access')
  })
})
