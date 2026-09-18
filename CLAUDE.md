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
