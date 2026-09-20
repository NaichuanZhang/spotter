# Task: spotter-fitness-coach

Resume this task's session (run from inside this folder):

```
claude --resume 536d8139-2b8c-4a3b-b7c2-400e0c5d91ae
```

- **Session ID:** `536d8139-2b8c-4a3b-b7c2-400e0c5d91ae`
- **Created:** 2026-09-18 12:35
- **Status:** active
- **Gates, last verified 2026-09-20:** `tsc --noEmit` 0 errors · vitest **566 passed / 19 skipped** ·
  `npm run build` clean · `node scripts/render-refs.mjs --verify-only` exit 0 ·
  `node scripts/verdict-cli.mjs check-sources` exit 0

> Session transcripts are keyed by directory. If this folder is ever moved or
> renamed, the resume command stops finding the session — see the root
> CLAUDE.md "Moving or renaming a task" note before doing either.

> **The hackathon is over and the user is still building on this.** They have said a full refactor is
> coming later and explicitly asked that it **not be planned now**. Do not restructure, rename
> subsystems, introduce abstractions or "improve" the architecture unless asked. Describe what exists.

## Goal

SPOTTER: AI fitness coach with 3 personas (mean/nice/sarcastic) that watches pushups via webcam
(MediaPipe) and reacts in character via Boson Higgs realtime voice. Browser-direct WebSocket,
InstaCloud hosts the API routes + static assets. Baked avatar intro videos, rendered end-of-set verdict.

## Key paths

- Task folder: `/Users/zhangnai/cworkspace/tasks/spotter-fitness-coach`
- **Original plan:** `~/.claude/plans/hackathon-plan-session-tech-crystalline-shannon.md`
- **Contract (frozen, has an amendment log at the top of each file):** `src/types/events.ts`,
  `src/types/tools.ts`
- Tunables, each the single source of truth for its area: `src/pose/repMachine.ts` `REP_THRESHOLDS`,
  `src/pose/faults.ts` `FAULT_THRESHOLDS`, `src/coach/speechTuning.ts` `SPEECH_TUNING`,
  `src/coach/bargeIn.ts` `BARGE_IN_TUNING`, `src/coach/musicPlayer.ts` `MUSIC_CONFIG`,
  `server/verdictText.mjs` `VERDICT_LIMITS`
- Non-synthetic test fixture: `public/clips/landmarks.json`, regenerated **only** by
  `scripts/extract-landmarks.mjs` (which is also the only documentation of its schema)

## Architecture in one paragraph

Browser does everything: MediaPipe PoseLandmarker measures pushup geometry, a hysteresis rep machine
and fault gate turn that into `CoachEvent`s, and `toEventLine()` renders each as ONE line of text
pushed to Higgs Realtime over a **browser-direct WebSocket** as a synthetic user turn. The model has
no vision — it supplies character, not measurement. Tool calls come back and run *in the browser*, so
`show_reference` updates the UI by direct function call. The mic is a real uplink in the other
direction, gated so the coach cannot hear itself. Plain Node holds `BOSON_API_KEY` and serves two
routes (`POST /api/session` mints an ephemeral token, `POST /api/verdict` renders the end-of-set
avatar clip) plus static files. No Pipecat, no Python.

## Current state

Everything below is implemented, wired and gated green.

| Area | State |
|---|---|
| Pose | MediaPipe `pose_landmarker_full`, GPU delegate, 30 fps. Rep machine 100° down / **115° up**. Six real reps from the landmark fixture count, per recorded take. |
| Faults | sag · pike · partial depth · no lockout · craned neck · flared elbows · out of frame. Persistence → per-fault cooldown → token bucket, severity pre-empts. A view gate suppresses front-only faults in a side view. |
| Observability | Every nullable angle is gated on the RAW frame, so an angle whose joint left the shot is withheld, not republished from a stale median. `hipDeviationDeg` is `null` when the ankle is invisible; `form_unobservable` / `form_observable` events say so out loud. `clean` means "no fault DETECTED". |
| Coach | Three personas, hot-swap via `session.update` with no reconnect, streamed 24 kHz PCM out, transcript deltas → captions, 4-minute keepalive, reconnect with backoff. |
| Speech policy | `repCallout.ts` picks which reps are worth speaking about (rhythm + notable), `speechPolicy.ts` owns the utterance bucket and pre-emption. The backlog DECAYS, it does not queue. |
| Two-way voice | Mic uplink appends 24 kHz PCM16 and never commits — server VAD owns the turn. Half-duplex gate asks `audioOut.isSpeaking()` per buffer. Barge-in is **armed** in `session.ts` (`interruptCoach` + `now`), with a floor-relative trigger, hysteresis hold and echo guard. Bounded silence flush after the mic falls quiet. |
| Tools | Five: `show_reference`, `set_persona`, `get_workout_state`, `log_set`, `play_music`. `TOOL_DEFS` is the only source of truth and `personas.test.ts` iterates it. |
| Music | One bed, ducked to `duckedGain` while the coach speaks or the mic is armed. |
| Screens | Intro (baked per-persona avatar intros, persona cards, audio unlock) → workout (HUD, skeleton overlay, captions, fault slab, reference clip inside the HUD panel) → ending (measured stats, spoken closing line, rendered avatar verdict). |
| Server | Plain Node, zero dependencies, `node:` builtins only. `POST /api/session`, `POST /api/verdict`, `GET /healthz`, static hosting of `dist/`. |

### Two subtraction passes, 2026-09-20

The mocked heart rate is **gone end to end** — tool, simulation, prompt lines, HUD row, ending-screen
stat, `SetSummary.peakBpm`, the CSS, and the `peak heart rate … estimated` clause of the spoken closing
line. Nothing modelled is left on screen or on the wire. Absence assertions now pin it: the persona
prompt carries no `/heart rate/`, `/get_heart_rate/` or `/\bbpm\b/`; `closingLine` quotes no vital sign;
and `POST /api/verdict` **rejects** `peakBpm` as an unexpected field rather than ignoring it. The
`/api/verdict` contract never carried it, so the server needed no edit.

Synthetic reps are **gated, not deleted**. `poseEngine.injectSyntheticRep` opens with
`if (!import.meta.env.DEV) return`, `useHotkeys` splits its hints so the `?` overlay never advertises F
in production, and the keydown map binds `f` to `undefined` there. Verified in the built bundle: the
keymap has no `f` entry and `injectSyntheticRep` minifies to an empty function. The capability survives
because headless Chromium has no camera and it is that test's only route past one — see the block
comment above `SYNTHETIC_REP` in `repMachine.ts`, which says **do not "finish the job"**.

## Verified against the live API

Every load-bearing claim here was measured, not read from docs.

| Thing | Result |
|---|---|
| Browser-direct WS, subprotocol `bai-client-secret.<eph>` | works, no auth header |
| Pose event → first audio | **596 / 619 ms** |
| Spoken turn → first audio, n=4 one session | **p50 1059 ms** (1053/1059/1179/1241); **491 ms from the server's own `speech_stopped`**, so ~570 ms of that is VAD end-pointing, not model latency. A tool-mediated turn costs 1065 ms from `speech_stopped`. |
| `show_reference` from a pushed fault event | 7/12, 9/12, 4/6 across sessions — non-deterministic, real |
| `play_music` from a spoken request | **4/4 across 4 sessions**, model volunteers the track id |
| Persona hot-swap via `session.update` | works mid-session, no reconnect |
| Avatar **intro** render (short line) | **12 s** → 4.57 s clip, 640×640, 363 KB |
| Avatar **verdict** render (~250 char line) | **22.4 / 22.5 / 26.6 / 30.6 / 30.7 s** → 890 KB - 1.29 MB, 10-14 polls at 2 s |
| `higgs-tts-v3` output format | **24 kHz mono PCM16** — the uplink's native format, no resampling. Read from the WAV `fmt ` chunk every run. |
| Negative control: 3 s room tone at RMS 0.0100 | 58 append frames, server sent **nothing** back. VAD is not hair-trigger. |
| Half-duplex gate vs the real server | the coach's own line played into the mic at full level while audible → **0 appends left the client**, server `speech_started` stayed at 1 |
| TTS-3 tags `<\|style:shouting\|>` | parsed and consumed, not read aloud |

**RENDER TIME TRACKS THE DRIVING AUDIO, NOT THE CHARACTER COUNT:** `render ≈ audio duration + 9 s`, and
a 250-260 char verdict is 18.0-22.6 s of speech. Voice pace matters more than length — oliver turns 245
chars into 21.8 s while jake turns 261 into 18.0 s. The 12 s figure above is the SHORT intro line only;
**the verdict UI must expect ~30 s.** The single lever is `VERDICT_LIMITS.maxSpokenChars` (300).

Model ids on this key: `higgs-realtime`, `higgs-realtime-tts`, `higgs-stt-3.1`, **`higgs-tts-v3`**,
`higgs-tts-mps`. `higgs-avatar` is NOT in `/v1/models` but `/v1/videos` works anyway. `higgs-tts-3`
from the docs does not exist on this key. The speech endpoint 429s readily.

### Vocal stack, measured

- 🔴 **`audio.output.temperature: 0` is OFF deliberately** (`HIGGS.useOutputTemperature`). It really
  does make the decode reproducible (8/9 byte-identical, replicated) and it really does degenerate:
  **7 of 22 live turns returned 72-142 s of PCM for a 2-4 second line**, once 75.7 s of speech-active
  babble at RMS 0.286. All three personas. Field omitted: **0 runaways in 96 turns**, max 8.5 s. Audio
  and text share one decode, so it was inflating length too.
- 🔴 **A speed-only `session.update` does NOT skip the voices lookup.** 20 consecutive speed-only
  patches: **8/20 errors at a 300 ms gap, 0/20 at 2500 ms**, every one `Could not validate voice
  'jake': voices API returned HTTP 429` on a frame carrying no voice. Post-ack it is non-fatal (session
  open, audio flowing, rejected patch is a no-op), so the cost is one `CoachError` per failure. Hence
  `PER_EVENT_PACE_ENABLED = false`. **There is no such thing as a lookup-free partial patch.**
- `temperature` **0.3, not 0.8** — every acoustic measurement was taken at 0.3, and at 0.8 the model
  overruns the 14-word cap.
- Voices follow measurement: mean `jake`, nice `eleanor`, sarcastic `oliver`, fallbacks
  `marcus`/`chloe`/`nora` (collision-free — sarcastic used to fall back to Mean's voice).
- **Mean is separated on every axis** vs the pre-change arm, n=4 each: RMS **+31%**, crest **−25%**
  (rising RMS with falling crest is vocal effort, not a gain change), duration −28.5%, 10 words vs 12-23.
- **The pace lever works harder than predicted.** Words pinned verbatim, speed 1.12 vs 1.25:
  **3.71 s → 2.61 s, −29.7%**, where `duration = base/speed` predicts only −10.4%.
- **`eleanor` did not reproduce a loudness gain** vs `nora`: RMS +1.2% (overlapping), crest +31% (wrong
  direction), peak **1.000 on all four runs**. Defensible on pace grounds; judge by ear.
- **Sarcastic got no acoustic change at all** — by design, oliver's lever is `speed`.
- **SAFETY overrides the spelling, not just the words.** Mean used to SHOUT its safety line, because
  `MEAN_CHARACTER`'s "every line is loud" beat a SAFETY block that only overrode *how you sound* — and
  in this product capitalisation IS volume. Now: **6/6 turns tell the user to stop, 6/6 name a
  professional, 6/6 on the quiet rung**, Mean's safety line **35.6% quieter than its own coaching in the
  same session**, and a test pins that Mean keeps its caps for ordinary coaching so the fix cannot
  quietly cost the +31%.
- **Numeric fidelity: 2 invented figures in 23 Mean turns (8.7%)**, 0 in 8 sarcastic and 8 nice. Under
  the plan's 1-in-5 switch threshold, so the measured prompt stays.

### Speech budget, measured

One real rep-callout line through Mean's real prompt and voice: **4.89 / 5.75 / 6.39 / 5.14 / 5.46 /
5.68 s** of PCM, **mean 5.55 s**, n=6. Untrimmed on purpose — `isSpeaking()` is `queuedSec() > 0`, so an
utterance's padding silence holds the mic gate shut exactly as its speech does.

Simulated 20-rep set, one rep every 2.5 s:

| | utterances | audio | % wall-clock speaking |
|---|---|---|---|
| BEFORE (every rep pushed) | 20 | 111.0 s | **97.8 %** |
| AFTER (shipped) | 5 | 27.5 s | **55.0 %** |
| BEFORE + a minor fault per rep | 40 | 221.9 s | 98.9 % |
| AFTER + a minor fault per rep | 5 | 27.5 s | 55.0 % |

Mic-gate-open time goes **2.2 % → 45.0 % of the set (~20x)**. The before arm also overruns: 111 s of
audio for a 50 s set means the coach is still working the backlog **63.5 s after the last rep**.

🔴 **`repCadence` is NOT the knob with leverage**, which contradicts its own original doc comment.
At 5.55 s per utterance: `repCadence` 3/4/5/6/8 → 3/5/4/4/3 utterances, i.e. 3→4 changes nothing,
because 5.55 s of audio plus a 3500 ms window is already ~3.6 reps of enforced quiet.
`listenWindowMs` 0/1500/3500/5000/6500 → 5/5/5/4/4 clean and **7/7/5/4/4 with a minor fault every rep**.
So `repCadence` sets the floor on a clean set and `listenWindowMs` sets the ceiling once faults compete.
Both sweeps are recorded in `speechTuning.ts`'s header. **Tune `listenWindowMs`.**

### `POST /api/verdict`, measured

- `preview: true` returns `{text, persona, voice, notes, cacheKey, cached}` in **~55 ms** and spends no
  credits. Use it for the words, then POST again without `preview` for the clip.
- **One render at a time, proven both ways.** Two DIFFERENT tuples together: one rendered (24.3 s), the
  other got **409 in 20 ms** with the in-flight job's age, NOT queued — and the 409 body still carries
  the verdict TEXT. Two IDENTICAL tuples together: **one upstream job, `cache=shared`**, both got bytes
  (the React 19 StrictMode double-invoke case). Cached repeat: **6-9 ms**.
- **Every non-200 is JSON carrying `text`** whenever the template succeeded: 400 `invalid_stats`
  (+`field`), 409 `render_busy` (+`inFlight`), 429 `render_rate_limited`, 502
  `render_failed`/`render_start_failed`/`render_unreachable`, 504 `render_timeout`. `retryable` is set
  on the two worth retrying. On a 200 everything is in headers
  (`X-Verdict-Cache|Job-Id|Voice|Persona|Text|Notes|Elapsed-Ms|Render-Ms|Polls`, all in
  `Access-Control-Expose-Headers`).
- **20/20 malformed payloads rejected 400**, plus 405 on GET and 413 over 4 KB — including
  `{...stats, text: "say anything I want"}` → `unexpected field(s): text`. The route accepts nine named
  fields and templates the words itself, so the URL is not an open relay onto a paid generative API.
- **A bad voice fails ASYNC, fast, and recovers.** POST returns 200, then the job reports
  `status: failed` in ~2.6 s. **`/videos/{id}/content` returns 404 on a FAILED job**, so polling only
  `/content` loops until the deadline — poll the JOB. Live: bogus primary → detected at +3.1 s →
  fallback `nora` → 33.2 s total, 947 KB of real video. `minMsForVoiceRetry` is 40 s so a granted retry
  can finish inside the 90 s deadline.
- **`assemble()` is priority-tiered on purpose**: opener + **required** + greedy optional + closer. It
  used to skip any clause that did not fit, which silently cost Nice and Sarcastic the "I could not see
  your full body line" clause (81 chars) to make room for "eighty eight seconds, start to finish" (35).
  A clause whose job is honesty cannot be decided by how wordy its persona is.
- **Cache capacity is ~11 entries, not 24** — real mp4s are 0.9-1.3 MB, so the 12 MB byte bound bites
  before the count bound. In memory; a restart clears it.
- `server/avatarPersonas.mjs` is a **hand mirror** of `src/coach/personas.ts` (voice + fallbackVoice)
  and `verdictText.mjs` mirrors `FaultType` from `src/types/events.ts`, because plain Node cannot import
  a `.ts` and the Dockerfile runtime stage copies only `dist/`, `package.json` and `server/`. The copy
  is **mechanically checked**: `node scripts/verdict-cli.mjs check-sources` exits 1 on drift, and it was
  proved non-self-confirming by injecting a wrong fallbackVoice and a wrong ref_image. **Run it after
  any voice or fault-type change.**

## Gotchas that cost an hour each

**Higgs Realtime protocol**

- `response.create` is **mandatory** after `function_call_output` — omit it and the coach goes silently
  mute with no error event. This is why `sendToolOutput` fires it itself and why multi-tool turns are
  not coalesced.
- Tool `output` must be a JSON **string**, not an object.
- Every tool call is announced **twice** → dedupe on `call_id`.
- Sessions close after **5 min with no user *speech***. We push a user item per rep plus a 4-min
  keepalive. Untested whether the synthetic items reset it.
- `client_secrets` body accepts **only** `expires_after` (`additionalProperties: false`), so the session
  cannot be pre-configured server-side at all — persona prompts and tool schemas live in browser JS.
- **Server VAD closes a turn on SILENCE IN THE STREAM, not on the absence of frames**, and `audioIn`'s
  `silenceFloor` skips exactly the sub-floor buffers that carry it. A clip ending in digital silence
  produced `speech_started` and then *nothing* — no stop, no commit, no reply, no error. Hence the
  uplink's own bounded run of zeros. 510 ms was not enough; 1800 ms closes it, so the server hangover
  is in (0.51 s, 1.8 s].
- **The server sends `input_audio_buffer.committed` itself.** Append only; never commit, never
  `response.create` for speech.
- **A turn with two tool calls draws `server_error: 400: No user input`, once per extra call.** The
  coach still speaks correctly and the session stays open, so the cost is one `CoachError`. NOT fixed on
  purpose: coalescing risks omitting the mandatory `response.create`, which is permanent, error-free
  mute — the worst failure this codebase has.
- **One `connect()` could open THREE sessions.** A pre-ack `error` frame (the voice-429, ~1 startup in
  8) makes `openHiggsSocket` close its own socket, and that close reached `handleClose` BEFORE the
  rejection reached the catch that owns the retry. Fixed with an `openAttempts` counter and an early
  return in `handleClose`; pinned by `openAttemptClose.test.ts`, which includes the converse case.
- One browser tab at a time: there is an undocumented concurrency limit (close code `1013`).
- **!! CLAIM THE TRIAL CREDIT !!** A new key has zero usable balance and every call returns
  `429 insufficient_quota` until you click the banner on the Boson API Keys page. The key is valid,
  which makes it look like a rate limit.

**Server**

- 🔴 **A 401 that reads exactly like a revoked key.** `readApiKey()` returns `{key, source}`; passing
  the WRAPPER to the renderer sends `Authorization: Bearer [object Object]` and the upstream answers
  `invalid_api_key`. The message actively misleads — it tells you to go get a new key.

**MediaPipe / pose**

- `detectForVideo(video, timestamp)` — the timestamp is required in all four shipped overloads even
  though Google's official sample omits it. Omitting it yields garbage landmarks, not an error.
- Asset paths are `/vendor/pose_landmarker_full.task` and `/vendor/wasm` (the FULL model, no extra path
  segment). `scripts/fetch-mediapipe.mjs` is the side with the byte-verified artifact on disk.
- Reference clips live at `/clips/<fault>-<view>.mp4`; intros at `/avatars/<persona>-intro.mp4`.
- **Hip sag vs pike are indistinguishable** by unsigned body-line angle (measured 0.22° apart for an
  equal-magnitude pair — not identical, because the body line tilts ~7.6°, so a vertical hip offset also
  slides the hip *along* the line). The sign comes from comparing `hip.y` to the shoulder→ankle line at
  the hip's x. Easiest thing in the codebase to get backwards; three tests guard it, and they are not
  self-confirming — they run synthetic poses through the REAL `measureAngles`.
- **Threshold relations that make faults unreachable, both now enforced at module load**:
  `partialAboveDeg` must be below `downEnterDeg` (`validateRepThresholds`), and `lockoutDeg` must be
  above `upEnterDeg` (`validateFaultThresholds`) — with `lockoutDeg` 150 below the old `upEnterDeg` 155,
  every completed rep had locked out by definition and `no_lockout` was dead code. The same staleness
  reached `scripts/ref-clips.mjs`, whose `no_lockout` clip check still asserted "would never complete a
  rep" after the recalibration made that the opposite of the point.
- **`no_lockout` needs its own severity bands** (`lockoutBands` major@20 severe@45). Real tops are 0-28°
  short of 150, so on the default bands (major@6 severe@14) every rep of a normal set is SEVERE, which
  pre-empts the utterance bucket and drowns out the faults the coach can actually see.
- **`no_lockout` must be scored on `FaultContext.topElbow`, not the current frame.** `phase` stays `top`
  all the way down to `downEnterDeg`, so the descent spends ~50° inside the lockout band: a 127° top was
  being announced as `no_lockout 102deg SEVERE`.
- **A median window keeps returning a median after its joint leaves the shot.** `smoothedAngles` gates
  every nullable angle on the RAW frame for this reason; without it, `craned_neck` was proposed on 70
  frames out of 70 after the ear was gone.
- **`elbowFlare` could measure against an INVISIBLE hip** via `pickSide`'s mean-based scoring — a
  zero-visibility hip returned the identical 81.41° and rated `flared_elbows SEVERE` in the front view.
  Fall-back removed; `MEASURABILITY.flare` keeps the gate and the measurement from drifting.
- **An extrapolated off-frame ankle invents a spine.** Before `hipDeviation` was gated, the source
  footage (feet cropped, ankle visibility 0.14 median) produced a severe 68-69° "pike" that no spine can
  do, while the 45 frames with a genuinely visible ankle span −11.95 to −4.13°.
- **A null body line collapsed to 0° of sag** — `Math.max(acc.worstSag, null)` is `0`, i.e. "perfectly
  straight". `RepAccumulator` tracks `bodyLineFrames` explicitly now.
- **`form_unobservable` rendered "cannot see ankle for 0s"**, a sentence that denies itself, handed to a
  model that quotes these lines back. The debounce is by FRAME COUNT, so the first mention always
  carried ~467 ms. Fixed with `EVENT_LINE.minReportedSec` (amendment 3 in the frozen contract).
- **Replaying `landmarks.json` as ONE stream scores 8 reps, not 6.** It is an edited video; two scene
  cuts splice a lockout straight into the bottom band. The spec test replays per recorded segment
  (fresh machine + fresh median window, i.e. a stopped-and-restarted camera) and asserts both numbers
  so the difference stays visible instead of being mistaken for motion.

**Clocks**

- **Mixing `performance.now()` and `Date.now()` is this repo's recurring defect**, and neither tsc nor
  the bundler can see it because both are `number`. The pose engine stamps every `CoachEvent.at` from
  `performance.now()`. Anything that compares against those timestamps must too. It has cost a
  whole-set bug once (the since-removed heart-rate mock read a resting pulse for an entire set because
  its rep timestamps landed ~1.7e12 ms in another clock's past) and nearly cost barge-in a second.

**Testing**

- `vitest` reports `import.meta.env.DEV === true`, which is what the synthetic-rep gate rests on; a test
  in `repMachine.test.ts` pins it so a production-mode run fails loudly there rather than silently
  no-opping the engine.
- A pure-reducer test can pass while the caller drops the returned state, and a policy whose state is
  not threaded is exactly as eager as no policy. `repCadence.test.ts` exists for that reason: it drives
  the real `createCoachSession` with an injected clock and a fake `audioOut` that DRAINS against it.
- `bargeInWiring.test.ts` uses real `sleep`s on purpose. `rig()` does not inject a clock, so the
  detector's hysteresis accumulates against the wall clock; a fake clock there sees `dt === 0` every
  buffer and barge-in never fires **however it is wired**, which is how an early draft "passed" against
  correctly-fixed code.
- The live probes (`liveProbe.ts` + `liveTwoWay`, `liveUplink`, `liveRestraint`, `verdictLive`) record
  every frame in BOTH directions by wrapping the `createSocket` seam, which is how they can prove a
  negative. Run one at a time:
  `SPOTTER_LIVE=1 BOSON_API_KEY=... npx vitest run liveTwoWay -t "plays music"`.

## Known current behaviours

Facts about the code as it stands, not a work list.

- **`personas.ts` does not teach `play_music`.** `personas.test.ts` pins the gap explicitly
  (`PROMPT_GAP`) rather than hiding it. Measured impact: none blocking — the tool fired **4/4** on
  spoken requests with the prompt silent, because the `TOOL_DEFS` description carries it alone.
- **`personas.ts` does not teach the body-line rule either.** On a rep whose back was never seen, Mean
  answers "100% DEPTH! CLEAN REP! KEEP THAT LINE STRAIGHT!" — nothing false is asserted and no hip angle
  is invented, but it reads to a listener as verified form. Sarcastic's "Body line hidden" is what the
  prompt would have to produce. Measured 4 of 4 clean reps.
- **`App.tsx` ignores `form_unobservable` / `form_observable`.** The coach speaks them; nothing appears
  on screen. `WorkoutState.bodyLineObservable` is set by the engine and not surfaced by
  `get_workout_state`.
- **`craned_neck SEVERE` fires outside the pushup.** On the real fixture the smoothed neck angle is
  cleanly bimodal (median 172.4°) with 54 of 578 frames at or below the 150 threshold, 49 of them
  SEVERE, in three runs — two straddling scene cuts and one of 47 frames AFTER the last rep ends. The ear
  is at 0.995 visibility on exactly those frames, so these are real body configurations. Judging neck
  posture while someone gets off the floor needs a notion of "currently in a plank" that does not exist.
- **`REP_THRESHOLDS.cleanHipDeviationDeg` (10) sits below `FAULT_THRESHOLDS.sagDeg` (12)**, so a
  deviation of 10-11° makes a rep `clean: false` while no `form_fault` fires. No invariant covers the
  pair.
- **`upEnterDeg: 115` sits 6.7° below the worst of the six measured real reps.** That margin is what
  fatigue may eat, and the hysteresis gap is down to 15° (floored at 12 by `minHysteresisGapDeg`),
  justified by the within-take noise profile (median frame step 1.4°, p99 10.4°, and the big steps are
  genuine descent velocity, not jitter).
- 🔴 **`public/music/hype-01.mp3` is a commercial track** — ID3 reads `Farruko - Pepas`, Traktor rip
  metadata, already in history (commit `815cec6`) and wired into `musicPlayer.ts`.
- **`npm run probe:realtime` does not run.** It imports `TOOL_DEFS` from `src/types/tools.ts`, which
  imports `../coach/musicPlayer` extensionless; Node's ESM resolver cannot follow that, and
  `allowImportingTsExtensions: false` forbids the obvious one-character fix. Pre-existing and unrelated
  to the subtraction passes.
- **Nothing reads `public/clips/manifest.json` at runtime.** `REFERENCE_CLIPS` in `toolHandlers.ts` is
  the table the coach speaks from; the manifest is `render-refs.mjs`'s input. The two sets of
  descriptions are kept in step by hand.
- `.gitignore` lists `skills-lock.json`, which is nevertheless tracked. Harmless; an already-tracked
  file stays tracked.

## Not verifiable from a shell

These need a human, a real room, or real hardware. None of them has been checked.

- **Perceived sound**: whether the rendered face and lip-sync look right, whether the verdict voice
  reads as the SAME coach as the intro clip, whether eleanor sounds delighted or matronly, whether the
  client-side compressor chain sounds right, and whether ~30 s of rest actually feels like it covers the
  render. The `audioOut` numbers were taken on `node-web-audio-api`, not a browser.
- **A real microphone in a real room**: whether `AudioContext({sampleRate: 24000})` is honoured for
  CAPTURE (if the browser gives 48 kHz the uplink sends the wrong rate and the model silently ignores
  the user — the live probe's PCM is already 24 kHz, so it bypasses exactly that path); whether VAD hears
  a user metres away, mid-pushup, breathing hard; whether real room tone sits above or below the 0.004
  floor (which decides whether the silence flush is load-bearing or dead code); whether echo
  cancellation covers the moment the coach starts mid-buffer, which the gate cannot; whether
  `ScriptProcessorNode` at 2048 frames keeps up beside MediaPipe on the same main thread; and whether
  `musicPlayer`'s own `AudioContext` survives the autoplay policy — it is created lazily inside `play()`,
  not inside the START gesture that unlocks `audioOut`, and it cannot share that context because
  `AudioOut` does not expose one.
- **Real-room AEC is the load-bearing assumption of barge-in.** `echoCancellation: true` is requested;
  if the browser honours it poorly the module measures the coach's own leaked voice and interrupts
  ITSELF. That is what `echoGuardMs: 700` / `echoGuardFactor: 2.5` / `enabled` are for. The diagnostic
  is `mic.bargeIn().earlySuppressions` (also logged as `suspected echo`): a few are healthy, a steady
  stream means AEC is not holding and `BARGE_IN_TUNING.enabled = false` is the right call.
- **Pose calibration on real bodies.** BlazePose assumes a vertical, hip-centred body with the head
  visible; a pushup is horizontal. Thresholds want a calibration block on the real camera at real height
  with real bodies.
- **The ending screen has never been seen in a browser.** A production build has no F hotkey and the
  only routes into it are 20 real reps, the coach calling `log_set`, or the engine emitting `set_ended`.
  Its logic is covered by tests (`setSummary`, `closingLine`, `finishGate`, `setLedger`,
  `verdictClient`, `verdictText`, `verdictRender`) and the route was exercised live with `preview: true`
  on 2026-09-20, but the rendered mp4 has only ever been watched as a file in `/tmp`.
