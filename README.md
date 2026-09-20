# SPOTTER

**Your coach can actually see you. And three of them are rude about it.**

Drill-sergeant fitness chatbots already ship — none of them can see you. MediaPipe rep counters
litter GitHub — none of them have a character. SPOTTER is the intersection: a webcam measures your
pushup form locally at 30 fps, and a Boson AI Higgs voice reacts to *that specific rep* as one of
three swappable personalities — **Super Mean**, **Super Nice**, **Super Sarcastic**.

Same bad rep. Three wildly different reactions. Switchable mid-set.

---

## How it works

The interesting design decision: **the AI never sees a pixel.**

Higgs Realtime has no vision input, so all measurement is deterministic geometry in the browser. The
model receives exactly one line of text per event and supplies the *character*, not the judgement:

```
[EVENT] rep 4 completed | depth 61% | tempo 0.9s down / 0.7s up | hip_sag 26deg | 3 of 4 clean
```

```
camera ──► MediaPipe PoseLandmarker (33 landmarks, 30fps, on-device, GPU delegate)
             │
             ├─ angles      elbow (depth) · shoulder-hip-ankle (plank) · ear-shoulder-hip (neck)
             ├─ rep machine two-state hysteresis, 100° down / 115° up
             ├─ faults      sag · pike · partial depth · no lockout · craned neck · flared elbows
             ├─ observab.   every nullable angle is gated on the RAW frame, so an angle whose
             │              joint left the shot is withheld rather than republished
             └─ gate        persistence → per-fault cooldown → token bucket (severity pre-empts)
                            │
                            ▼  one text line, pushed as a synthetic user turn
                  Higgs Realtime  (browser-direct WebSocket, ~600ms to speech)
                            │
                            ├─ streamed 24kHz PCM audio  ─► AudioWorklet
                            ├─ transcript deltas         ─► captions
                            └─ tool calls                ─► handled IN the browser
                            ▲
                            └─ mic uplink (24kHz PCM16 append frames, server VAD owns the turn)
```

**The division of labour is the whole architecture.** Geometry decides *what* is wrong — deterministic,
offline-capable, never hallucinates. The model decides *how* to say it. If the model says something
stupid the measurement is still correct, and rep counting keeps working when the network dies.

### Honesty is a measured property, not a disclaimer

The engine will not state a number about a body part the camera cannot see. When the feet are out of
frame the hip line is withheld, `hipDeviationDeg` is `null`, the event line reads
`body line not visible — no hip judgement`, and a `form_unobservable` event tells the user to back up.
`clean` therefore means "no fault was **detected**", never "your form was verified". The same rule runs
all the way to the ending screen: its closing line and the avatar verdict both carry a "I could not see
your full body line" clause whenever that was true, and it is a *required* clause, so a wordier persona
cannot crowd it out.

### Two-way voice

The mic is a real uplink, not a stub. It appends 24 kHz PCM16 frames and never commits a turn — the
server's VAD sends `input_audio_buffer.committed` itself. Three pieces make it usable in a room:

- **A half-duplex gate.** While the coach is audible, no mic buffer leaves the client, so the model
  cannot hear itself. The HUD shows `LISTENING` or `MIC MUTED` accordingly.
- **Barge-in.** Talk over the coach and it stops mid-sentence: the queued audio is dropped, the caption
  clears, and the remainder of the server's in-flight response is discarded. Floor-relative trigger with
  a hysteresis hold, plus an echo guard for the case where the browser's AEC leaks the coach's own voice.
- **A bounded silence flush.** Server VAD closes a turn on silence *in the stream*, not on the absence of
  frames, so the uplink appends its own run of zeros once the mic falls quiet.

The gate and the uplink were proved against the live API with speech synthesised by Higgs TTS and played
through the real `AudioIn` seam — the coach's own line at full level produced **zero appends** while it
was audible. Barge-in's remaining assumption is the browser's echo cancellation, which cannot be tested
without a real microphone in a real room: if AEC holds poorly the detector hears the coach's leaked voice
and interrupts *itself*. `mic.bargeIn().earlySuppressions` is the diagnostic, and
`BARGE_IN_TUNING.enabled` is the off switch.

### Tool calls

Five tools, all executing in the browser (the state lives there, so no tool makes a network call):

| Tool | What it does |
|---|---|
| `show_reference` | Puts a reference-form clip on screen. Makes tool calling *visible*. |
| `set_persona` | Hot-swaps Mean/Nice/Sarcastic via `session.update` — no reconnect. |
| `get_workout_state` | Rep count, depth, active faults. The only tool the coach reads numbers out of. |
| `log_set` | Ends the set, which takes the user to the ending screen. |
| `play_music` | Starts or stops the workout bed through the app speakers, ducked while the coach talks. |

`TOOL_DEFS` in `src/types/tools.ts` is the single source of truth, and `personas.test.ts` iterates it,
so the prompt and the schema cannot drift apart.

### Avatar: the intro and the outro, never live

A Higgs Avatar render takes tens of seconds and the voice answers in ~600 ms, so a live lip-synced
avatar is physically impossible. Rather than fake it with a talking loop, the avatar owns the two moments
where a wait is free:

- **Pre-workout intro** — one baked video per persona, committed to `public/avatars/`, perfect lip sync,
  zero live risk.
- **Post-set verdict** — `POST /api/verdict` takes the set's STATS (never text), templates the spoken
  line server-side, renders a talking-head mp4 and streams it back during the rest period.

In-workout is voice + captions. Side benefit: the workout screen has two video surfaces instead of
three, which is what makes the Apple Fitness+-style layout work at all.

### The ending screen

Two stages, and **stage one never waits on stage two**. The words come back from
`POST /api/verdict` with `preview: true` in ~55 ms and spend no credits, so the screen is complete
immediately; the mp4 arrives 22-31 s later as a bonus beat. A failed render says nothing on screen —
every non-200 from the route still carries the coach's real closing words in its JSON body.

---

## Stack

- **Boson AI Higgs Realtime** — speech-to-speech over a browser-direct WebSocket, with tool calling
  in the audio path. Persona = `session.instructions` + voice (mean `jake`, nice `eleanor`,
  sarcastic `oliver`; collision-free fallbacks).
- **Boson AI Higgs Avatar** — baked persona intro videos and the rendered end-of-set verdict, both
  driven by `higgs-tts-v3` with `<|style:shouting|>` / `<|emotion:anger|>` prosody tags.
- **InstaCloud** — holds `BOSON_API_KEY`, serves the API routes + static assets.
- **MediaPipe Tasks Vision** — `pose_landmarker_full`, `delegate: 'GPU'` (WebGL2, so Safari works).
- **Vite + React 19 + TypeScript** strict, `verbatimModuleSyntax` (type-only imports must say
  `import type`).

No Pipecat, no Python, nothing in the hot path. The browser talks straight to Higgs using a
short-lived ephemeral token; the real API key never reaches the client.

### Offline-first assets

Nothing the app needs at runtime comes off a CDN:

| Asset | Where | Size |
|---|---|---|
| MediaPipe pose model + wasm | `public/vendor/` (gitignored, fetched by script) | ~43 MB |
| 14 reference-form clips + landmarks | `public/clips/` | 1.8 MB |
| 3 baked avatar intros | `public/avatars/` | 2.5 MB |
| Music bed | `public/music/` | 576 KB |
| ClashDisplay Bold + Semibold | `src/ui/fonts/` | 30 KB |

The reference clips are skeleton animations rendered by `scripts/render-refs.mjs` from real pose
landmarks (`public/clips/landmarks.json`, extracted from a tutorial video with the app's own vendored
model). **No frame of the source video is in this repo**, and `scripts/extract-landmarks.mjs` is both the
regenerator of that fixture and the only place its schema is documented.

### Backend, in full

```
POST /api/session  ->  mints a bai-eph- ephemeral token   (the only required route)
POST /api/verdict  ->  stats in, spoken line + rendered mp4 out
                       `preview: true` returns the words only, in ~55ms, for free
GET  /healthz      ->  200
                       + static hosting for dist/
```

Plain Node, zero dependencies, `node:` builtins only. No database, no queue, no WebSocket relay. The
verdict route accepts **exactly nine named fields and templates the words itself**, so the URL is not an
open relay onto a paid generative API on someone else's credits — `{...stats, text: "say anything I
want"}` is a 400, and so is any field the client contract has since dropped.

---

## Running it

```bash
npm install
npm run vendor:mediapipe        # pulls the pose model + wasm into public/vendor (~43MB, gitignored)

export BOSON_API_KEY=bai-...    # claim the trial credit first — it is NOT automatic
npm run serve &                 # API routes + static hosting on :8080
npm run dev                     # app on :5173, /api proxied to :8080
```

Optional asset generation:

```bash
npm run bake:intros             # renders the 3 persona avatar intros (~12s each, costs credits)
node scripts/render-refs.mjs    # re-renders the 14 reference clips from landmarks.json
node scripts/verdict-cli.mjs check-sources
                                # asserts server/*.mjs's hand-mirrored tables still match src/
```

Tests and gates:

```bash
npm test                        # 566 passed / 19 skipped — pose geometry, rep machine, fault gate,
                                #   speech policy, barge-in wiring, verdict text and render
npm run typecheck
npm run build
```

18 of the 19 skipped tests are live-API probes that need `SPOTTER_LIVE=1` and a key — they are the
harnesses that measured the numbers below. The 19th needs an `OfflineAudioContext`, which node does not
have.

### Hotkeys

`1`/`2`/`3` persona · `R` reconnect · `O` offline badge · `C` captions · `?` help · `Esc` dismiss

There is no key that fabricates a rep in a shipped build. `F` injects a synthetic rep in a **dev build
only**: `import.meta.env.DEV` gates the binding, so in production the bundle's keymap has no `f` entry
and `injectSyntheticRep` minifies to an empty function — the `?` overlay does not list it either, because
a production overlay that advertised it would be advertising a no-op. The capability is kept rather than
deleted because a headless browser has no camera and it is that test's only route past one; see the block
comment above `SYNTHETIC_REP` in `src/pose/repMachine.ts`.

---

## Measured, not assumed

Every load-bearing claim was verified against the live API rather than read from docs.

| | |
|---|---|
| Pose event → first audio | **596 / 619 ms** |
| Spoken turn → first audio (n=4, one session) | **p50 1059 ms**, of which ~570 ms is VAD end-pointing |
| `show_reference` from a pushed fault event | 7/12, 9/12 and 4/6 across sessions — non-deterministic, real |
| `play_music` from a spoken request | 4/4 across 4 sessions, model volunteers the track id |
| Persona hot-swap mid-session | works, no reconnect |
| Avatar **intro** render (short line) | 12 s → 4.57 s clip, 640×640, 363 KB |
| Avatar **verdict** render (~250 char line) | **22.4 / 22.5 / 26.6 / 30.6 / 30.7 s** → 0.9-1.3 MB |
| TTS-3 prosody tags | parsed and consumed, not read aloud |
| Six real pushups from the landmark fixture | 6 counted, per recorded take |

**Render time tracks the driving audio, not the character count:** `render ≈ audio duration + 9 s`, and a
~250-260 character verdict is 18.0-22.6 s of speech. The old 12 s figure was for the short baked intro
lines only; the single lever on the verdict is `VERDICT_LIMITS.maxSpokenChars`.

Two findings that shape the code and are easy to undo by accident:

- **`audio.output.temperature: 0` is off deliberately.** It makes the decode reproducible (8/9 runs
  byte-identical, replicated) *and* degenerate: 7 of 22 live turns returned 72-142 seconds of PCM for a
  2-4 second line. With the field omitted, 0 runaways in 96 turns.
- **A speed-only `session.update` still re-validates the session's current voice**, so it can 429 on a
  frame that carries no voice at all — 8/20 at a 300 ms gap. Post-ack it is a no-op, not fatal, but
  per-event pace patching ships disabled because of it.

---

## Safety

Every persona is instructed to never comment on the user's body, weight, or appearance, and never to
give medical or injury advice. The mean coach is harsh about **effort and form only** — never about
the person. If the user mentions pain, all three personas drop character and tell them to stop:
measured 3/3 personas over the mic and 6/6 turns naming a professional, **and on the quiet rung** —
Mean's safety line comes out 35.6% quieter than its own coaching in the same session, because in this
product capitalisation is volume and SAFETY has to override the spelling as well as the words.

Nothing on screen is modelled. Reps, clean reps, elapsed time, best depth and fps are all measured by
the pose engine, and the ending screen and the spoken closing line quote only those.

## Known limitations

- The model cannot *compare* you to the reference clip — it has no vision. `show_reference` is a
  teaching aid for the human, not a visual diff.
- BlazePose assumes a vertical, hip-centred body with the head visible. A pushup is horizontal, so
  thresholds need calibrating on the actual camera at the actual height. `upEnterDeg: 115` was measured
  off one real take and sits 6.7° below its worst rep — that margin is what fatigue may eat.
- **`craned_neck` fires outside the pushup.** On the real fixture, 49 frames of SEVERE neck angle land
  after the last rep ends — i.e. while the user is getting off the floor. Fixing it needs a notion of
  "currently in a plank" that does not exist yet.
- One browser tab at a time: Higgs Realtime has an undocumented concurrency limit (close code `1013`).
- A turn that triggers two tool calls draws one `server_error: 400: No user input` per extra call. The
  coach still speaks correctly and the session stays open; the alternative risks omitting the mandatory
  `response.create`, which is permanent, error-free mute.
- `npm run probe:realtime` does not currently run: it imports `TOOL_DEFS` from `src/types/tools.ts`,
  which imports `../coach/musicPlayer` extensionless, and Node's ESM resolver cannot follow that.
- `public/music/hype-01.mp3` is a commercial track (ID3 reads `Farruko - Pepas`) and needs replacing
  with a cleared or generated bed.
