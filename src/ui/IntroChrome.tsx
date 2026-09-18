/**
 * Non-interactive furniture for the intro: the atmosphere behind everything, the
 * nav bar, and the grain over the top.
 *
 * The atmosphere is never a flat fill — two persona-tinted radials, two slowly
 * breathing orbs, a vignette that pulls the corners down, and film grain above it
 * all. Every layer is `aria-hidden` and `pointer-events: none`; all of the shape
 * lives in the stylesheet, so this file stays a list of surfaces.
 */
import { REVEAL_MS, revealAt } from './introMotion'

export function IntroAtmosphere() {
  return (
    <div className="atmos" aria-hidden="true">
      <div className="atmos__base" />
      <div className="atmos__orb" />
      <div className="atmos__orb atmos__orb--b" />
      <div className="atmos__vig" />
    </div>
  )
}

export function IntroNav() {
  return (
    <header className="nav" data-reveal="fade" style={revealAt(REVEAL_MS.nav)}>
      <div className="nav__in">
        <p className="wordmark">
          SPOTTER<b>.</b>
        </p>
        <span className="nav__spacer" />
        <div className="nav__meta">
          <span className="pill pill--hide">
            <span className="pill__dot" aria-hidden="true" />
            Camera &amp; mic
          </span>
          <span className="pill">Beta</span>
        </div>
      </div>
    </header>
  )
}

export function IntroGrain() {
  return <div className="grain" aria-hidden="true" />
}
