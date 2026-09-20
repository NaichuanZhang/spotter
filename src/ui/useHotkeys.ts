/**
 * Keyboard controls.
 *
 * Every key here exists so a human can force a moment to happen on cue: swap the
 * coach, kick the socket, show the captions. The listener is registered once and
 * reads the latest actions out of a ref, so passing fresh closures from App does
 * not thrash window listeners.
 *
 * ONE key, F, is dev-only. It fabricates a rep, which a shipped build must not be
 * able to do; `import.meta.env.DEV` gates both the binding and its help entry so
 * the overlay never advertises a key that does nothing. The capability survives
 * for tests and local development — see `poseEngine.injectSyntheticRep`.
 */
import { useEffect, useRef } from 'react'
import type { PersonaId } from '../types/tools'

export interface HotkeyActions {
  onSyntheticRep: () => void
  onPersona: (persona: PersonaId) => void
  onReconnect: () => void
  onToggleOffline: () => void
  onToggleCaptions: () => void
  onToggleHint: () => void
  onEscape: () => void
}

export interface HotkeyHint {
  readonly keys: string
  readonly label: string
}

/** Dev builds only, and labelled as such so nobody demos it by accident. */
const DEV_HOTKEY_HINTS: readonly HotkeyHint[] = [{ keys: 'F', label: 'inject a synthetic rep (dev only)' }]

const SHIPPED_HOTKEY_HINTS: readonly HotkeyHint[] = [
  { keys: '1 / 2 / 3', label: 'mean / nice / sarcastic' },
  { keys: 'R', label: 'reconnect the coach' },
  { keys: 'O', label: 'toggle the offline badge' },
  { keys: 'C', label: 'toggle captions' },
  { keys: '?', label: 'show or hide this list' },
  { keys: 'Esc', label: 'dismiss overlays' },
]

/**
 * Rendered by the '?' overlay. Single source of truth for what the keys do, and it has to
 * track the gate below: a production overlay that lists F would be advertising a no-op.
 */
export const HOTKEY_HINTS: readonly HotkeyHint[] = import.meta.env.DEV
  ? [...DEV_HOTKEY_HINTS, ...SHIPPED_HOTKEY_HINTS]
  : SHIPPED_HOTKEY_HINTS

const PERSONA_BY_DIGIT: Readonly<Record<string, PersonaId>> = {
  '1': 'mean',
  '2': 'nice',
  '3': 'sarcastic',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return /^(input|textarea|select)$/i.test(target.tagName)
}

/** '/' is accepted as a stand-in for '?' so no shift key is needed on stage. */
function normaliseKey(key: string): string {
  if (key === '/') return '?'
  return key.toLowerCase()
}

export function useHotkeys(actions: HotkeyActions, enabled = true): void {
  const latest = useRef(actions)

  useEffect(() => {
    latest.current = actions
  }, [actions])

  useEffect(() => {
    if (!enabled) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      const actionsNow = latest.current
      const persona = PERSONA_BY_DIGIT[event.key]
      if (persona) {
        event.preventDefault()
        actionsNow.onPersona(persona)
        return
      }

      const handlers: Readonly<Record<string, (() => void) | undefined>> = {
        // Dev-only. `undefined` falls through the `if (!handler) return` below, so in a
        // production build F is simply not a hotkey — it is not a hotkey that does nothing.
        f: import.meta.env.DEV ? actionsNow.onSyntheticRep : undefined,
        r: actionsNow.onReconnect,
        o: actionsNow.onToggleOffline,
        c: actionsNow.onToggleCaptions,
        '?': actionsNow.onToggleHint,
        escape: actionsNow.onEscape,
      }
      const handler = handlers[normaliseKey(event.key)]
      if (!handler) return
      event.preventDefault()
      handler()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
