# What a stepped container supervisor actually occupies, and what the fast lane may rely on

**Status:** accepted · **Date:** 2026-08-23 · **Card:** MOTIR-3246 (under bug MOTIR-3245 — an
index supervisor starves every other job) · **Evidence pinned at:** `motir-core` `origin/main` @
`c5086b97` · **Measured with:** `scripts/experiments/inngest-sleep-concurrency.mjs`,
`inngest-cli` 1.27.0, SDK 4.5.0

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

## §3 — The pool: scope is decided here, size is dashboard-only

**Scope — decisive, and it is a code fact.** **No job in this repo sets `concurrency` at all.**
All 24 definitions under `lib/jobs/definitions/` were checked; every occurrence of the word is a
comment or `defineJob`'s plumbing. `defineJob` supports `{ limit, key?, scope? }` with
`scope: 'fn' | 'env' | 'account'` (MOTIR-1982) and **nothing uses it**.

So there is no function-level, env-scoped or account-scoped limit that this deployment
configures. The only ceiling in play is the **account-level capacity Inngest applies to the
environment by plan**, shared by all 24 functions and partitioned by nothing.

That is worth stating plainly in both directions: the parent's picture of _one unpartitioned
pool_ is **correct**. What is false is that a supervisor sits in it for thirty minutes.

**Size — NOT READABLE with any credential this deployment holds, and here is the proof rather
than the assertion.** The production signing key (`INNGEST_SIGNING_KEY`, read off machine
`7817663f103648` of app `motir-core`) authenticates the events API and nothing else:

| probe                                                      | result                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /v1/events?limit=1`                                   | **200** — the key is valid                                           |
| `GET /v1/account`, `/v1/envs`, `/v1/apps`, `/v1/functions` | **404** — not part of the REST surface                               |
| `POST /gql { account { plan … } }`                         | **UNAUTHENTICATED** — the dashboard API takes a different credential |

**The configured capacity is therefore a dashboard reading, and that is a `manual` step for an
operator, not something to infer from a plan tier.** It is named as still-owed rather than
guessed: a number written down here from Inngest's public pricing page would be exactly the
"config file is a claim about the deployment, not a reading of it" mistake this corpus already
records. **What to run:** open the Inngest dashboard for the `prodect-core` app's production
environment and read the account concurrency limit off the plan/billing page.

**And note what §2 does to the stakes of that number.** A supervisor's contribution to it is a
few percent of one slot, so the capacity matters for _total throughput_ and no longer for _this
defect_.

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
