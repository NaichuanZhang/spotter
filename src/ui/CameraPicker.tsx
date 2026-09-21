/**
 * The camera picker, on the intro screen — chosen before starting, beside choosing a
 * coach, because it is the same kind of decision and it belongs in the same moment.
 *
 * WHY IT IS HERE AND NOT IN THE HUD: a laptop lid camera cannot see a person on the
 * floor, and a propped-up iPhone can. That is a choice about the SETUP of the room,
 * made once, before the set — not a control to fiddle with mid-pushup.
 *
 * WHAT THE USER SEES, in the order the states actually happen:
 *
 *   no camera API      one plain sentence. Never an empty control.
 *   no cameras         one plain sentence, and it keeps listening — a phone waking up
 *                      fills the list without a reload.
 *   names withheld     the browser hands back nameless entries until a getUserMedia has
 *                      succeeded once, so this state renders the AFFORDANCE ("allow
 *                      camera access to see device names") instead of three anonymous
 *                      rows, then re-lists with real names.
 *   one camera         a quiet line of text with no material behind it. There is no
 *                      decision to make, so the block does not ask for attention.
 *   a real choice      a glass strip naming the current camera, opening into the
 *                      preview and the device list.
 *
 * THE PREVIEW IS THE POINT. Names like "FaceTime HD Camera" and "Desk View Camera"
 * cannot answer "which of these is pointing at the floor?", so the selected device's
 * actual picture is on screen, small, muted, playsinline — and mirrored, like the
 * workout screen's own video, so it reads as a mirror rather than a stranger.
 * useCameraPreview owns the stream and stops it when this closes or unmounts.
 *
 * THE IPHONE COMES AND GOES, AND THAT IS NORMAL. useCameraDevices re-lists off
 * `devicechange`, so a row appears as the user wakes their phone. It is marked as new
 * for a moment and announced once in the live region — deliberate, rather than a row
 * that silently materialises and reads as a glitch.
 *
 * KEYBOARD: one tab stop, arrows move the selection, exactly like the persona cards
 * next to it (src/ui/PersonaCards.tsx). It is a radiogroup and it behaves like one.
 *
 * WHAT THIS FILE DOES NOT DO: it does not open the workout camera, and it does not
 * decide what happens when a remembered device is gone at startup — the pose engine
 * owns that fallback. It reports the choice, and says out loud when it could not be
 * honoured. It does call `rememberCamera`, because this is the only place in the app
 * where a camera is actually CHOSEN; the mount owner is free to call it too (the write
 * is idempotent) and should seed its own state from `recalledCamera()`.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { rememberCamera } from '../pose/cameras'
import {
  CAMERA_PICKER_COPY,
  PREVIEW_STATUS_TEXT,
  ROW_STATE_TEXT,
  arrowTarget,
  barLine,
  cameraRows,
  defaultCameraLabel,
  emphasis,
  hasIphone,
  needsGrant,
  noticeLine,
  panelScrollOptions,
  pickerMode,
  resolveSelection,
  showsDeviceList,
  toggleLabel,
} from './cameraPickerView'
import { useCameraDevices } from './useCameraDevices'
import { useCameraPreview } from './useCameraPreview'
import { PERSONA_ORDER } from './PersonaRail'
import { cardRevealMs, revealAt } from './introMotion'

/** One beat after the last persona card, derived rather than typed out again. */
const REVEAL_MS = cardRevealMs(PERSONA_ORDER.length)

export interface CameraPickerProps {
  /**
   * The chosen device, or null to let the browser pick. Owned by the caller, which
   * should seed it from `recalledCamera()` so a remembered choice survives a reload.
   */
  readonly deviceId: string | null
  /** Fired only on a real user choice — never from an effect, never on a fallback. */
  readonly onSelect: (deviceId: string) => void
  /** Open on mount. Off by default: no camera light until the user asks for one. */
  readonly defaultOpen?: boolean
}

export default function CameraPicker({ deviceId, onSelect, defaultOpen = false }: CameraPickerProps) {
  const [open, setOpen] = useState(defaultOpen)
  /** Ids from the renderer, so a second picker on one page cannot collide with this. */
  const headId = useId()
  const bodyId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { cameras, apiAvailable, listing, grantError, freshIds, arrival, refresh, requestLabels } =
    useCameraDevices()

  const mode = pickerMode(cameras, apiAvailable)
  const resolved = resolveSelection(cameras, deviceId)
  const rows = cameraRows(cameras, resolved)
  const listed = showsDeviceList(mode)

  // A track that ends means the device is on its way out of the list as well, so the
  // list is re-read rather than left showing a camera that is no longer there.
  const handleLost = useCallback(() => refresh(), [refresh])
  const preview = useCameraPreview(resolved.deviceId, open && listed, handleLost)

  const choose = useCallback(
    (id: string) => {
      rememberCamera(id)
      onSelect(id)
    },
    [onSelect],
  )

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = rows.findIndex((row) => row.state !== 'idle')
    const target = arrowTarget(event.key, from, rows.length)
    if (target === null) return
    event.preventDefault()
    const next = rows[target]
    if (!next) return
    choose(next.deviceId)
    // Indexed rather than selected by id: a deviceId is base64 and is not a safe
    // attribute selector.
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus()
  }

  /**
   * THE PANEL OPENS BELOW THE FOLD OTHERWISE. This block is the last thing in a
   * fixed-height scroller, so the preview and the rows land off-screen and the click
   * reads as a dead button that turned the camera light on. Measured before the fix:
   * 9 px of 111 px visible at 1440x900, none at 390x844.
   *
   * `open` only, not the preview status: the geometry is final at commit — the open
   * animation moves opacity and transform, never height — so there is nothing to wait for.
   */
  useEffect(() => {
    if (!open || !listed) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    panelRef.current?.scrollIntoView(panelScrollOptions(reduced))
  }, [open, listed])

  const notice = noticeLine({
    previewError: preview.error,
    grantError,
    missingId: resolved.missingId,
    missingFallbackLabel: defaultCameraLabel(cameras),
    arrival,
  })

  const summary = barLine(mode, cameras, resolved, listing)

  return (
    <section
      className="campick"
      aria-labelledby={headId}
      data-open={open ? 'true' : 'false'}
      data-emphasis={emphasis(mode)}
      data-reveal=""
      style={revealAt(REVEAL_MS)}
    >
      <p className="picker__head" id={headId}>
        <span>{CAMERA_PICKER_COPY.heading}</span>
        <i />
        {open && listed ? (
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {CAMERA_PICKER_COPY.keyHint}
          </span>
        ) : null}
      </p>

      <div className="campick__panel" ref={panelRef}>
        <div className="campick__bar">
          <span className="campick__now">{summary}</span>
          {/* The reason the feature exists: say so before the list is even opened. */}
          {!open && hasIphone(cameras) ? (
            <span className="campick__flag">{CAMERA_PICKER_COPY.iphoneFlag}</span>
          ) : null}
          <span className="campick__spacer" />
          {needsGrant(cameras, mode) ? (
            <button type="button" className="campick__toggle" onClick={requestLabels}>
              {CAMERA_PICKER_COPY.grant}
            </button>
          ) : null}
          {listed ? (
            <button
              type="button"
              className="campick__toggle"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen(!open)}
            >
              {toggleLabel(mode, open)}
            </button>
          ) : null}
        </div>

        {open && listed ? (
          <div className="campick__body" id={bodyId}>
            <div className="campick__stage" data-status={preview.status}>
              {/* No autoPlay: the stream's owner calls play() itself. See the same
                  comment on the workout screen's video element. */}
              <video ref={preview.videoRef} className="campick__video" muted playsInline />
              <span className="campick__stageNote">{PREVIEW_STATUS_TEXT[preview.status]}</span>
            </div>

            <div
              className="campick__rows"
              role="radiogroup"
              aria-label={CAMERA_PICKER_COPY.heading}
              onKeyDown={moveSelection}
            >
              {rows.map((row) => (
                <button
                  key={row.deviceId}
                  type="button"
                  role="radio"
                  aria-checked={row.state !== 'idle'}
                  tabIndex={row.state !== 'idle' ? 0 : -1}
                  className="campick__row"
                  data-kind={row.kind}
                  data-fresh={freshIds.includes(row.deviceId) ? 'true' : 'false'}
                  onClick={() => choose(row.deviceId)}
                >
                  <span className="campick__rowName">{row.label}</span>
                  {row.badge ? (
                    <span className="campick__badge" data-kind={row.kind}>
                      {row.badge}
                    </span>
                  ) : null}
                  <span className="campick__rowState">
                    <span className="card__check" aria-hidden="true">
                      <svg viewBox="0 0 8 8" fill="none">
                        <path
                          d="M1 4.2 3 6.2 7 1.9"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    {ROW_STATE_TEXT[row.state]}
                  </span>
                </button>
              ))}

              {/* Two different jobs: why to pick the phone that is here, or that a
                  phone can be here at all. The second is how anyone finds out. */}
              <p className="campick__hint">
                {hasIphone(cameras) ? CAMERA_PICKER_COPY.floorHint : CAMERA_PICKER_COPY.iphoneTeach}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <p
        className="campick__note"
        role="status"
        aria-live="polite"
        data-on={notice ? 'true' : 'false'}
      >
        {notice}
      </p>
    </section>
  )
}
