/**
 * THE ONE SOURCE for everything the AVATAR render path needs per persona:
 * voice, fallback voice, ref_image, TTS style tag.
 *
 * WHY THIS FILE EXISTS, and why it is under server/ of all places:
 *   - Two plain-Node consumers need these values and neither has a bundler:
 *     `server/index.mjs` (POST /api/verdict, the runtime outro render) and
 *     `scripts/bake-intros.mjs` (build-time intro render). They used to be two
 *     copies of the same table, and a copy already drifted once — bake-intros
 *     shipped chloe/marcus while src/coach/personas.ts shipped eleanor/oliver,
 *     so two of three personas introduced themselves in a voice they do not
 *     coach in. A mismatched voice between the intro and the outro is worse
 *     still: the same screen, bookended by two different people.
 *   - It CANNOT live in src/. The Dockerfile's runtime stage copies only
 *     `dist/`, `package.json` and `server/`, so a shared module anywhere else
 *     is absent from the container that has to serve /api/verdict. Under
 *     server/ it ships for free and the build stage (which copies `scripts/`)
 *     can still reach it.
 *   - `src/coach/personas.ts` REMAINS the source of truth for the coaching
 *     voice. This file is a hand-mirrored copy of the two fields the avatar
 *     path needs, because Node cannot import a .ts without a bundler and
 *     personas.ts is owned by another workflow. The copy is NOT silent:
 *     `node scripts/verdict-cli.mjs --check-sources` parses personas.ts and
 *     fails loudly if the two disagree. Run it after ANY voice change.
 */

/** Persona ids, in the UI's tab order. Mirrors PERSONA_ORDER in src/coach/personas.ts. */
export const AVATAR_PERSONA_IDS = Object.freeze(['mean', 'nice', 'sarcastic'])

/**
 * The COMPLETE Higgs preset voice list. Anything else fails, and on the avatar
 * route it fails ASYNCHRONOUSLY: the POST succeeds, then the job reports
 * status 'failed' with "tts stream failed: 400 Unknown voice", so a typo costs
 * a whole render cycle instead of being rejected up front.
 * Mirrors CONFIRMED_VOICES in src/coach/personas.ts.
 */
export const AVATAR_CONFIRMED_VOICES = Object.freeze([
  'chloe',
  'eleanor',
  'jake',
  'marcus',
  'nora',
  'oliver',
])

/**
 * `refImage` must be a URL the BOSON BACKEND can fetch server-side, not merely
 * one your browser can open: Wikimedia returns 403 to it, i.pravatar.cc works.
 * These exact images are what the baked intros used, so the outro face is the
 * same coach — a different face reads as a different character.
 *
 * `ttsTag` is an inline TTS-3 tag. Tags ARE parsed and consumed (not read
 * aloud) on the TTS/avatar path, and do NOTHING on Realtime. Vocabulary
 * confirmed from the preset-voice sample inputs in Boson's voice docs.
 *
 * `voice` / `fallbackVoice` are the measured picks, mirrored from
 * src/coach/personas.ts:
 *   mean      jake    — deepest measured F0 (122 Hz), drill-instructor timbre
 *   nice      eleanor — loudest and fastest preset, despite docs saying "calm"
 *   sarcastic oliver  — quietest ON PURPOSE: deadpan raises speed, not volume
 * Fallbacks are collision-free: no persona may fall back onto another
 * persona's voice, or one transient rate limit finishes the demo in the wrong
 * character.
 */
export const AVATAR_PERSONAS = Object.freeze({
  mean: Object.freeze({
    id: 'mean',
    voice: 'jake',
    fallbackVoice: 'marcus',
    refImage: 'https://i.pravatar.cc/512?img=12',
    ttsTag: '<|style:shouting|><|emotion:anger|>',
  }),
  nice: Object.freeze({
    id: 'nice',
    voice: 'eleanor',
    fallbackVoice: 'chloe',
    refImage: 'https://i.pravatar.cc/512?img=47',
    ttsTag: '<|emotion:enthusiasm|>',
  }),
  sarcastic: Object.freeze({
    id: 'sarcastic',
    voice: 'oliver',
    fallbackVoice: 'nora',
    refImage: 'https://i.pravatar.cc/512?img=33',
    ttsTag: '<|emotion:amusement|>',
  }),
})

/** True for a value that is a known persona id. Use at every boundary. */
export function isAvatarPersonaId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AVATAR_PERSONAS, value)
}

/** Throws on an unknown id — callers at a boundary must use isAvatarPersonaId first. */
export function getAvatarPersona(id) {
  if (!isAvatarPersonaId(id)) throw new Error(`unknown persona: ${String(id)}`)
  return AVATAR_PERSONAS[id]
}

/**
 * Fail at module load rather than at render time. A voice typo here is the one
 * mistake this file exists to prevent, and the avatar route would not learn
 * about it for ~12 seconds.
 */
function assertVoicesAreConfirmed() {
  for (const id of AVATAR_PERSONA_IDS) {
    const persona = getAvatarPersona(id)
    for (const field of ['voice', 'fallbackVoice']) {
      if (!AVATAR_CONFIRMED_VOICES.includes(persona[field])) {
        throw new Error(
          `${id}.${field} = "${persona[field]}" is not a confirmed Higgs preset ` +
            `(${AVATAR_CONFIRMED_VOICES.join(', ')})`,
        )
      }
    }
    if (persona.fallbackVoice === persona.voice) {
      throw new Error(`${id}.fallbackVoice must differ from ${id}.voice ("${persona.voice}")`)
    }
  }
  const primaries = AVATAR_PERSONA_IDS.map((id) => getAvatarPersona(id).voice)
  for (const id of AVATAR_PERSONA_IDS) {
    const persona = getAvatarPersona(id)
    const collision = primaries.find((v, i) => v === persona.fallbackVoice && AVATAR_PERSONA_IDS[i] !== id)
    if (collision) {
      throw new Error(`${id}.fallbackVoice "${collision}" is another persona's primary voice`)
    }
  }
}

assertVoicesAreConfirmed()
