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
- Reference clips still need shooting on a phone (~15 min, human task).
