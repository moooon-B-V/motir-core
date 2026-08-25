# What a stepped container supervisor actually occupies, and what the fast lane may rely on

**Status:** accepted · **Date:** 2026-08-23 · **Card:** MOTIR-3246 (under bug MOTIR-3245 — an
index supervisor starves every other job) · **Evidence pinned at:** `motir-core` `origin/main` @
`c5086b97` · **Measured with:** `scripts/experiments/inngest-sleep-concurrency.mjs`,
`inngest-cli` 1.27.0, SDK 4.5.0

**AMENDED 2026-08-23 by §6 (MOTIR-3405)**, which measures the one signal §4 left open and
**withdraws it**: the "idle tail" is a small-sample artifact, the wake hypothesis is falsified, and
what is stable is arrival burstiness. §6 is appended rather than folded into §4, and §4 is left
standing with a pointer, because the wrong reading is the one a later card would otherwise
re-derive. Measured with `scripts/experiments/inngest-fastlane-lag.mjs`.

**AMENDED AGAIN 2026-08-23 by MOTIR-3406**, which supplied the one input §3 could not read: the
account's configured capacity is **5 concurrent steps** (Hobby plan, read off the dashboard by a
person). That turns §6's saturation HYPOTHESIS into arithmetic — four consumers per event against
five slots — so §3 and §6 are both amended on the record rather than rewritten, and §4's _"the
reading that would settle it"_ is now taken.

MOTIR-3245 was filed on one sentence in `lib/jobs/definitions/codeGraphRefresh.ts`:

> _"A stepped supervision loop holds its Inngest concurrency slot for the CONTAINER'S WHOLE
> LIFE."_

Every remedy that card proposes follows from it. This record settles whether it is true, names
the pool it is a claim about, and says which of those remedies the answer admits and which it
rules out. **It fixes shapes and ships no behaviour** — per `notes.html` #50, nothing here is a
precondition a sibling card may assume is present.

---

## §1 — The answer: a sleeping run holds NOTHING, and it is measured, not cited

**A run sitting in `ctx.step.sleep` does not occupy its function's concurrency slot.**

The documentation says so, and a documentation citation is what the corpus already had — the
disagreement MOTIR-3246 exists to settle was between two comments, not between a comment and a
doc. So this is measured against a scheduler.

**Method.** One function, `concurrency: { limit: 1 }`, three events. Each run does
`enter` → hold for 8 s → `exit`. The only difference between the arms is _how_ it holds:

| arm              | how it holds                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| `sleep`          | `ctx.step.sleep('hold', 8000)` — the supervisor's shape (`index-wait:<pid>:<n>`) |
| `busy` (control) | `ctx.step.run('hold', …)` that awaits 8 s — a step demonstrably executing code   |

The **control is what makes this decisive rather than suggestive**: same limit, same event
count, same hold duration, so a difference is attributable to the wait mechanism and to nothing
else. Without it, a prompt start would equally be explained by the limit never applying.

**Result** — two trials of each, `LAB_HOLD_MS=8000`, `LAB_RUNS=3`:

| arm     | trial | when each run first executed code | spread     | verdict                           |
| ------- | ----- | --------------------------------- | ---------- | --------------------------------- |
| `busy`  | 1     | 241 ms · 8 328 ms · 16 429 ms     | 16 188 ms  | serialized — the slot IS held     |
| `busy`  | 2     | 116 ms · 8 211 ms · 16 310 ms     | 16 194 ms  | serialized — the slot IS held     |
| `sleep` | 1     | 315 ms · 465 ms · 609 ms          | **294 ms** | concurrent — the slot is NOT held |
| `sleep` | 2     | 144 ms · 288 ms · 438 ms          | **294 ms** | concurrent — the slot is NOT held |

Under `sleep`, all three runs also _finished_ within 8.16–8.63 s. Had the sleep held the slot,
the third could not have finished before ~24 s — which is exactly what the control did.

**So the sentence MOTIR-3245 was filed on is false**, and `codeGraphRefresh.ts` reason 1,
`codeGraphIndex.ts` reason 1 and `indexFleetSteps.ts`'s note now say so with this measurement
behind them rather than a doc link alone.

**⚠️ WHAT THIS MEASURES, STATED SO IT IS NOT OVER-READ.** It measures the **dev server** — the
`inngest-cli` binary CI's E2E lane boots and every self-hosted deployment runs. **Production runs
Inngest Cloud, a different implementation**, and this harness cannot reach it without writing
into production. Read the result as: _the documented semantics are what the shipped scheduler
actually does, on the implementation we can drive._ The Cloud-side evidence is separate and
weaker in kind — a correlation, recorded on MOTIR-3245 — and it points the same way (§4).

---

## §2 — What a supervisor therefore DOES occupy: ~128 sub-second steps, not 30 minutes

The slot is held only while a `step.run` executes. For one 30-minute container, counting the
steps `indexFleetSteps.ts` actually runs:

- `indexPollWaitMs` is `min(3000 · 2^(n−1), 15000)` — 3 s, 6 s, 12 s, then 15 s forever.
- Reaching 1 800 s costs 3 polls to spend the first 21 s, then ⌈1 779 / 15⌉ = **119** more.
- Plus `resolve-target`, `assert-fleet-configured`, `index-admit`, `index-boot`, `index-settle`
  and `cancel-offboarding` — six.

**≈ 128 `step.run`s over 30 minutes**, each one bounded external call. The parent's measured
2-project / ~30-minute run lands in the same place (~133) by a different route: two ~15-minute
containers of ~62 polls each.

Two consequences, and the second is the one that matters:

1. **The duty cycle is (poll duration / 15 s).** Even at a pessimistic 1.5 s per provider
   `describe`, that is ~10% of one slot. _This factor is computed, not measured — the production
   `describe` duration is not something this card read._
2. **The slot is RELEASED between polls, so the worst a queued run waits behind one supervisor
   is ONE poll's duration** — not the container's life. That is a difference of three orders of
   magnitude, and it is the whole of MOTIR-3245's mechanism.

---

## §3 — The pool: one unpartitioned ceiling of FIVE concurrent steps

**Scope — decisive, and it is a code fact.** **No job in this repo sets `concurrency` at all.**
All 24 definitions under `lib/jobs/definitions/` were checked; every occurrence of the word is a
comment or `defineJob`'s plumbing. `defineJob` supports `{ limit, key?, scope? }` with
`scope: 'fn' | 'env' | 'account'` (MOTIR-1982) and **nothing uses it**.

So there is no function-level, env-scoped or account-scoped limit that this deployment
configures. The only ceiling in play is the **account-level capacity Inngest applies to the
environment by plan**, shared by all 24 functions and partitioned by nothing.

That is worth stating plainly in both directions: the parent's picture of _one unpartitioned
pool_ is **correct**. What is false is that a supervisor sits in it for thirty minutes.

**Size — 5 CONCURRENT STEPS.** Read off the Inngest dashboard's plan page on **2026-08-23** by Yue
(MOTIR-3406), on the **Hobby** plan, for the `prodect-core` app's production environment. The row
reads verbatim:

> **Concurrency** — _Maximum number of concurrently executing steps_ — **5 concurrent steps**

It sits in the account-scoped block (its neighbour is _"Maximum number of users on the account"_),
and the dashboard exposes **no separate environment-level figure** — so account and environment are
the same ceiling here, which is what §3 above could only assert because nothing configures either.

**Why it had to be read by a person, recorded so nobody re-derives the gap.** No credential this
deployment holds can reach it. The production signing key (`INNGEST_SIGNING_KEY`, read off machine
`7817663f103648` of app `motir-core`) authenticates the events API and nothing else:

| probe                                                      | result                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /v1/events?limit=1`                                   | **200** — the key is valid                                           |
| `GET /v1/account`, `/v1/envs`, `/v1/apps`, `/v1/functions` | **404** — not part of the REST surface                               |
| `POST /gql { account { plan … } }`                         | **UNAUTHENTICATED** — the dashboard API takes a different credential |

**It was read, not inferred.** A number copied from Inngest's public pricing page would be a claim
about the plan rather than a reading of the deployment — the _"a config file is a claim about the
deployment, not a reading of it"_ mistake this corpus already records. The distinction is the whole
reason MOTIR-3406 was a card rather than a sentence.

### ⚠️ And 5 is small enough to change the answer — see §6

This paragraph previously closed by saying the capacity _"matters for total throughput and no longer
for this defect."_ **That was wrong, and it was wrong because the number was unknown when it was
written.** With the value in hand the arithmetic is immediate:

- every `work-item/transitioned` event has **four** consumers (§6, and `lib/jobs/latencyBudget.ts`);
- the account allows **five** concurrently executing steps, shared by all 24 functions;
- so **ONE status change occupies 4 of 5 slots, and TWO simultaneous transitions oversubscribe the
  entire account.**

A cascade — the thing that runs when a parent closes — emits several transitioned events at once by
construction. So the capacity is not a throughput footnote; it **is** the defect.

---

## §4 — Which of MOTIR-3245's candidate fixes survive

The parent lists four. This is the ranking the answer forces — which is the reason MOTIR-3246
exists before MOTIR-3247 rather than during it.

| candidate                                                                                                   | verdict                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lane separation** — a distinct Inngest app / environment or a dedicated concurrency scope for supervisors | **RULED OUT as a remedy for this defect.** Its entire premise is that supervisors occupy the pool the fast lane draws from. They occupy ~10% of one slot in sub-second bursts (§2). Separating the lanes moves an occupancy that is already near zero. _It may still be wanted for blast-radius reasons; that is a different card with a different argument, and it may not borrow this one's._ |
| **Event-level `priority` on the fast lane**                                                                 | **NOT ADMITTED — and not ruled out either.** Priority lets a run jump a _backlog_. No backlog has been demonstrated: the production correlation on MOTIR-3245 has the fast lane **faster** while a refresh runs (median 0.9 s, p95 4.6 s, n=100) than while none runs (median 6.5 s, p95 29.5 s, n=60). Adopting it now would be treating a queue that nothing has shown exists.                |
| **Stop being a long run** — dispatch, then `waitForEvent` on a completion signal                            | **RULED OUT as a latency remedy; still defensible on cost.** It removes ~128 step invocations per index, which is a billing and step-count argument. It cannot improve a latency the poll loop is not causing.                                                                                                                                                                                  |
| **Add a `concurrency` back to `codeGraphRefresh.ts`** — already forbidden by that file                      | **STILL FORBIDDEN, and now for a sharper reason than the file gives.** A `concurrency: N` there would bound N concurrent **polls** — a quantity with no relationship to containers in flight, and one whose duty cycle is a few percent. The old reasoning reached the right conclusion from a false premise; the conclusion is unchanged and its reason is now the true one.                   |

**What survives, and it is the parent's own last bullet:** _the interactive-latency budget should
be stated and asserted._ That is a **contract**, not a mechanism — it does not depend on which
explanation of the lag is right, which is precisely why it outlived the one that was wrong.

**⚠️ SUPERSEDED BY §6 (MOTIR-3405) — the paragraph below was measured and does not survive.** The
idle tail is a small-sample artifact (the idle arm was n=13, where p95 IS the maximum), the wake
reading is falsified outright, and the stable signal is arrival burstiness. It is kept here because
a later card reading §4 alone would re-derive exactly this, and a deleted paragraph teaches nobody
that it was checked.

**And what is left genuinely open**, named here so the next card starts from it rather than from
the falsified premise: the production tail is **worse when the system is idle** (p95 29.5 s with
no refresh running). That is the opposite shape from starvation and looks like a wake / cold-path
cost on the serve endpoint. It is **not root-caused here** — this card ships no behaviour and did
not measure it. Two readings that would settle it: whether `app/api/inngest` is being reached on a
warm machine at the time (both `motir-core` machines read `started` with
`min_machines_running = 2` at the time of writing, which _weakens_ the simple machine-cold-start
reading), and the step-level timings of a slow fast-lane run rather than its run-level ones.

---

## §5 — The rule this leaves behind

**A wait is not an occupancy, and the two are worth keeping apart by name.** `indexFleetSteps.ts`
said a sleep "costs no invocation"; `codeGraphRefresh.ts` said it holds a "concurrency slot".
Both sentences were about waiting, one in a **billing** unit and one in a **scheduling** unit, and
neither said which it meant. A whole bug's mechanism was built in the gap.

So when a comment on this substrate makes a claim about a wait, **it names the resource** —
invocation, concurrency slot, or container — and, where the claim is load-bearing, cites what
measured it.

---

## §6 — The "idle tail" is NOT a thing. Burstiness is. (MOTIR-3405, 2026-08-23)

§4 left one signal open — _"the production tail is worse when the system is idle (p95 29.5 s with no
refresh running)"_ — and named it the thing the next card should start from. It was measured.
**It does not survive its own re-measurement, and neither does the correlation MOTIR-3245 was filed
on. Both are window artifacts.**

**Method.** `scripts/experiments/inngest-fastlane-lag.mjs`, read-only against the production Inngest
REST API. For every `work-item/transitioned` event: `lag = min(run_started_at) − received_at`
(`received_at` is the scheduler's own stamp, never the client-supplied `ts`). Split by whether a
`system.code-graph-refresh` run was in flight at `received_at`.

| window   | arm                  | n   | median | p95        | max    |
| -------- | -------------------- | --- | ------ | ---------- | ------ |
| **24 h** | while a refresh runs | 63  | 0.8 s  | 18.5 s     | 19.8 s |
| **24 h** | while none runs      | 13  | 0.5 s  | **26.3 s** | 26.3 s |
| **72 h** | while a refresh runs | 382 | 1.3 s  | **29.4 s** | 93.3 s |
| **72 h** | while none runs      | 174 | 0.8 s  | 19.8 s     | 47.6 s |

**The two windows give OPPOSITE answers.** At 24 h the idle arm's tail is worse; at 72 h the
refresh arm's is. The 24 h idle arm is n=13, where p95 IS the maximum — a single observation
wearing a percentile's clothes. **So the refresh-vs-idle split is not a property of the system; it
is noise, and every claim built on it — this record's §4 included — was reading a small sample.**

### What IS stable, on both windows

**Slow events arrive in BURSTS. That is the whole signal.** Splitting on the lag instead and reading
back the quiet period each side actually had:

| window | arm         | n   | median gap before | median fan-out span |
| ------ | ----------- | --- | ----------------- | ------------------- |
| 24 h   | slow (>5 s) | 17  | **0.1 s**         | 20.2 s              |
| 24 h   | fast (≤5 s) | 58  | **52.4 s**        | 1.7 s               |
| 72 h   | slow (>5 s) | 136 | **14.1 s**        | 12.9 s              |
| 72 h   | fast (≤5 s) | 419 | **49.9 s**        | 1.7 s               |

**And the wake hypothesis §4 floated is FALSIFIED outright.** A cold-start cost predicts that the
event after a long quiet period pays it. The three longest quiet periods in the 72 h window:

```
after 19.9h idle → lag 0.3s
after 10.7h idle → lag 0.3s
after 10.4h idle → lag 0.9s
```

The longest silences produce the _fastest_ runs in the dataset, and slow events follow 3–4× SHORTER
quiet than fast ones — on both windows. Waking is not the cost.

**The fan-out span is the second half of the finding, and it is the more diagnostic one.** A slow
event's consumers do not merely start late, they take **12.9–20.2 s to finish** against **1.7 s** for
a fast event's — and that 1.7 s is identical on both windows. So this is not queue wait in front of
otherwise-normal work: the arrival burst inflates the execution too, which is what contention among
simultaneously-dispatched runs looks like and what a pure dispatch delay does not.

### What this establishes — and it is now arithmetic, not a hypothesis (amended 2026-08-23)

**This section originally read _"What this does NOT establish, said plainly"_, and named saturation of
the account-level pool as a hypothesis "consistent with every number above and not proven by any of
them". The missing input was the pool's SIZE, which §3 now carries: 5 concurrent steps.** The
amendment is recorded rather than applied silently, because the hedge was the correct thing to write
while the number was unknown and would be the wrong thing to leave standing now.

With the capacity known the chain closes in one step:

- **4** consumers per `work-item/transitioned` event · **5** concurrently executing steps for the
  whole account · so **two simultaneous transitions oversubscribe it**, and a cascade emits several at
  once by construction.

Every measured signal in this section is what that predicts, and the fit is quantitative rather than
directional:

| observation                                                           | what a 5-step ceiling predicts                        |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| 4 transitioned events within **0.24 s** → lags 18.2–19.8 s            | ~16 runs against 5 slots — 3.2× oversubscribed        |
| those events' fan-out span **20.2–23.3 s** vs 1.7 s                   | consumers cannot run concurrently; they serialize     |
| after 19.9 h / 10.7 h / 10.4 h of silence → **0.3 s / 0.3 s / 0.9 s** | pool empty, no contention                             |
| refresh-concurrent vs idle → **noise** on both windows                | a supervisor holds ~10% of one slot; a burst holds 16 |

**So the burstiness finding and the capacity are the same fact seen from two ends.** The tail does not
track idleness and does not track code-graph refreshes; it tracks how many transitions arrive at once,
because four-per-event against five is saturated by the second one.

**And it retroactively vindicates half of MOTIR-3245's instinct.** That card was right that a single
unpartitioned pool was the problem — §3 confirms nothing in this repository partitions it. What it had
wrong was the occupant: not a supervisor holding a slot for thirty minutes, but the fast lane's own
four-way fan-out holding four slots for a second, several times over.

**⚠️ One thing that has NOT been measured, and must not be read in.** The chain above is arithmetic
over a capacity and a fan-out count, corroborated by the timing data — it is not a direct observation
of Inngest rejecting or queueing a run for want of a slot. That would need a scheduler-side signal the
REST API does not expose. Read it as: _the ceiling is small enough to explain everything observed, and
nothing observed contradicts it._

### ⚠️ The instrument, because it silently lies (measured here)

**`/v1/events` caps at 51 and returns NO cursor.** `limit=100` returns 51; `metadata` carries only
`fetched_at`. Proof it is a cap and not a count, on one 24 h window: `inngest/function.finished`
returns 51 for the whole window **and** 51 for each 12 h half; `work-item/transitioned` returns 51
for the window but **34 + 39 = 73** across its halves.

**A capped read is RECENCY-BIASED — you get the newest 51 — so a measurement script run during a
busy period samples the busy period and reports it as the day.** For an idle-vs-busy comparison
that is not a rounding error; it is a bias pointing straight at the hypothesis under test. The first
pass of this very measurement made that mistake and recovered 51 of 76 events on the 24 h window.
**The window IS the pagination:** bisect any slice that returns exactly 51 and union the halves,
which is what the harness now does.
