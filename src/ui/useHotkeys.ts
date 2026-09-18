/**
 * Demo-day keyboard controls.
 *
 * Every key here exists so a human on a stage can force a moment to happen on
 * cue: fake a rep, swap the coach, kick the socket. The listener is registered
 * once and reads the latest actions out of a ref, so passing fresh closures from
 * App does not thrash window listeners.
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

/** Rendered by the '?' overlay. Single source of truth for what the keys do. */
export const HOTKEY_HINTS: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: 'F', label: 'inject a synthetic rep' },
  { keys: '1 / 2 / 3', label: 'mean / nice / sarcastic' },
  { keys: 'R', label: 'reconnect the coach' },
  { keys: 'O', label: 'toggle the offline badge' },
  { keys: 'C', label: 'toggle captions' },
  { keys: '?', label: 'show or hide this list' },
  { keys: 'Esc', label: 'dismiss overlays' },
]

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
        f: actionsNow.onSyntheticRep,
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
