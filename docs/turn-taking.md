# Natural turn-taking: measured findings and a recommended design

Research pass, 2026-09-21. **Nothing here is implemented** beyond one bug fix (see
[The idle clock](#the-idle-clock-a-live-bug-fixed)). This document exists because every
number in it was measured against the live Higgs Realtime API, and rediscovering them
costs real time and credits.

It answers two complaints:

1. *"The coach always says something back every time data is streamed in — it should pace
   itself like a normal person."*
2. *"We mute the mic while the coach speaks, which defeats the point of a realtime model.
   It needs to know the backend data is streaming in, not as user input."*

---

## The root cause of complaint 1

Every event was pushed as a **user message**:

```json
{"type":"conversation.item.create","item":{"type":"message","role":"user",
  "content":[{"type":"input_text","text":"[EVENT] rep 4 completed | depth 61% ..."}]}}
{"type":"response.create"}
```

The model believed *the user said those words*. From its point of view the user addressed
it ~20 times a minute, so of course it answered every time. The `[EVENT]` prefix and the
prompt rules forbidding it to read them aloud were a **workaround for a provenance lie**,
not a fix.

`conversation.item.create` and `response.create` are separate events, and SPOTTER always
sent them together.

## Silent append works, and the model reasons over it

Five items appended 1.5 s apart, depth 88 → 79 → 71 → 63 → 55%, tempo 2.1 → 3.4 s, with
**no** `response.create`. Server answered only `conversation.item.added` — `response.created = 0`,
`audio.delta = 0` across ~9.5 s. Then one bare `{"type":"response.create"}`:

> **"Slow down, you're losing depth, keep that tempo tight and hit 85% depth on the next one."**

It read the **trend** off five items it was never asked to answer. Reproduced 4×
independently. This is the mechanism the whole design rests on: the model can *watch*
every rep while *speaking* about few.

## Provenance: what the API actually accepts

| Channel | Result |
|---|---|
| `role: "user"` + `input_text` | accepted (the current lie) |
| `role: "assistant"` + `text` | accepted, real readable context, **but cannot be the tail item** |
| `role: "system"` | **rejected** — `"Invalid role: system"` |
| `function_call` / `function_call_output` | accepted |
| `item.metadata`, `item.name`, `item.executor` | accepted and **silently stripped** |
| second `input_text` content part | silently dropped |
| `item.id` | **preserved** (duplicates error), so the app can address its own items |
| `response.create.instructions` | works, but **discards the entire conversation** — a trap |
| mid-session `session.update {instructions}` | acked, but no behaviour change in 6/6 turns |

`role: "system"` is refused *after* passing schema validation, and the server's own
validator union names a `SystemItem` branch — the shape exists and is deliberately
rejected, so it will never start working by accident.

### The honest channel: orphan `function_call_output`

A `call_id` that never existed, for a tool never declared, is accepted — and satisfies the
turn requirement on its own, so it both carries telemetry and licenses a response:

```json
{"type":"conversation.item.create",
 "item":{"type":"function_call_output","call_id":"pose-7",
         "output":"[EVENT] rep 7 completed | depth 72% | 6 of 7 clean"}}
```

`output` must be a string. It is *by construction* application data rather than speech,
which is exactly what telemetry is. Adopting it lets the provenance prompt rules in
`personas.ts` be deleted rather than maintained.

### Four rules you must obey

1. **Seed with a user item first.** `"Cannot append function call item as first message"`.
   An empty conversation + `response.create` is fine, so `[EVENT] set started` as a user
   item is the natural seed — one lie at the top of a set instead of twenty a minute.
2. **Never let an assistant item be the tail** before `response.create`. `[user] + [assistant]
   + response.create` draws `"No user input"` with no audio, 2/2. This also explains the
   "400: No user input" seen on multi-tool turns.
3. **Nothing new to append means no second utterance.** You cannot ask for one more line
   without appending something.
4. **Never set `response.max_output_tokens`** — it derails the turn completely.

## The idle clock: a live bug, fixed

Two arms at the same cadence:

| Arm | Result |
|---|---|
| Silent appends only, 7 items over 270 s | **died at 300254 ms** — `{"type":"session.idle_timeout","seconds_idle":300}`, close reason `"Idle timeout: no user speech for 300s"` |
| Same cadence, model allowed to speak | **survived 409 s** with zero user speech |
| 3525 appends / 14.44 MB of audio over 301 s | **closed anyway** |

**Conversation activity does not reset the clock. A model utterance does.** Appended audio
does not help either.

Consequences, both now fixed in `session.ts`:

- `HEARTBEAT_LINE` was pushed with `{respond: false}` — a silent append, so it **could not
  do its documented job**. Latent today only because the coach speaks nearly every rep;
  fatal the moment pacing improves, because a coach that learns to stay quiet kills its
  own session mid-set.
- A comment claimed *"the server's own idle timer is reset by the audio itself"*. It is
  false, and it was load-bearing for the reasoning above it.

## The real diagnosis of complaint 1: length, not frequency

Human turns average **1680 ms**, median **1227 ms** (Levinson & Torreira 2015,
Switchboard interpausal units). 51–55% of human turn transitions happen in under 200 ms
(Heldner & Edlund 2010), and a gap under 120 ms is not perceived as a gap at all
(Heldner 2011).

SPOTTER's measured rep callout is **5550 ms — 3.3× the mean human turn.** The coach is not
merely too frequent; each turn is a monologue.

And length is steerable **per turn, from the telemetry item text alone** — no prompt change:

| condition | mean audio | mean words |
|---|---|---|
| shipped (session cap 14 words) | **5.55 s** | 14.1 |
| session cap 9 | 3.45 s | 6.8 |
| session cap 5 | 2.61 s | 5.8 |
| cap 14 + item directive *"one short line, five words maximum"* | **2.63 s** | 6.3 |
| cap 14 + item directive *"N reps went by — sum up the run in one sentence"* | **3.60 s** | 8.7 |

Overhead is ≈0.33 s/word plus ≈0.6–1.0 s at `speed: 1.12`.

**Shortening strictly dominates suppressing.** Over a 20-rep / 50 s set: the shipped
5 × 5.55 s = 27.75 s = **55% of wall clock**. But **nine** short/summary moments cost the
same 27.6 s — the user hears *more* while the coach occupies *less*, and no rep is hidden
from the model. Suppressing can only trade one against the other.

A ~300 ms backchannel is **impossible on the socket** — minimum observed turn was 2.00 s
over 16 measured turns. Cheap acknowledgement must be a local asset or a HUD cue.

## Why constant feedback is wrong on the merits

The motor-learning literature is quantified and directly applicable:

- **The guidance hypothesis** — Salmoni, Schmidt & Walter 1984, *Psychological Bulletin*
  95:355–386 ([doi](https://doi.org/10.1037/0033-2909.95.3.355)). Frequent feedback props up
  **performance** while it is present; withdraw it and the propped-up performance collapses.
  **Learning** and performance are different things. This is why "the coach talking
  constantly looks fine in the demo" is not evidence.
- **Reduced/faded frequency** — Winstein & Schmidt 1990, *JEP:LMC* 16:677–691
  ([doi](https://doi.org/10.1037/0278-7393.16.4.677)).
- **Summary feedback** — Schmidt, Young, Swinnen & Shapiro 1989, *JEP:LMC* 15:352–359
  ([doi](https://doi.org/10.1037/0278-7393.15.2.352)), summary lengths of 1 / 5 / 10 / 15 on a
  ballistic-timing task — the closest analogue to a rep counter that exists.

The shape this implies: **bandwidth** feedback (speak only when error exceeds a tolerance)
plus **summary** feedback (close out a block of reps in one line), faded as skill grows.

## Complaint 2: the mic can stay genuinely open

**Echo cancellation is a dead end, and not for the obvious reason.** Server VAD opened a
turn on the coach's own voice attenuated **54 dB** (RMS 0.000317, peak 65/32768), and STT
still transcribed it accurately at −42 dB. Meanwhile **white noise at 5.6× the coach's
full level produced zero `speech_started`.** It is a speech/non-speech classifier, not a
level gate — attenuating speech leaves it speech. `threshold: 0.99` made realistic cases
*worse* (−20 dB echo: 1 response → 3). `near_field` and `far_field` are behaviourally
identical (endpoints within 4 ms). There is no server-side echo facility and no reference
channel. **No achievable AEC spec exists.**

### The fix: `turn_detection: null`

Transmission is permanently open; the **client** owns the commit.

1. Set `turn_detection: null` in the **first** `session.update` — it is immutable
   afterwards (`400 turn_detection cannot be changed after session start`).
2. Append every mic buffer forever. Measured: 85 appends carrying the coach's own voice at
   −20 dB produced **zero server frames of any type**; 3525 appends / 14.44 MB over 301 s
   produced no error and no backpressure.
3. `input_audio_buffer.commit` + `response.create` when the **local** detector says the
   user spoke. Measured: heard verbatim, first audio **+765 ms** — *faster* than server
   VAD's p50 1059 ms, because there is no VAD hangover to pay.
4. `input_audio_buffer.clear` on every sustained-silence edge. **Not optional:**
   uncommitted audio survives into the next commit, measured as the coach's own line
   prepended to the user's words.

So `gateOpen()` becomes `() => true` and the mic is never muted again. What stays gated is
the **commit**, not transmission.

**The honest caveat:** full-duplex *transmission* is not full-duplex *conversation*. "Is
this buffer the user or my own speakers?" becomes entirely the client's problem, bounded
by browser AEC, which cannot be measured from a shell.

## Recommended design: the floor policy

Four tiers that differ in **who holds the conversational floor** — the axis the current
design has no concept of. *"Watch everything, acknowledge cheaply, speak rarely and short,
answer instantly."*

| Tier | Floor | Mechanism |
|---|---|---|
| 0 — **Watch** | nobody | every event → one `function_call_output`, no `response.create` |
| 1 — **Acknowledge** | nobody | local asset or HUD cue; the socket cannot do <2 s |
| 2 — **Speak** | coach | bare `response.create` at band exits and block closes, with a per-item length directive |
| 3 — **Answer** | user | never throttled; safety always breaks through |

Budget the floor in **seconds of occupancy**, not utterance count — that is the quantity
the user actually experiences, and it is what makes shortening and suppressing comparable.

Keep the client deterministic about *when* a moment qualifies; leave *judgement about what
is worth saying* to the model, which now has the history to judge with. The existing design
put both in the client, which is why it feels mechanical.

## Risks, ranked

1. **Grooving — the top risk, and measured.** Short turns lock into templates. At a 5-word
   cap, `"STOP THE SLACK!"` appeared in 3/5 turns. The groove was strong enough to override
   a `session.update` persona swap *and* a session-instructions directive. A coach with four
   stock barks is **worse than today's verbose one**. Alternating short/summary held 6/6 as
   mitigation.
2. **Summary smear.** Told "4 reps went by", the model said *"SEVEN REPS, DEPTH DROPPING
   FROM SEVENTY NINE TO SEVENTY ONE"* — the depth range exactly right, the count wrong (it
   used the rep index). Keep the aggregate in the client; leave the model only the phrasing.
3. **Unbounded context.** Every rep becomes an item and none are ever answered. **Unmeasured:**
   latency drift, cost, and whether the model quotes stale reps past ~100 items.
   `item.id` is preserved so `conversation.item.delete` should let old telemetry retire —
   also unmeasured here.
4. **Idle death becomes load-bearing** — fixed above, but get the idle-fill wrong and the
   product dies during a rest period.
5. **Echo commit.** If the local detector is wrong while the coach is audible, the failure
   is not confusion but a stable self-conversation.

## The kill experiment — RUN, and its result

Harness: `/tmp/groove/probe.mjs` (throwaway). One session, the **real shipped Mean prompt**
extracted from `personas.ts`, 20 rep events appended as orphan `function_call_output` items
with no `response.create`, speaking only at band exits (crossing the 70% depth line) and
block closes (every 5th rep), alternating a SHORT and a SUMMARY directive carried on its own
telemetry item.

### The shipped payload already has this right — verify before changing it

The harness was first run with `audio.output.temperature: 0` added. That was **my error**:
`HIGGS.useOutputTemperature` is already `false` in `higgsSocket.ts`, because an earlier pass
measured that greedy decoding *degenerates* — 28% of 18 turns ran away, including 141.9 s of
PCM and one 75.7 s stretch of loud speech-active babble.

The results across four configurations, all on the real shipped Mean prompt:

| `audio.output.temperature` | distinct openings | floor | verdict |
|---|---|---|---|
| `0` (greedy — **not shipped**) | 6/8, three **byte-identical** (49 deltas, 2.39 s, thrice) | 26.0 s | **FAIL** |
| `0.6` | 8/8, zero repeats | 22.4 s | PASS |
| `1.0` | 7/8 | 21.7 s | PASS |
| **omitted — the shipped payload** | **7/8** | **22.2 s** | **PASS** |

So the grooving failure was an artifact of a setting the app does not use. **Omit the field**,
as shipped; do not "improve" it to a number.

Two things worth keeping from the detour. First, greedy decoding collapses short turns onto
templates as well as running away — at `0`, `"PARTIAL! DEPTH! AGAIN!"` came back three times
identically and every summary was `"N REPS! SLOWING DOWN! SPEED IT UP!"`. Short turns have
fewer degrees of freedom, so they are *more* sensitive to determinism than long ones, and any
future push toward repeatable delivery has to be weighed against that. Second, the earlier
research's recommendation of `temperature: 0` was about delivery consistency and was already
overturned in the code by measurement — the code comment was right and the research summary
was stale. **Read the constant before trusting a document about it.**

### The floor thesis held

| | speaking moments | floor occupancy |
|---|---|---|
| shipped today | 5 | 27.75 s (55% of a 50 s set) |
| this design @ temp 0.6 | **8** | **22.4 s** |

60% more coaching moments for 19% less airtime, with every rep visible to the model. That is
the shortening-dominates-suppressing claim, confirmed end to end rather than by arithmetic.

### Two defects the run exposed

1. **Digits are spoken as separate words.** The event line says `depth 96%` and the coach
   said `"NICE! NINE SIX!"` and `"NICE! NINE-FOURTEEN!"`. The repo already solved this on the
   verdict path (`server/numberWords.mjs`); realtime event lines need the same treatment
   before they reach the model.
2. **Summary smear is real and immediate.** At `temperature: 0`, rep **1** was announced as
   `"REPS NINE! CLEAN! ELEVEN MORE! GO!"`. Predicted in the risks above; observed on the very
   first utterance. Keep the aggregate in the client and leave the model only the phrasing.

### Methodology note, because it nearly produced a wrong answer

The first run reported two turns at **73.57 s and 74.5 s** of audio, and I first called it a
measurement bug. It was not — those are the *known runaway generations* that greedy decoding
produces, already documented in `higgsSocket.ts` with near-identical figures (72.6 / 141.9 /
71.7 / 73.8 / 77.2 s). I had introduced the cause myself by setting a field the app omits.

Both of my readings were wrong in sequence, which is the lesson: the headline would have read
"165.8 s of floor occupancy" and the design would have been rejected on a number produced by a
misconfiguration, then the misconfiguration would have been excused as a logging artifact.
Counting deltas per turn alongside wall-clock is what made it legible — real turns are 35–78
deltas and 674–1127 ms. Log raw counts, not just derived seconds.

The grooving verdict is also **unstable at n=1** — two runs at the same settings gave 7/8 and
6/8 with *different* stock phrases. Treat a single run as a smoke test, not a result.
