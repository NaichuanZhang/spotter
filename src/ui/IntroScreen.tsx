/**
 * Intro screen — an Apple-product-page layout: explanatory lede and spec row on the
 * left, the baked avatar in a glass panel on the right, the three coaches beneath.
 *
 * It has two jobs and they are in tension, which is why the layout is shaped the way
 * it is. It has to EXPLAIN the product (what the camera measures, how fast the coach
 * answers, that the video never leaves the device) and it has to SELL the gimmick —
 * hence the quote card, which shows one bad rep scored three different ways before
 * the user has done a single one.
 *
 * WHAT THIS FILE OWNS: the sound contract and the two callbacks into App.
 *
 * SOUND IS EARNED. The baked intros carry a real AAC track — the coach actually
 * introduces itself — but browsers refuse audible autoplay without a prior user
 * gesture, so a clip has to START MUTED or it will not start at all. `sound` flips to
 * 'on' only on a genuine gesture: picking a persona card, or the affordance in the
 * panel's meter for the user who never picks one. If an audible play is refused
 * anyway we land on 'blocked', which restores the affordance and says so out loud
 * instead of leaving a frozen face and no explanation. AvatarStage holds the media
 * half of the same contract (muted clips loop, audible ones do not).
 *
 * START IS ONE CLICK. `onStart` is handed to the button untouched: App unlocks the
 * AudioContext inside that handler, and a gesture that has been deferred is no
 * longer a gesture. `onPersona` fires on every selection so App can hot-swap the
 * live session's persona — the same callback the workout screen's rail uses.
 *
 * COPY COMES FROM DATA. Names, taglines, reactions, hotkeys and clip paths all come
 * from personaView (src/ui/PersonaRail.tsx, backed by coach/personas.ts); the rep
 * count comes from the `target` prop. No persona string is typed into this screen.
 */
import { useCallback, useMemo, useState } from 'react'
import type { PersonaId } from '../types/tools'
import { personaView } from './PersonaRail'
import AvatarStage from './AvatarStage'
import IntroLede from './IntroLede'
import PersonaCards from './PersonaCards'
import { IntroAtmosphere, IntroGrain, IntroNav } from './IntroChrome'
import { REVEAL_MS, revealAt } from './introMotion'

interface IntroScreenProps {
  readonly persona: PersonaId
  readonly onPersona: (persona: PersonaId) => void
  readonly onStart: () => void
  readonly target: number
}

/**
 * 'muted'   — no gesture yet, clip loops silently, affordance showing.
 * 'on'      — a gesture earned sound; the clip plays audibly, once.
 * 'blocked' — the browser refused an audible play. Muted again, and we say why.
 */
type SoundState = 'muted' | 'on' | 'blocked'

const BLOCKED_MESSAGE = 'Your browser held the sound back — tap the speaker to try again.'

export default function IntroScreen({ persona, onPersona, onStart, target }: IntroScreenProps) {
  const [sound, setSound] = useState<SoundState>('muted')
  const active = personaView(persona)

  /** Any deliberate gesture counts. Idempotent, so repeat clicks are harmless. */
  const requestSound = useCallback(() => setSound('on'), [])

  /** Must be stable: AvatarStage's playback effect depends on this identity. */
  const refuseSound = useCallback(() => setSound('blocked'), [])

  const pickPersona = useCallback(
    (id: PersonaId) => {
      setSound('on')
      onPersona(id)
    },
    [onPersona],
  )

  const status = useMemo(() => {
    if (sound === 'blocked') return BLOCKED_MESSAGE
    if (sound === 'on') return `Sound on · ${active.name} is introducing itself.`
    return ''
  }, [sound, active.name])

  return (
    <main className="intro">
      <IntroAtmosphere />
      <IntroNav />

      <div className="shell">
        <section className="hero">
          <IntroLede target={target} onStart={onStart} status={status} />

          <div className="stagewrap" data-reveal="object" style={revealAt(REVEAL_MS.object)}>
            <AvatarStage
              persona={persona}
              audible={sound === 'on'}
              onSoundRequest={requestSound}
              onSoundRefused={refuseSound}
            />
          </div>
        </section>

        <PersonaCards persona={persona} onSelect={pickPersona} />
      </div>

      <IntroGrain />
    </main>
  )
}
