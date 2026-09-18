/**
 * ONE entrance for the intro, declared once.
 *
 * Reading order, not DOM order: the nav fades, the copy rises out of its own
 * baseline line by line, the avatar object arrives EARLY (it is the thing the
 * screen is about), and the persona cards land last with a per-index stagger. The
 * last pixel settles at ~740 ms, which is about as long as an entrance can run
 * before it reads as a slow page instead of a considered one.
 *
 * Delays live here rather than in the stylesheet because the card row's stagger is
 * a function of index, and because one table is easier to re-time than fourteen
 * scattered rules. CSS owns the curve and the distance; this owns the clock.
 */
import type { CSSProperties } from 'react'

/** Milliseconds after first paint. */
export const REVEAL_MS = {
  nav: 0,
  eyebrow: 80,
  /** One per headline line — the rag is a decision, so each line has its own beat. */
  headline: [120, 180, 240],
  /** Before the deck on purpose: the avatar is the hero, not the supporting copy. */
  object: 170,
  deck: 300,
  actions: 350,
  specs: 400,
  pickerHead: 400,
  firstCard: 420,
  cardStep: 55,
} as const

/** Per-card delay, so the row cascades instead of arriving as one slab. */
export function cardRevealMs(index: number): number {
  return REVEAL_MS.firstCard + index * REVEAL_MS.cardStep
}

/**
 * The stylesheet reads `--d` as its animation-delay. Custom properties are not in
 * React's CSSProperties, hence the assertion — it is the only cast in this screen.
 */
export function revealAt(ms: number): CSSProperties {
  return { '--d': `${ms}ms` } as CSSProperties
}
