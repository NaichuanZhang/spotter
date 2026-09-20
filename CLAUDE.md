# Task: spotter-fitness-coach

Resume this task's session (run from inside this folder):

```
claude --resume 536d8139-2b8c-4a3b-b7c2-400e0c5d91ae
```

- **Session ID:** `536d8139-2b8c-4a3b-b7c2-400e0c5d91ae`
- **Created:** 2026-09-18 12:35
- **Status:** active

> Session transcripts are keyed by directory. If this folder is ever moved or
> renamed, the resume command stops finding the session — see the root
> CLAUDE.md "Moving or renaming a task" note before doing either.

## Goal

SPOTTER: AI fitness coach with 3 personas (mean/nice/sarcastic) that watches pushups via webcam (MediaPipe) and reacts in character via Boson Higgs realtime voice. Browser-direct WebSocket, Instacloud hosts token route + static. Baked avatar intro videos.

## Key paths

- Task folder: `/Users/zhangnai/cworkspace/tasks/spotter-fitness-coach`
- **Full plan:** `~/.claude/plans/hackathon-plan-session-tech-crystalline-shannon.md`
- Contract (frozen): `src/types/events.ts`, `src/types/tools.ts`

## Architecture in one paragraph

Browser does everything: MediaPipe PoseLandmarker measures pushup geometry, a hysteresis rep machine
and fault gate turn that into `CoachEvent`s, and `toEventLine()` renders each as ONE line of text
pushed to Higgs Realtime over a **browser-direct WebSocket** as a synthetic user turn. The model has
no vision — it supplies character, not measurement. Tool calls come back and run *in the browser*, so
`show_reference` updates the UI by direct function call. Instacloud holds `BOSON_API_KEY` and serves
one route (`POST /api/session` mints an ephemeral token) plus static files. No Pipecat, no Python.

## Verified against the live API (2026-09-18)

| Thing | Result |
|---|---|
| Browser-direct WS, subprotocol `bai-client-secret.<eph>` | works, no auth header |
| Pose event → first audio | **596 / 619 ms** |
| `show_reference` tool call from a pushed event (no mic) | fired, then coach spoke about the clip |
| Persona hot-swap via `session.update` | works mid-session, no reconnect |
| Avatar render `POST /v1/videos` | **12 s** → 4.57 s clip, 640×640, 363 KB |
| TTS-3 tags `<\|style:shouting\|>` | parsed and consumed, not read aloud |

Model ids on this key: `higgs-realtime`, `higgs-realtime-tts`, `higgs-stt-3.1`, **`higgs-tts-v3`**,
`higgs-tts-mps`. `higgs-avatar` is NOT in `/v1/models` but `/v1/videos` works anyway.

## Gotchas that cost an hour each

- `response.create` is **mandatory** after `function_call_output` — omit it and the coach goes
  silently mute with no error event.
- Tool `output` must be a JSON **string**, not an object.
- Every tool call is announced **twice** → dedupe on `call_id`.
- `detectForVideo(video, timestamp)` — the timestamp is required in all four shipped overloads even
  though Google's official sample omits it. Omitting it yields garbage landmarks, not an error.
- Sessions close after **5 min with no user *speech***. We push a user item per rep + a 4-min
  heartbeat. Untested whether the synthetic items reset it.
- `client_secrets` body accepts **only** `expires_after` (`additionalProperties: false`) — the session
  cannot be pre-configured server-side, so persona prompts and tool schemas live in browser JS.
- Hip sag vs pike are **indistinguishable** by unsigned body-line angle (measured 0.22° apart for an
  equal-magnitude sag vs pike — not exactly identical, because the body line tilts ~7.6° so a vertical
  hip offset also slides the hip *along* the line). The sign comes from comparing `hip.y` to the
  shoulder→ankle line at the hip's x. Easiest thing in the codebase to get backwards; there is a
  regression test that runs synthetic poses through the real `measureAngles`, so an inverted sign fails.
- Rep-threshold traps: `partial_depth` must be **below** `downEnterDeg` or it is unreachable dead code,
  and `no_lockout` cannot be derived from `maxElbowAngle` because `upEnterDeg` gates rep completion.
  Both were bugs in the original plan; `validateRepThresholds()` now throws at module load on the first.

## Notes

<!-- running log: decisions, findings, where things stand -->

**2026-09-18 — planning + scaffold**

- Plan approved after four rounds of pushback. Recon used 16 subagents across 4 workflows; every
  load-bearing API claim was adversarially verified, then I probed the live API directly.
- **Dropped Pipecat.** `pipecat-boson` is a 13-star package (v0.1.3) that crashes on import against
  `pipecat-ai` ≥1.8.0 (needs 1.6.0 pinned), emits no video frames, and would put a Python process in
  a hot path that already runs at 600 ms from the browser. Boson's own docs ship a complete
  tool-calling loop example, so there was nothing to gain. Kept as the fallback if ephemeral keys are
  ever disabled.
- **Avatar = baked intros only** (user decision). Higgs Avatar renders in 12 s; voice answers in
  600 ms, so a live lip-synced avatar is impossible and a fake "talking loop" would look worse. Side
  benefit: the workout screen now has two video surfaces instead of three, which is what makes the
  Fitness+ layout viable.
- Scaffolded Vite + React 19 + TS strict. Pinned TypeScript to ~5.9 rather than the new 7.0 Go
  rewrite — an 8-hour sprint is the wrong place to debug a compiler port.
- Wrote the frozen contract first (`src/types/`), then fanned implementation to 4 parallel agents
  (pose / coach / ui / infra) plus a reconcile pass for `tsc` + `vitest` + `vite build`.

**2026-09-18 — reconcile pass**

All three gates are green: `tsc --noEmit` 0 errors, `vitest` 93/93 in 4 files, `vite build` clean,
and the shipped `npm run build` (`tsc -b && vite build`) too.

The four agents produced **zero type-level drift** — tsc was clean on the first run before any edit.
All the real drift was in **runtime string constants**, which neither tsc nor the bundler can see
because a `public/` asset path is just a `string` and a clock is just a `number`. Four bugs, all
found by diffing constants against what is actually on disk:

- 🔴 **`poseEngine.ts` pointed at a model that does not exist** — `/vendor/mediapipe/pose_landmarker_lite.task`
  and `/vendor/mediapipe/wasm`, but `scripts/fetch-mediapipe.mjs` writes `/vendor/pose_landmarker_full.task`
  and `/vendor/wasm` (wrong extra path segment *and* lite-vs-full). This would have failed inside
  `FilesetResolver` at startup — i.e. the pose engine, hence the entire product, never starts.
  Fixed to match the vendor script, which is the side with the byte-verified artifact on disk.
- 🔴 **Heart rate never left its resting value.** `repTimesRef` holds `event.at`, which the engine
  stamps with `performance.now()`, but `App.tsx` called `repsPerMinute(..., Date.now())`. Every rep
  timestamp then sits ~1.7e12 ms "in the past", so the 60s filter drops all of them and the rate is
  always 0. `get_heart_rate` would report ~64 bpm mid-set. Fixed by putting App's tick on
  `performance.now()`, matching the engine's documented single monotonic timeline.
- 🟡 Reference clips: coach said `/reference/<fault>-<view>.mp4`, infra's `public/clips/manifest.json`
  (already on disk, tracked in git, cached immutable by the server) says `/clips/`. **`/clips` wins** —
  shoot the 14 phone clips into `public/clips/`.
- 🟡 Intro videos: coach said `/intros/<persona>.mp4`, `scripts/bake-intros.mjs` writes
  `public/avatars/<persona>-intro.mp4`. **`/avatars/<persona>-intro.mp4` wins** (the bake script,
  the server cache prefix and `.gitignore` all already agree on it).

Verified rather than assumed: the **hip-sag sign convention is correct** end to end. Reasoned from
first principles — screen y grows downward, so a sagging hip has the larger y, hence
`hip.y - lineY > 0` = sag = positive. That matches `faults.ts` (positive → `sagging_hips`),
`repMachine`'s `worstSag = Math.max(0, dev)`, the frozen `toEventLine`, and the fixtures. The
regression test is not self-confirming: `saggingSet` runs synthetic poses through the *real*
`measureAngles`, so an inverted sign fails it. Nothing was flipped.

Also checked and found genuinely fine (two clock domains coexist but never meet): `FaultChip`'s
latch never reads `candidate.at`, and `ReferenceClip` uses `at` only as a React change token.

Added `src/mock/__tests__/heartRate.test.ts` (14 tests) — the mock had no coverage at all. It pins
the clock-domain contract, the asymmetric rise/decay curve, dt clamping, immutability, and that
`simulated: true` is always stamped. Caveat: it guards `repsPerMinute`'s semantics and *documents*
the failure mode, but it cannot guard `App.tsx`'s wiring — there is no jsdom in this repo, so
`App.tsx` remains untested.

**Open / next**

- ⏳ **Blocked:** InstaCloud device login awaiting human approval
  (`https://console.instacloud.com/device?user_code=5LGBSXV8`). Everything else is unblocked.
- The id the user supplied (`678966e0-15de-4eeb-b22a-3b441f53af52`) is an **org** id; `insta project
  link` needs a **project** id → run `insta project list` after login.
- Pin the `insta` CLI once a deploy works. It is pre-1.0 (`0.0.83`, published the same day as this
  research) and auto-updates could change flag behaviour mid-hackathon.
- **Biggest remaining risk is pose, not AI.** BlazePose assumes a vertical hip-centred body with the
  head visible; a pushup is horizontal. Budget the full H6:00–7:00 calibration block on the real
  camera at real height with three real bodies.
- ~~Reference clips still need shooting on a phone (~15 min, human task).~~ **Done, and not by
  phone.** All 14 exist in `public/clips/`, rendered by `node scripts/render-refs.mjs` as skeleton
  animations from real pose landmarks (`public/clips/landmarks.json`, extracted from a reference
  video with the app's own vendored model). 1.9 MB total, 640x360, h264/yuv420p, no audio. No frame
  of the source video is in the repo.

**2026-09-18 — vocal control (session payload, persona voices, per-severity dynamics)**

Implemented the measured vocal plan in `src/coach/{personas,higgsSocket,session}.ts`. The two things
worth remembering, both measured live, both contradicting what we went in believing:

- 🔴 **A speed-only `session.update` does NOT skip the voices lookup.** The plan's tier-1a
  per-severity pace patch rested on "a patch with no `voice` has no voice to validate". False: 20
  consecutive speed-only patches returned `Could not validate voice 'jake': voices API returned HTTP
  429` — **8/20 (40%) at a 300 ms gap, 1/20 (5%) at 2500 ms** — for frames containing no voice at all.
  The server re-validates the session's *current* voice on every `session.update`. Post-ack it is
  NOT fatal (session stayed open, audio kept flowing, the rejected patch is a plain no-op), so the
  cost is a `CoachError` per failure plus a silently-unbumped bark. Shipped **disabled** behind
  `PER_EVENT_PACE_ENABLED = false`. There is no such thing as a lookup-free partial patch.
- 🟡 **`temperature` 0.8 → 0.3 is required** (every acoustic measurement was taken at 0.3; at 0.8 the
  model overruns the 14-word cap). Side-effect seen in the live transcripts: the personas get more
  literal. Sarcastic said "Severe fault. Fix it now." — flat, and quoting event vocabulary CORE
  forbids. Nice said "Lock it down! Push through!" — drill-sergeant, not warm. Worth a human ear.
- Voice picks now follow measurement, not the docs: mean `jake`, nice `eleanor` (was `nora`, the
  slowest of all six presets while its own prompt says "warm does NOT mean slow"), sarcastic `oliver`.
  Fallbacks are collision-free (`marcus`/`chloe`/`nora`) — sarcastic used to fall back to Mean's `jake`.
- ⚠️ **`scripts/bake-intros.mjs` still renders intros with jake/chloe/marcus**, so nice and sarcastic
  introduce themselves in a voice they do not coach in. Re-bake those two (`npm run bake:intros`) with
  `eleanor` and `oliver`. Measurements do not permit moving the coaching voice to match the clips.
- Numeric fidelity at the new prompt, 20 live turns across all three personas: **1 defect** — Mean
  said "TWO SIX DEGREES" for `26deg` once in 10 turns. Zero in 5 nice and 5 sarcastic turns, so the
  caps arm is implicated. Under the plan's 1-in-5 switch threshold, so the validated prompt stays;
  the safer two-line variant is documented in `/tmp/vocal-plan.md` if it worsens.

**2026-09-18 — reference clips + real-motion fixture: verification pass**

Verified the 14 rendered clips and wired the extracted landmarks up as the repo's first
non-synthetic test fixture. Three things worth remembering:

- 🔴 **SPOTTER counts ZERO of the source demonstrator's six real pushups**, and this is now a test
  (`src/pose/__tests__/realMotion.test.ts`, 7 cases) that replays all 578 extracted frames through
  the real `measureAngles` → median-5 → `repMachine` chain. The detector and the geometry are fine
  on a horizontal body — every frame is measurable, `skipped` is 0 — so the *biggest stated risk on
  this project is retired*. What fails is calibration, in exactly one constant: `upEnterDeg = 155`.
  The six cycles top out at **121.7 / 122.4 / 123.6 / 126.7 / 129.0 / 151.0** smoothed degrees. All
  six break `downEnterDeg` (100), none come back up far enough to score, so the machine ends the
  clip stuck in `bottom`. Scoring all six needs `upEnterDeg ≈ 120`, which collapses the hysteresis
  gap from 55° to 20° — `repMachine.ts` says "the gap IS the algorithm", so that is a real trade to
  make on real hardware, deliberately **not** made by the test. The test asserts the measured zero;
  recalibrating will fail it on purpose.
- 🟡 **`hipDeviation` does not gate on ankle visibility.** The source crops the feet — only 45 of 578
  frames satisfy `requiredLandmarks`, ankle visibility is 0.14 median, ankle x reaches 1.27 — yet
  `measureAngles` returns a hip deviation on all 578 by extrapolating the shoulder→ankle line to an
  ankle the detector invented off-frame. Replaying the clip emits a **severe `piked_hips` at 68.3°**,
  which no spine can do. Pinned as a characterisation test; if `hipDeviation` learns to refuse an
  invisible ankle, rewrite that test to assert the refusal rather than loosen it.
- 🔴 **`public/music/hype-01.mp3` is committed and is a commercial track** — ID3 title reads
  `Farruko - Pepas (Official Video)`, 35 s, Traktor rip metadata, already in history (commit
  `815cec6`) and wired into `musicPlayer.ts`. Same licence question the reference clips were
  restructured to avoid. Needs replacing with a cleared/generated bed or dropping.

Also: nothing reads `public/clips/manifest.json` at runtime — `REFERENCE_CLIPS` in
`src/coach/toolHandlers.ts` is the table the coach actually speaks from, so the two sets of
descriptions must be kept in step by hand (or collapsed to one source).

**2026-09-18 — two-way voice wired (mic uplink + play_music)**

The app was one-way: the session advertised `audio.input` + `server_vad` and never sent a byte. It now
talks both directions, verified end to end against the live API — real 24 kHz speech in (`say` →
`afconvert`), `speech_started` / `speech_stopped` / `committed` back, a `play_music` tool call, then a
spoken reply. Probe: `SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveUplink` (skipped by default).

- 🔴 **Server VAD closes a turn on SILENCE IN THE STREAM, not on the absence of frames** — and
  `audioIn.ts`'s `silenceFloor` skips exactly the sub-floor buffers that carry it. Measured: a clip
  ending in digital silence produced `speech_started` and then *nothing at all* — no `speech_stopped`,
  no commit, no reply, no error. A real mic with `autoGainControl` sits above the floor on room tone,
  so it works in a browser by luck; an OS-muted mic lands on the broken case. `micUplink.ts` therefore
  appends its own bounded run of zeros after the mic falls quiet. 510 ms was NOT enough; 1800 ms closes
  it, so the hangover is in (0.51 s, 1.8 s].
- 🔴 **The server sends `input_audio_buffer.committed` itself.** Confirms the contract: append only,
  never commit, never `response.create` for speech.
- 🟡 `HiggsConnection` has no raw send, so the uplink gets the socket by wrapping the `createSocket`
  seam in `OpenOptions` (`src/coach/socketTap.ts`). The socket is promoted only after
  `openHiggsSocket` **resolves** — every failed attempt (voice 429, bad token) builds one too.
- 🟡 `ToolHandler` may now return a Promise (`play_music` waits for the browser's autoplay verdict, so
  the result can be truthful). `session.ts` keeps `handlingToolCall` set until it settles, and both a
  throw and a rejection are guarded — an unanswered tool call is permanent silence.
- 🟡 **`personas.ts` does not teach `play_music` yet.** Another workflow owns that file; the literal
  lines to paste into its `TOOLS` block were handed back with this work. Until they land,
  `personas.test.ts` pins the gap explicitly (`PROMPT_GAP`) instead of hiding it — deleting that entry
  without adding the prompt text re-hides a measured 0-tool-calls-in-6-runs failure mode.

**2026-09-18 — vocal stack: live verification pass (measured the SHIPPED code)**

Re-measured the applied vocal stack against the live API through a throwaway harness in
`/tmp/spotter-verify/` that imports the real `PERSONAS` and the real `buildSessionPayload` (rolldown
bundle of `src/coach/*`), so the numbers are what a browser actually gets. ~120 live turns.
Gates green after the two fixes below: `tsc` 0 errors, vitest 255 passed / 11 skipped, `npm run build`.

- 🔴 **`audio.output.temperature: 0` was a demo-ender and is now OFF** (`HIGGS.useOutputTemperature`,
  `higgsSocket.ts`). Greedy audio decoding degenerates: **7 of 22 live turns (32%) came back with
  72–142 seconds of PCM for a 2–4 second line** — usually speech, ~68 s of digital silence, then a
  short tail; once (nice/eleanor) **75.7 s of speech-active audio at RMS 0.286**, i.e. a loud
  three-quarter-minute babble. It hit all three personas (sarcastic 3/6, mean 1/6, nice 1/6). With the
  field omitted: **0 runaways in 96 turns**, max 8.5 s. It was also inflating length — nice ran 14–23
  words at 0 vs 11–14 with it off, so audio and text share one decode. `audioOut.maxQueuedSec` drops
  every chunk past 20 s, so each runaway cost the line its tail and pinned the UI at "speaking".
  The plan's claim for the field (8/9 runs byte-identical) REPLICATED exactly — it is real, it is just
  not worth a 32% chance of a 75-second utterance. `speed` is unaffected and stays (6/6 clean at 1.15).
- 🔴 **SAFETY was being spelled on the LOUD rung** and is fixed in `personas.ts`. "my shoulder is
  really hurting and I feel dizzy" came back from Mean as `"STOP THE SET! REST NOW! SEE A PROFESSIONAL
  IF IT DOESN'T SETTLE!"` — right content, but shouted, at RMS 0.1739 where the pre-ladder prompt
  measured 0.1408. `MEAN_CHARACTER`'s "You have no level setting… Every line is loud" beat SAFETY's
  "Drop the volume", because SAFETY only said it overrides *HOW YOU SOUND*, and in this product
  spelling IS volume. SAFETY now states the spelling override explicitly. Re-measured: **6/6 turns
  tell the user to stop, 6/6 name a professional, 6/6 on the quiet rung** (no caps, no exclamation
  marks), Mean's safety line now **35.6% quieter than its own coaching in the same session**.
  Pinned by 5 tests in `vocalControl.test.ts`, including one that Mean keeps its caps order for
  ordinary coaching lines so the fix cannot quietly cost the +31%.
- ✅ **MEAN is the win, and it is separated on every axis.** vs the pre-change arm (`git show HEAD`,
  checked out to /tmp), n=4 each: RMS **0.206 [0.194–0.216] vs 0.157 [0.152–0.163], +31%**, crest
  **4.69 [4.37–5.12] vs 6.24 [6.01–6.36], −25%**. Rising RMS with falling crest is the vocal-effort
  signature, not a gain change. Duration −28.5%, word count 10 vs 12–23 (the 14-word cap is obeyed at
  temperature 0.3 and was not at 0.8).
- 🟡 **NICE: the eleanor swap did NOT reproduce a loudness gain.** vs `nora`, n=4: RMS +1.2%
  (0.145–0.163 vs 0.147–0.159, **overlapping**), crest **+31% — the wrong direction** (6.13–6.91 vs
  4.57–5.56), and peak **1.000 on all four runs** vs nora's 0.67–0.82. So eleanor is pinned at digital
  full scale for the same average level. Pace, which was the swap's stated reason, is +17% but
  overlapping at n=4. The swap is defensible on its own grounds and the compressor bounds the peak,
  but "eleanor is the loudest preset" does not hold on this prompt and this line. Judge it by ear.
- 🟡 **SARCASTIC: no acoustic change at all**, every metric overlapping vs the same voice pre-change
  (RMS +1.3%, crest −1.4%). That is by design — oliver's rung is full stops, its lever is `speed` —
  but it means sarcastic gets nothing from this work except the pace change and the runaway fix.
- ✅ **The 429 finding reproduces exactly.** 20 consecutive speed-only patches: **12 acks / 8 errors at
  300 ms (40%)**, **20 acks / 0 errors at 2500 ms**, every error `"Could not validate voice 'jake':
  voices API returned HTTP 429"` on frames carrying no voice. Post-ack non-fatal confirmed both times
  (session open, audio still flowing after). `PER_EVENT_PACE_ENABLED = false` is the right default.
- ✅ **The pace lever itself works, and harder than predicted.** Words pinned verbatim (1 distinct
  text over 6 turns), Mean 1.12 vs 1.25: trimmed **3.71 s [3.08–4.62] → 2.61 s [2.26–3.02], −29.7%**,
  separated, and shorter in all three consecutive pairs. The plan's `duration = base/speed` predicts
  only −10.4%, so the relationship is NOT the pure resample at these values on this text.
- ✅ **Tool calls improved, not regressed.** `show_reference` **9/12 genuine fault turns** (was 7/12),
  with faults spaced past the prompt's own 20 s cooldown; the 3 misses were all `partial_depth MINOR`.
  `get_heart_rate` 3/3 on the first ask per persona — consecutive re-asks legitimately reuse the
  cached answer, and baseline behaved identically (3/12 by the same naive count), so the old "12/12"
  is not measurable this way.
- ✅ **Numeric fidelity: 1 invented figure in 13 Mean turns** ("THIRTY-SEVEN PERCENT" for a 43% event);
  a dedicated 8-turn pass was 8/8 clean, as was sarcastic 8/8. With the implementing agent's 1/10 that
  is **2 in 23 (8.7%) on Mean**, under the plan's own "more than 1 in 5" switch threshold, so the
  measured prompt STAYS and the safer two-line variant in `/tmp/vocal-plan.md` remains the escape
  hatch. Baseline had 0 inventions in 15 but carried no number at all in 6 of 15 turns, where the new
  prompt carried one in 12 of 15. Worth an ear: **Mean quotes the clean-rep count or the rep number,
  and quoted the depth percent in 0 of 8 turns** — it satisfies "every line carries one" with the
  cheapest number available.
- ⚠️ Not verifiable from a shell: perceived loudness, timbre, whether eleanor sounds delighted or
  matronly, and whether the client-side compressor chain sounds right. The audioOut numbers were taken
  on node-web-audio-api, not a browser. See the listening test handed back with this pass.

**2026-09-18 — two-way voice: LIVE verification of the wired uplink (no microphone involved)**

Proved the mic path end to end against the live API by generating the USER's voice with Higgs TTS and
streaming it through the real AudioIn seam. New harness: `src/coach/__tests__/liveProbe.ts` +
`liveTwoWay.test.ts` (11 scenarios, skipped unless `SPOTTER_LIVE=1`; run ONE at a time —
`SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveTwoWay -t "plays music"`). It drives the real
`createCoachSession` / `buildSessionPayload` / `TOOL_DEFS` / `createToolHandlers`, and records EVERY
frame in both directions by wrapping the `createSocket` seam — which is how it can prove a negative.

- ✅ **`higgs-tts-v3` returns 24 kHz mono PCM16 — exactly the uplink's format, no resampling.**
  Verified from the WAV `fmt ` chunk (`sampleRate 24000`, 1 channel, 16-bit), not assumed; the harness
  parses the header every run and resamples if that ever changes. `higgs-tts-3` from the docs does not
  exist on this key. The speech endpoint 429s readily, so synthesis retries and caches to /tmp.
- ✅ **SERVER VAD OWNS THE TURN, proven by a negative.** For a spoken request the client sent
  `session.update` then nothing but `input_audio_buffer.append` — zero `response.create`, zero
  `input_audio_buffer.commit` — and the server produced `speech_started +415ms`,
  `speech_stopped +3730ms`, `committed +3733ms` (ITSELF), `response.created +3734ms`.
- ✅ **`play_music` fires on 4/4 spoken requests across 4 sessions**, with `{"action":"play","track":"hype"}`
  — the model volunteers the track id — and `{"action":"stop"}` for "Stop the music, please. Turn it
  off." Then it SPEAKS: "MUSIC IS ON! HYPE TRACK PLAYING! PUSH HARD!" / "Music is off. Quiet now."
  **This happened with `personas.ts` still not teaching the tool**, so the `PROMPT_GAP` entry in
  `personas.test.ts` is a real gap in the prompt but NOT a blocker — the TOOL_DEFS description carries
  it on its own. Prompt lines would only make it more reliable.
- ✅ **Negative control passes: 3 s of room tone at RMS 0.0100 (2.5x audioIn's 0.004 floor) plus the
  silence flush = 58 append frames, and the server sent NOTHING back.** No speech_started, no response.
  VAD is not hair-trigger, so the coach will not talk over a breathing user.
- ✅ **THE GATE HOLDS AGAINST THE REAL SERVER, and this is the test nothing else covered.** With
  `isSpeaking()` behaving as it does in a room, the coach's own line was played into the microphone at
  full level while it was audible: **0 appends left the client, `mic.gated` true, server
  `speech_started` stayed at 1** — the model could not hear itself. Then the gate reopens: the next
  utterance produced a second `speech_started` and a correct `get_workout_state` answer.
- 📏 **Spoken-turn latency, n=4 in one session: p50 1059 ms** from the last real mic buffer to the first
  `response.output_audio.delta` (1053 / 1059 / 1179 / 1241). Decomposed: **p50 491 ms from the server's
  own `speech_stopped`** — statistically the same as the 596-619 ms event-pushed path — so the whole
  cost of talking instead of pushing an event is **~570 ms of VAD end-pointing**, not model latency.
  A tool-mediated turn costs a further round trip: 1065 ms measured from speech_stopped to first audio.
- 🔴 **FIXED: one `connect()` opened THREE sessions.** Found in a live transcript
  (`session.update x3` sent, `session.created x2` received, one connect). A pre-ack `error` frame — the
  voice-429, ~1 startup in 8 — makes `openHiggsSocket` close its own socket, and that close reached
  `handleClose` BEFORE the rejection reached the catch that owns the retry, with `generation` still
  matching. So `scheduleReconnect` ran IN PARALLEL with the voice retry: two tokens, two sockets, two
  live sessions against a key the API limits to one (its answer is close 1013), the loser never closed,
  and `socketTap`'s `pending`/`promote` handshake left racing two sockets — the path by which the mic
  uplink could end up appending to the socket nobody is listening on. Fix in `session.ts`: an
  `openAttempts` counter, and `handleClose` returns early (before the teardown, so the replacement's
  `pending` socket is not cleared) while the connect path still owns its sockets. Pinned by
  `src/coach/__tests__/openAttemptClose.test.ts`, which failed before the fix and includes the converse
  case (a socket that WAS live still reconnects).
- 🟡 **A turn with two tool calls draws `server_error: 400: No user input`, once per extra call.**
  "Put a song on, and tell me what my heart rate is" produced 3 calls (play_music + get_heart_rate x2),
  3 `function_call_output` + 3 `response.create`, and the server answered one of the redundant
  `response.create`s with that error. Measured impact: the coach still spoke correctly ("Music is
  pumping! Heart rate is 147 bpm, rising."), the session stayed open, and the cost is one CoachError in
  the error path. NOT fixed on purpose: `sendToolOutput` fires the mandatory `response.create` itself,
  and coalescing it to the last reply of a turn risks omitting it entirely — which is permanent,
  error-free mute, the worst failure this codebase has. Pre-existing; `play_music` just makes multi-tool
  turns likely, because users ask for two things in one sentence.
- 🟡 **The silence flush also fires MID-utterance**, whenever the mic dips below `silenceFloor` for
  >150 ms (word gaps). Measured ~11 zero-frames injected inside a 3 s utterance; no premature
  `speech_stopped` in any run, because the server's hangover (~600 ms, consistent with the earlier
  (0.51 s, 1.8 s] bound) is longer than a word gap. Harmless as measured, and invisible with a real mic
  whose room tone sits above the floor — but it is why `flushBudget` can exceed its 1800 ms nominal
  total over one long turn.
- ✅ **No regressions.** `get_heart_rate` 3/3 spoken asks, quoting the injected 141 bpm with nothing
  invented. `show_reference` **4/6** severe faults (spaced 21 s, past the handler cooldown) — inside the
  non-deterministic band of the 7/12 and 9/12 measured before, and the two misses were repeats of a
  fault already shown. **Zero [EVENT] leaks in 6 event-driven turns** (no "[EVENT]", "telemetry", "the
  camera", "the system"), and "TWENTY SIX DEGREES" quoted correctly 6/6. **SAFETY: 3/3 personas drop
  character on spoken "My shoulder is really hurting and I feel dizzy"** — "Stop the set immediately.
  Rest now. See a professional if it doesn't settle." — all on the quiet rung, which independently
  confirms the vocal workflow's SAFETY spelling fix through the MIC path.
- ⚠️ Observation for the personas owner, not a two-way defect: on a spoken turn carrying NO event
  context, Mean invents unrelated cues — "EYES ON THE BAR! FEET HIPS WIDE! KNEES OVER TOES!" is a
  squat — and repeated that same line in 3 of 4 turns, against CORE's "Never reuse your previous line".
  The event-driven turns had neither problem. Heart-rate answers also never said "estimated".
- ⚠️ **Still needs a real microphone in a real room** (a browser is the only place these live):
  whether `AudioContext({sampleRate: 24000})` is honoured for CAPTURE (if the browser gives 48 kHz the
  uplink sends the wrong rate and the model silently ignores the user — this probe's PCM is already
  24 kHz, so it bypasses exactly that path); whether VAD hears a user metres away, mid-pushup,
  breathing hard; whether real room tone sits above or below the 0.004 floor (which decides whether the
  silence flush is load-bearing or dead code); whether echo cancellation covers the moment the coach
  starts mid-buffer, which the gate cannot; whether ScriptProcessorNode at 2048 frames keeps up beside
  MediaPipe on the same main thread; and whether `musicPlayer`'s own AudioContext survives the autoplay
  policy — it is created lazily inside `play()`, NOT inside the START gesture that unlocks `audioOut`,
  and it cannot share that context because `AudioOut` does not expose one.

**2026-09-18 — pose: ankle decoupled from counting, lockout recalibrated (six real reps now count)**

The measured zero is fixed, and the two causes turned out to be independently necessary for different
things. All gates green: `tsc` 0 errors, vitest **293 passed / 13 skipped**, `npm run build` clean.
Spec test is `src/pose/__tests__/realMotionReps.test.ts`; it replays `public/clips/landmarks.json`.

- 🔴 **`upEnterDeg` 155 → 115 is the change that buys the reps, and it is the ONLY one that does.**
  Measured, in this order: baseline **0**; lockout alone **6**; ankle decoupling alone (threshold put
  back to 155 for one run) **0 again**. The six real tops are 121.7 / 122.4 / 123.6 / 126.7 / 129.0 /
  151.0 smoothed degrees, so 115 sits 6.7° below the worst — that margin is what fatigue may eat.
  Cost: the hysteresis gap drops 55° → 15°, floored now by `REP_THRESHOLDS.minHysteresisGapDeg` (12)
  and justified by the within-take noise profile (median frame step 1.4°, p99 10.4°, and the big steps
  are genuine descent velocity ~3.7°/frame, not jitter).
- 🔴 **Replaying the fixture as ONE stream scores 8, not 6.** The source is an edited video; two of the
  four scene cuts splice a lockout straight into the bottom band and manufacture a rep out of the edit.
  The spec test replays per recorded segment (fresh machine + fresh median window per take, i.e. exactly
  a stopped-and-restarted camera) and gets 6 with the extraction's own depths to 2 dp
  (97.23/96.03/40.14/39.69/10.73/19.54 → 78.5/80/100/100/100/100 %). The 8 is asserted too so the
  difference stays visible instead of being mistaken for motion.
- 🔴 **`no_lockout` was DEAD CODE and nobody could have noticed.** With `lockoutDeg` 150 below the old
  `upEnterDeg` 155, every rep that completed had locked out by definition. New
  `validateFaultThresholds()` throws at module load on that relation — and it fired the moment I put 155
  back for the measurement above, which is how the dead code proved itself.
- 🟡 **`no_lockout` needed its own severity bands** (`lockoutBands` major@20 severe@45). It is scored on
  degrees short of 150, and real tops are 0–28 short, so on the DEFAULT bands (major@6 severe@14) every
  rep of a normal human set is SEVERE — which pre-empts the utterance bucket, adds vocal emphasis and
  pulls a reference clip. The flag would have drowned out the faults the coach can actually see.
- 🟡 **Ankle decoupling buys HONESTY, not reps.** `measureAngles` now needs only shoulder+elbow+wrist;
  `PoseAngles.bodyLine` / `hipDeviation` and `RepMetrics.hipDeviationDeg` are nullable. Before, the
  extrapolated off-frame ankle invented a **69.5° "pike"** on this footage, while the 45 frames whose
  ankle is genuinely visible span **−11.95 to −4.13°**. `clean` now means "no fault DETECTED" and
  `toEventLine` prints `body line not visible — no hip judgement`, so the coach cannot praise a back it
  never saw. Same gate applied to `neck` (anchored at the hip) for the same reason.
- 🟡 **A null body line would have collapsed to 0° of sag** (`Math.max(acc.worstSag, null)` === 0 ===
  "perfectly straight"). `RepAccumulator` now tracks `bodyLineFrames` explicitly. Pinned by
  `src/pose/__tests__/bodyLine.test.ts`, including a rep that is half measurable and must keep the
  measured extreme rather than average it away.
- 🟡 New `form_unobservable` / `form_observable` events + `src/pose/observability.ts` (pure reducer):
  "I can count but I cannot see your hips — back up." Debounced 15 frames / 20 s repeat AND routed
  through the fault gate's bucket. It has to claim `minor` rank, not `routine`: rep callouts sit at
  routine and fire ~1/s, so at routine the nag was starved to ZERO utterances over a whole footless set.
  On the real footage it speaks 3 times across 578 frames.
- ⏳ **Handed back, not done (coach/UI are owned elsewhere):** `App.tsx` ignores the two new event kinds
  (the coach speaks them, nothing shows on screen); `personas.ts` should teach the coach that
  `body line not visible` means "do not comment on the back"; `get_workout_state` could surface the new
  optional `WorkoutState.bodyLineObservable`, which the engine already sets. Also note
  `WorkoutState.inFrame` now means "countable" — cropped feet no longer light the OUT OF FRAME chip.

**2026-09-18 — pose: end-to-end verification of the ankle/lockout fix (4 further defects found and fixed)**

Gates: `tsc --noEmit` 0 errors, vitest **307 passed / 13 skipped** (was 293/13 after the fix pass,
238 before it), `npm run build` clean. The six reps replay exactly as claimed — per-take frame ranges
42-78 / 188-223 / 266-316 / 410-461 / 502-549 / 562-609, minElbow 97.23/96.03/40.14/39.69/10.73/19.54,
depth 78.5/80/100/100/100/100 %, body line unmeasurable on all six, `hipDeviationDeg` null on all six,
zero `sagging_hips` and zero `piked_hips` anywhere in the clip. Spliced-as-one-stream still scores 8.

Four NEW defects, all the same failure mode the ankle pass was about — a number stated about a body
part the camera cannot see — and all four verified to fail against the pre-fix code
(`src/pose/__tests__/staleAngles.test.ts`, 14 cases, 11 of which fail if any fix is reverted):

- 🔴 **`smoothedAngles` republished `neck` and `flare` FOREVER after their joints left the shot.** The
  ankle pass gated `bodyLine`/`hipDeviation` on the RAW frame for exactly this reason and did not apply
  the same gate to the other two, which read straight off their median windows — and a window that
  still holds samples returns a median indefinitely. Measured: ear occluded from frame 10 of 80, and on
  a craned-neck pose `craned_neck` was proposed on **70 frames out of 70 after the ear was gone**. Fixed
  in `smoothing.ts`; every nullable angle is now gated on the raw frame.
- 🔴 **`elbowFlare` measured against an INVISIBLE hip.** Its documented fall-back ("neither arm clears
  the gate, fall back to a single side") resolved the side through `pickSide`, which scores on a MEAN —
  so a zero-visibility hip beside a tracked elbow and shoulder still produced a "measurement". Measured:
  hip at visibility 0 returned the identical **81.41 degrees** as with the hip visible, and
  `evaluateFaults` in the FRONT view rated that `flared_elbows SEVERE`. The 68-degree phantom pike, one
  limb over, and the front view is where it bites (torso between camera and hips). Fall-back removed;
  `MEASURABILITY.flare` added so the gate and the measurement cannot drift.
- 🔴 **`no_lockout` quoted a number the user was never at.** `phase` stays `top` all the way down to
  `downEnterDeg`, so the descent spends ~50 degrees inside the lockout band and the gate reported
  whichever descent frame happened to satisfy its persistence window. Measured on take 3: a **127-degree
  top announced as `no_lockout 102deg SEVERE`** — and `FAULT_THRESHOLDS.lockoutBands` was added in the
  previous pass explicitly to reserve SEVERE for "a bent-arm hover, not a soft lockout", so the code
  contradicted its own stated contract. Now scored on `FaultContext.topElbow` (= `topMaxElbow`, the best
  elbow of the current top phase): reads **`no_lockout 127deg MAJOR`**, which is true. Side benefit: a
  descent from a genuine full lockout now proposes nothing at all.
- 🟡 **`form_unobservable` rendered "cannot see ankle for 0s"** — a sentence that denies itself, handed
  to a model that quotes these lines back. The debounce is by FRAME COUNT (`lostFrames` 15), so the first
  mention always carried ~467ms (measured 466.6/466.6/466.7 on the three real utterances). Fixed with
  `EVENT_LINE.minReportedSec`, recorded as amendment 3 in the frozen contract.

**LIVE COACH, verified against the real replayed reps** (14 event lines from the real pipeline, one
session per persona, pauses between). Mean quoted every number correctly — 78%/80%/100% depth,
`97 DEGREES`, `96 DEGREES`, `133`/`112` craned, **`127 DEGREES! MAJOR NO LOCKOUT!`** (pre-fix it would
have shouted `102 DEGREES! SEVERE!`), "TWO/THREE CLEAN REPS" — spoke on 14/14 turns, and leaked no
`[EVENT]`, `hip_sag`, `hip_pike` or fault-slug text. Sarcastic said **"Body line hidden"** on every rep,
which is the ideal behaviour. **Zero invented hip angles across both personas.**

- ⏳ **For the personas owner (src/coach, not mine):** Mean answers a rep whose body line was never seen
  with **"100% DEPTH! CLEAN REP! KEEP THAT LINE STRAIGHT!"** on 4 of 4 clean reps. No hip angle is
  invented and nothing false is asserted, but "CLEAN REP" + an instruction about the line reads to a
  listener as verified form. Sarcastic's "Body line hidden" is the model to copy. This is the concrete
  evidence for the already-handed-back ask: teach the prompt that `body line not visible — no hip
  judgement` means do not comment on the back at all.
- 🟡 **Measured, NOT fixed — `craned_neck SEVERE` on the real footage is fired outside the pushup.** The
  smoothed neck angle is cleanly bimodal: median 172.4 deg (neutral, correct), with 54 of 578 frames at
  or below the 150 threshold and 49 of those in SEVERE territory. It does not track depth (median 172.2
  both at the bottom of a deep rep and near lockout), and the ear is at 0.995 visibility on exactly those
  frames — so these are real body configurations, not glitches. They sit in three runs: **337-338 and
  381-385 (both straddling scene cuts) and 630-676 (47 frames AFTER the last rep ends at 610)**. i.e. the
  engine judges neck posture while the user has finished the set and is getting off the floor. Real
  demo-day risk ("NECK CRANED, SEVERE" at someone sitting up), but fixing it needs a notion of "currently
  in a plank" that does not exist yet — a calibration/design decision, not something to invent from one
  clip.
- 🟡 `REP_THRESHOLDS.cleanHipDeviationDeg` (10) sits below `FAULT_THRESHOLDS.sagDeg` (12), so a deviation
  of 10-11 degrees makes a rep `clean: false` while no `form_fault` fires — the documented "clean means no
  fault was DETECTED" is a slight overreach in that 2-degree band. No invariant covers the pair.
- ✅ Synthetic fixtures all unchanged and still correct: cleanSet(10) → 10 reps 0 faults; saggingSet(6) →
  `sagging_hips` and NOT `piked_hips`; partialSet(3) → 3 partial; ankleLessSet(3) → 3 reps all with a null
  deviation; softTopSet(2) → 2 reps + `no_lockout`; outOfFrameSet → 4 reps. (pikingSet also emits
  `craned_neck` — a fixture artifact: raising the hip closes ear->shoulder->hip. Pre-existing.)
- ✅ The view gate is load-bearing, measured: 112 of 578 real frames would fire `flared_elbows` if the view
  were `front`; all correctly suppressed in the side view, as `FAULT_VIEW_RELIABILITY` intends.

**2026-09-18 — coach eagerness: verification pass + the tests and the measurement that were missing**

Picked up a partially-landed speech-policy implementation (`speechPolicy.ts`, `repCallout.ts`,
`speechTuning.ts`, all untracked) and finished it. Gates: `tsc --noEmit` **0 errors**, vitest
**405 passed / 13 skipped**, `npm run build` clean.

- 🔴 **The handover claim "gates are GREEN, tsc clean, 292 passed" was FALSE on both counts.**
  `tsc` failed — `noteUserTurn` was imported into `session.ts` and never called — and
  `vocalControl.test.ts` had one failing case. Both fixed.
- 🔴 **`noteUserTurn` being dead was a real gap, not just a lint error.** A TYPED user turn
  never claimed the utterance bucket, so `lastUtteranceAt` still held whatever spoke before and
  the next rep — routine, arriving inside 2.5s — could push straight into the coach's ANSWER and
  trample it. The spoken path gets this from `noteUserSpeech` on the server's VAD
  `speech_stopped`; a typed turn has no VAD edge, so `sendUserText` now records it explicitly.
- 🟡 `vocalControl.test.ts` asserted 4 events → 4 push pairs. The policy correctly suppresses the
  `minor` fault (same millisecond as the rep callout, and `preemptMinRank` is `major`). Rewritten
  to assert its actual stated intent — no `session.update` on the wire, well-formed
  create/response pairs — plus the now-expected count of 3, so a regression back to
  narrate-everything cannot pass it silently.
- ✅ **New tests: `speechPolicy.test.ts` (39) + `repCadence.test.ts` (6).** The second one exists
  because every pure-reducer test can pass while `session.ts` drops the returned state, and a
  policy whose state is not threaded is exactly as eager as no policy. It drives the real
  `createCoachSession` with an injected clock and a fake `audioOut` that DRAINS against it.

**MEASURED — and one measurement changed the tuning advice.**

Live: six real rep-callout lines (the exact strings `repCalloutLine` builds) through Mean's real
prompt and voice returned **4.89 / 5.75 / 6.39 / 5.14 / 5.46 / 5.68 s** of 24 kHz PCM16 —
**mean 5.55 s**, n=6, 0 errors. Untrimmed on purpose: `audioOut.isSpeaking()` is
`queuedSec() > 0`, so an utterance's padding silence holds the mic gate shut exactly as its
speech does. This is ~2x the 3.0 s the harness first assumed, and the repo's earlier 2.26-4.62 s
figures are *trimmed*, which is the wrong measure for a gate question.

Simulated 20-rep set, one rep every 2.5 s (50 s of reps), shipped tuning:

| | utterances | per min of set | audio | % wall-clock speaking |
|---|---|---|---|---|
| BEFORE (every rep pushed) | 20 | 24.0 | 111.0 s | **97.8 %** |
| AFTER (shipped) | 5 | 6.0 | 27.5 s | **55.0 %** |
| BEFORE + minor fault/rep | 40 | 48.0 | 221.9 s | 98.9 % |
| AFTER + minor fault/rep | 5 | 6.0 | 27.5 s | 55.0 % |

Mic-gate-open time goes **2.2 % → 45.0 % of the set (~20x)**. The before arm also *overruns*:
111 s of audio demanded by a 50 s set means the coach is still working the backlog **63.5 s after
the last rep**. The after arm ends exactly when the reps do.

- 🔴 **`repCadence` is NOT the knob with leverage, and this contradicts its own doc comment.**
  Sweeps at the measured 5.55 s: `repCadence` 3→5→4→4→3 utterances for 3/4/5/6/8, i.e. **raising
  it from 3 to 4 changes nothing** — 5.55 s of audio plus 3500 ms of window is already ~3.6 reps
  of enforced quiet, so the window binds first. `listenWindowMs` 0/1500/3500/5000/6500 →
  5/5/5/4/4 on a clean set and **7/7/5/4/4 with a minor fault on every rep**. So: `repCadence`
  sets the floor on a clean set, `listenWindowMs` sets the ceiling once faults compete. Both
  sweep tables are now recorded in `speechTuning.ts`'s header, and the two knob comments point at
  the finding, so tuning by ear starts from the knob that moves.
- ⚠️ **55 % still speaking is the honest number, and it is a judgement call I did not make.**
  Five utterances is right for a 20-rep set; each being 5.55 s is what costs the duty cycle.
  Shipped default left at `repCadence: 4` / `listenWindowMs: 3500`; `listenWindowMs: 5000` buys
  44 % and is one character. Shortening the utterance itself is a PERSONAS change (word cap), not
  a tuning change, and personas is owned elsewhere.
- 🟡 **Not mine, flagged:** `server/__tests__/verdictText.test.mjs` failed once mid-pass
  (`spellDuration(89.6)`) and passes in isolation — another agent is editing untracked `server/*.mjs`
  concurrently. Untouched.

**2026-09-18 — POST /api/verdict: the personalised avatar verdict render (server side)**

The ending screen's stage-2 payoff now has a route. `POST /api/verdict` takes STATS (never text),
templates the spoken line server-side, renders a talking-head mp4 and streams it back. Gates green:
`tsc` 0 errors, vitest **430 passed / 13 skipped** (+78 new in `server/__tests__/`), build clean.
Files: `server/index.mjs` (route), `server/verdictRender.mjs` (new), `scripts/verdict-cli.mjs` (new),
plus the pre-existing untracked `verdictText/verdictCache/numberWords/avatarPersonas.mjs`.

- 🔴 **RENDER IS 22-31 s, NOT the 12 s this repo measured.** Measured five live renders:
  **22.4 / 22.5 / 26.6 / 30.6 / 30.7 s** wall clock, 890 KB - 1.29 MB, 640x640 h264 + 24 kHz aac,
  10-14 polls at 2 s. The 12 s figure was for the SHORT baked intro lines; render time tracks the
  DRIVING AUDIO, which for a ~250-260 char verdict is **18.0-22.6 s of video**. Model:
  `render ≈ audio duration + 9 s`. Voice pace matters more than character count — oliver (slowest
  preset) turns 245 chars into 21.8 s while jake turns 261 chars into 18.0 s. **The UI must expect
  ~30 s, not 12.** The single lever is `VERDICT_LIMITS.maxSpokenChars` (300); dropping it trades
  trailing clauses for seconds, and the clause priority means the important ones survive.
- 🔴 **Fixed a 401 that read exactly like a revoked key.** `readApiKey()` returns `{key, source}`
  and the route passed the WRAPPER to the renderer, so the upstream got
  `Authorization: Bearer [object Object]` and answered `invalid_api_key`. The key was fine
  (`/v1/models` and `/v1/realtime/client_secrets` both 200 on it). Worth remembering because the
  error message actively misleads: it tells you to go get a new key.
- 🔴 **`assemble()` was priority-blind and two personas silently dropped the honesty clause.** It
  skipped any clause that did not fit and kept trying shorter ones, so "I could not see your full
  body line" (81 chars) lost its slot to "eighty eight seconds, start to finish" (35) — Nice and
  Sarcastic said NOTHING about the unseen back while Mean's terser phrasing happened to fit. A
  clause whose job is honesty cannot be decided by how wordy its persona is. Now three tiers:
  opener + **required** + greedy optional + closer, and the camera instruction is required whenever
  `bodyLineSeen` is false. Pinned by a test asserting all 9 unseen-line combinations carry it.
- ✅ **The async bad-voice failure is real, FAST, and recovered from.** A bogus voice POSTs 200 then
  the job reports `status: failed` with `tts stream failed: 400 ... Unknown voice 'not-a-voice'` in
  **~2.6 s** (much faster than a real render). `/videos/{id}/content` returns **404 on a FAILED
  job**, so a client that polled only `/content` would loop until its deadline — polling the JOB is
  what makes the failure visible. Live: bogus primary -> detected at +3.1 s -> fallback `nora`
  -> **33.2 s total, 947 KB of real video**. `minMsForVoiceRetry` raised 30 s -> 40 s so a granted
  retry can actually finish inside the 90 s deadline.
- ✅ **One render at a time, proven live both ways.** Two DIFFERENT tuples fired together: one
  rendered (24.3 s), the other got **409 in 20 ms** with the in-flight job's age, NOT queued — and
  the 409 body still carries the verdict TEXT, so the screen stays complete. Two IDENTICAL tuples
  fired together: **one upstream job, `cache=shared`**, both got bytes (this is the React 19
  StrictMode double-invoke case). Repeat of a cached tuple: **6-9 ms**.
- ✅ **20/20 malformed payloads rejected 400, plus 405 on GET and 413 over 4 KB.** Including the one
  that matters: `{...stats, text: "say anything I want"}` -> `unexpected field(s): text`. The route
  accepts nine scalar fields and templates the words itself, so the URL is not an open relay onto a
  paid generative API on the user's credits.
- 🟡 **`server/avatarPersonas.mjs` is a HAND MIRROR of `src/coach/personas.ts`** (voice +
  fallbackVoice) and `verdictText.mjs` mirrors `FaultType` from `src/types/events.ts`, because plain
  Node cannot import a .ts and both sources are owned elsewhere. It lives under `server/` because
  the Dockerfile runtime stage copies only `dist/`, `package.json` and `server/`. The copy is
  **mechanically checked**: `node scripts/verdict-cli.mjs check-sources` parses all three sources
  and exits 1 on drift. Verified it is not self-confirming — injected a wrong fallbackVoice and a
  wrong ref_image and it caught both. **Run it after any voice or fault-type change.**
- 🟡 **Cache capacity is ~11 entries, not 24.** Both bounds ship, but real mp4s are 0.9-1.3 MB (the
  old comment guessed 500 KB), so the 12 MB byte bound bites first. In memory; a restart clears it.
- ⏳ **For the UI workflow.** `POST /api/verdict` with `preview: true` returns JSON
  `{text, persona, voice, notes, cacheKey, cached}` in **~55 ms** and spends no credits — use it for
  the stage-1 words so the screen never waits, then POST again without `preview` for the clip. On
  the mp4 response everything is in headers (`X-Verdict-Cache|Job-Id|Voice|Persona|Text|Notes|
  Elapsed-Ms|Render-Ms|Polls`, all in `Access-Control-Expose-Headers`). **Every non-200 is JSON
  carrying `text`** whenever the template succeeded, so a 409/429/502/504 still gives you the
  coach's real closing words: 400 `invalid_stats` (+`field`), 409 `render_busy` (+`inFlight`), 429
  `render_rate_limited`, 502 `render_failed`/`render_start_failed`/`render_unreachable`, 504
  `render_timeout`. `retryable` is set on the two worth retrying.
- ⚠️ Not verifiable from a shell: whether the rendered face and lip-sync look right, whether the
  outro voice reads as the SAME coach as the intro clip, and whether ~30 s of rest actually feels
  like it covers the render. Needs a human watching the four mp4s in `/tmp/spotter-verdict-*.mp4`.

**2026-09-18 — barge-in: verification pass (the feature was complete and INERT)**

Picked up client-side barge-in, which was already ~95% on disk and untracked (`bargeIn.ts` 524 lines,
`micUplink.ts` + `audioIn.ts` wired, 55 tests). All five required scenarios were covered at both the
reducer and the uplink level. Gates: `tsc` 0 errors, vitest **487 passed / 13 skipped** (+6 mine),
`npm run build` clean. I did not rebuild it; I verified it and found what the tests could not see.

- 🔴 **BARGE-IN IS DEAD IN THE SHIPPED APP, and 55 passing tests actively imply otherwise.**
  `createMicUplink` arms it only when handed a way to silence the coach —
  `bargeInArmed = tuning.enabled && typeof options.interruptCoach === 'function'` — and
  `session.ts`'s `createMicUplink({...})` call (line ~318) passes **no `interruptCoach`**. Measured
  through the real `createCoachSession`: `monitorInstalled: false`, `coachStopped: 0`, `appends: 0`,
  coach still speaking after a full second of 0.5-RMS speech over it. `audioIn` never even receives
  an `onBuffer` monitor, so the gated levels barge-in runs on are never measured. Every existing
  test supplies its own hook and therefore cannot see this. **Fix is one line, verified sufficient:**
  `interruptCoach: () => interrupt('user barged in', true),`. `force: true` is required — unforced,
  `interrupt` returns early unless `isResponding()` or the queue is past `bargeInBacklogSec`, and
  barge-in's whole case is audio already queued LOCALLY, when both can be false. Applied it
  temporarily: all 6 of my new cases pass with the flag flipped, so the detector, hysteresis, floor
  tracker, pre-roll and gate are all correct and the wiring is the only thing missing.
  **NOT fixed here — `session.ts` is owned elsewhere.** Pinned instead by
  `src/coach/__tests__/bargeInWiring.test.ts`, same convention as `personas.test.ts`'s `PROMPT_GAP`:
  flip `armsBargeInInTheRealSession` to `true` in the commit that adds the option. Verified the pin
  is not self-confirming — with the fix applied, 3 of its cases fail on purpose.
- 🟡 **`session.ts` also passes no `now` to the uplink**, so it runs on `options.now ?? Date.now()`
  while the session runs on `performance.now()`. Two costs. (a) **An injected clock cannot reach the
  detector**: hysteresis accumulates from the uplink's own `now()`, so a fake clock gives `dt === 0`
  every buffer and barge-in never fires *however it is wired* — which is exactly how my first draft
  of the pinning test "passed" against a session I had correctly fixed. Hence that file uses real
  `sleep`s. (b) It **mixes clock domains**, the same class of bug that already cost this repo the
  heart-rate defect; barge-in's windows are all internal to the uplink so it does work in a browser,
  but `Date.now()` is not monotonic and an NTP/DST step mid-set would corrupt the hold and
  refractory windows. Fix alongside the above: `now: () => performance.now()`. Pinned by the last
  case in the same file; delete that case when it lands.
- ✅ **The tests are load-bearing, not self-confirming — proved by 8 mutations**, each reverted:
  killing the hysteresis hold (4 fail), making the trigger absolute instead of floor-relative (4),
  removing the echo guard (2), ignoring the master switch (1), dropping the pre-roll replay (1),
  removing `audioIn`'s gate RE-CONSULT so the triggering buffer is lost (1), breaking the measured
  silence flush (3), and never holding the gate open after a trigger (5).
- ✅ **Nothing existing regressed, and audioOut.ts was never touched** (not in `git status`), so
  gapless 24 kHz playback, `isSpeaking()` and the `level()` the rim light reads are intact by
  construction. `stop()` confirmed to satisfy "clear pending queued audio": it fades over
  `fadeOutMs`, stops every active source, `active.clear()`, and resets the playhead.
- ⚠️ **Real-room AEC is unverifiable from a shell** and is the load-bearing assumption of the whole
  feature — `echoCancellation: true` is requested, and if the browser honours it poorly the module
  measures the coach's own leaked voice and interrupts ITSELF. That is why `echoGuardMs: 700` /
  `echoGuardFactor: 2.5` and `enabled` exist. The diagnostic to watch is
  `mic.bargeIn().earlySuppressions` (also logged as `suspected echo` lines): a few are healthy, a
  steady stream means AEC is not holding and `BARGE_IN_TUNING.enabled = false` is the right call.
