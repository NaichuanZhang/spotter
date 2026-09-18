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
camera ──► MediaPipe PoseLandmarker (33 landmarks, 30fps, on-device)
             │
             ├─ angles      elbow (depth) · shoulder-hip-ankle (plank) · ear-shoulder-hip (neck)
             ├─ rep machine two-state hysteresis, 100° down / 155° up
             ├─ faults      sag · pike · partial depth · no lockout · craned neck · flared elbows
             └─ gate        persistence → per-fault cooldown → token bucket (severity pre-empts)
                            │
                            ▼  one text line, pushed as a synthetic user turn
                  Higgs Realtime  (browser-direct WebSocket, ~600ms to speech)
                            │
                            ├─ streamed 24kHz PCM audio  ─► AudioWorklet
                            ├─ transcript deltas         ─► captions
                            └─ tool calls                ─► handled IN the browser
```

**The division of labour is the whole architecture.** Geometry decides *what* is wrong — deterministic,
offline-capable, never hallucinates. The model decides *how* to say it. If the model says something
stupid the measurement is still correct, and rep counting keeps working when the network dies.

### Tool calls

Five tools, all executing in the browser (the state lives there, so no tool makes a network call):

| Tool | What it does |
|---|---|
| `show_reference` | Puts a reference-form clip on screen. Makes tool calling *visible* to a judge. |
| `set_persona` | Hot-swaps Mean/Nice/Sarcastic via `session.update` — no reconnect. |
| `get_workout_state` | Rep count, depth, active faults. |
| `get_heart_rate` | Mocked biometric. Returns `simulated: true` **in the result**, so the model cannot claim it came from a real sensor. |
| `log_set` | Ends the set, renders a summary. |

### Avatar

Higgs Avatar renders in ~12s; the voice answers in ~600ms — so a live lip-synced avatar is physically
impossible. Rather than fake it with a talking loop, the avatar owns the **pre-workout intro**: one
baked video per persona, perfect lip sync, zero live risk. In-workout is voice + captions.

Side benefit: the workout screen has two video surfaces instead of three, which is what makes the
Apple Fitness+-style layout work at all.

---

## Stack

- **Boson AI Higgs Realtime** — speech-to-speech over a browser-direct WebSocket, with tool calling
  in the audio path. Persona = `session.instructions` + voice.
- **Boson AI Higgs Avatar** — baked persona intro videos, driven by `higgs-tts-v3` with
  `<|style:shouting|>` / `<|emotion:anger|>` prosody tags.
- **InstaCloud** — holds `BOSON_API_KEY`, serves one route + static assets.
- **MediaPipe Tasks Vision** — `pose_landmarker_full`, `delegate: 'GPU'` (WebGL2, so Safari works).
- **Vite + React 19 + TypeScript** strict.

No Pipecat, no Python, nothing in the hot path. The browser talks straight to Higgs using a
short-lived ephemeral token; the real API key never reaches the client.

### Backend, in full

```
POST /api/session  ->  mints a bai-eph- ephemeral token   (the only required route)
GET  /healthz      ->  200
                       + static hosting for dist/
```

That is the entire server. No database, no queue, no WebSocket relay.

---

## Running it

```bash
npm install
npm run vendor:mediapipe        # pulls the pose model + wasm into public/vendor (~43MB, gitignored)

export BOSON_API_KEY=bai-...    # claim the trial credit first — it is NOT automatic
npm run serve &                 # token route on :8080
npm run dev                     # app on :5173
```

Optional asset generation:

```bash
npm run bake:intros             # renders the 3 persona avatar intros (~12s each, costs credits)
npm run probe:realtime          # latency + tool-call harness; prints p50/p95
```

Tests and gates:

```bash
npm test                        # 93 tests — pose geometry, rep machine, fault gate, mock vitals
npm run typecheck
npm run build
```

### Demo-day hotkeys

`F` synthetic rep · `1`/`2`/`3` persona · `R` reconnect · `O` offline badge · `C` captions · `?` help

---

## Measured, not assumed

Every load-bearing claim was verified against the live API rather than read from docs:

| | |
|---|---|
| Pose event → first audio | **596 / 619 ms** |
| `show_reference` tool call from a pushed event (no mic) | fires; coach then speaks about the clip |
| Persona hot-swap mid-session | works, no reconnect |
| Avatar render | 12 s → 4.57 s clip, 640×640, 363 KB |
| TTS-3 prosody tags | parsed and consumed, not read aloud |

---

## Safety

Every persona is instructed to never comment on the user's body, weight, or appearance, and never to
give medical or injury advice. The mean coach is harsh about **effort and form only** — never about
the person. If the user mentions pain, all three personas drop character and tell them to stop.

Heart rate is **simulated**, labelled as such on screen, and flagged `simulated: true` in the tool
result so the model cannot misrepresent it.

## Known limitations

- The model cannot *compare* you to the reference clip — it has no vision. `show_reference` is a
  teaching aid for the human, not a visual diff.
- BlazePose assumes a vertical, hip-centred body with the head visible. A pushup is horizontal, so
  thresholds need calibrating on the actual camera at the actual height.
- One browser tab at a time: Higgs Realtime has an undocumented concurrency limit (close code `1013`).
