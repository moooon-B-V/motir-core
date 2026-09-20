# Should a dead letter FILE a work item — and if so, on WHAT trigger

**Status:** accepted · **Date:** 2026-09-20 · **Card:** MOTIR-5845 (epic MOTIR-4926)

MOTIR-5840 found 1,381 standing unreplayed rows in `job_run_dlq` and asked, as one
of its acceptance criteria, whether a dead letter over a threshold should file a
`bug`. That criterion was split out into this card because it is a product
question and not a fix, and because the premise it rested on — _"a dead letter
reaches nobody"_ — is false.

**The answer in one line:** the event path is complete and correct and files
nothing for these 1,381 rows because every one of them had already happened
before the machinery existed; a depth trigger is still WANTED, on an AGE
predicate rather than a count, because the event path is structurally unable to
see a standing condition.

> **On the file name.** `docs/decisions/` is slug-named, not numbered, so this
> takes the next free SLUG — checked against `origin/main` and against all 2,695
> `refs/remotes/origin/*` refs (`git ls-tree <ref> docs/decisions/…` → 0
> collisions), because two parallel runs picking the same name collide exactly as
> two picking the same number would.

---

## Q1 — did the existing chain fire?

**YES, exactly once, and correctly. It has never fired for a dead letter.**

The chain is three hops, and all three are on `origin/main` at `38310cc7a`:

| #   | hop                            | code                                                                          | read                                                                                                       |
| --- | ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | every terminal failure alerts  | `lib/jobs/engine/ledger.ts:183`                                               | `recordEngineTerminalFailure` calls `alertTerminalJobFailure` BEFORE the ledger write                      |
| 2   | the alert reaches Sentry       | `lib/monitoring/jobFailureAlert.ts:80`                                        | `Sentry.captureException`, `level: 'error'`, fingerprint `['job-terminal-failure', functionId, errorName]` |
| 3   | a Sentry issue becomes a `bug` | `lib/services/monitorIngestionService.ts` `pollConnection` → `reconcileIssue` | the reconciling poll, deduped on the provider's issue id                                                   |

Hop 1 and hop 2 have exactly one caller each, so there is no second lane writing
a dead letter without alerting:

```
$ git grep -n "alertTerminalJobFailure" -- lib scripts app
lib/jobs/engine/ledger.ts:183   (the only call site)
$ git grep -n "recordTerminalFailure" -- lib scripts   # the DLQ writer
lib/jobs/engine/ledger.ts:191   (the only call site; the monitor's own same-named
                                 method is a different function on a different table)
```

**The one time the chain has fired end to end** is MOTIR-5835, and it is on the
record in MOTIR-5815's production read of 2026-09-19 22:02Z (release v609,
machine `d8de397c61d0e8`, every query in `begin … rollback`, run twice — plain
and under `app.system_admin` — with identical results):

- the `monitor/connection.poll-requested` run at **21:30:02.371Z** filed
  MOTIR-5835 (_"Error: MOTIR-4941 production verification probe — safe to
  resolve"_);
- `monitor-issue-resolve` run `cmu8wliri0d9ahnpxrwktcntn` resolved it back to
  Sentry at 21:32:41.406Z with `{"links":1,"resolved":1,"failed":0}`;
- the reconciler has an unbroken 28.5-hour history at its 30-minute cadence,
  59 runs, **zero** non-`succeeded`.

**And it has filed nothing for the dead letters.** Searching the whole MOTIR
tenant for the seven `function_id`s in MOTIR-5844's table, and for the alert's own
markers `job_terminal_failure` / `job-terminal-failure`, returns only
hand-authored planning and cutover cards — no monitor-filed bug for any of them.

## Q2 — WHERE the chain lost them

**Two hops, and they partition the population completely. Neither is a defect.**

The three dates that decide it, all read rather than inferred:

| event                    | when                     | evidence                                                                               |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------------------- |
| the ALERT shipped        | **2026-08-27T14:35Z**    | `d3743e6c5`, PR #2354 — `git log --diff-filter=A -- lib/monitoring/jobFailureAlert.ts` |
| the POLL shipped         | **2026-09-18T16:51Z**    | `686a87204`, PR #2950 (MOTIR-4929)                                                     |
| the CONNECTION was bound | **2026-09-19T20:58:19Z** | the single `monitor_connection` row, MOTIR-5815's read                                 |

### Loss A — 683 rows predate the ALERT

For these four functions the newest row is older than 2026-08-27, so
`alertTerminalJobFailure` did not exist when they failed and **no Sentry issue was
ever created**:

| function_id                        | rows    | newest     |
| ---------------------------------- | ------- | ---------- |
| `work-item/embedding.requested`    | 670     | 2026-08-19 |
| `system.code-graph-index`          | 10      | 2026-08-19 |
| `system.ci-runner-provision-sweep` | 2       | 2026-08-09 |
| `system.ci-runner-reap`            | 1       | 2026-08-02 |
| **total**                          | **683** |            |

### Loss B — all 1,381 rows sit below the poll's WATERMARK

The remaining 698 rows (`system.code-graph-refresh` 386, newest 2026-09-10;
`email.send` 277, newest 2026-09-15; `system.daily-health-check` 35, newest
2026-09-08) DID alert. They are lost one hop later, and so are the other 683.

`pollConnection` reads
`lastSeenAfter = connection.lastSeenWatermark ?? connection.createdAt`, and the
Sentry provider cuts each page at the first issue whose `lastSeen` is not strictly
after it:

```ts
// lib/monitors/providers/sentry.ts — GET …/issues/?query=is:unresolved&sort=date
issues.findIndex((issue) => issue.lastSeenAt.getTime() <= lastSeenAfter.getTime());
```

The schema states the rule as a contract rather than as an accident:

```prisma
/// The newest `lastSeen` the poll has fully reconciled. `null` means "read from
/// this binding's `createdAt`" — the NEW-issue rule: nothing from before the
/// binding is back-filled.
lastSeenWatermark DateTime? @map("last_seen_watermark")
```

The binding is **2026-09-19T20:58:19Z**. The newest dead letter in the entire
population is `email.send` at **2026-09-15** — four days earlier. **Every issue
these failures produced is structurally unreadable by this connection**, for ever,
by design.

### The two hops that are RULED OUT, by reading rather than by elimination

- **The qualifying filter is not the loss.** `alertTerminalJobFailure` sends
  `level: 'error'`, `meetsMinimumLevel` admits it at every minimum except `fatal`,
  and `minimumLevel` is `null` on the production row — which `prisma/schema.prisma`
  documents as _"EVERY level qualifies — the shipped default"_. The filter removes
  nothing here.
- **The no-DSN no-op is not the loss.** `SENTRY_DSN` reads **Deployed** on
  `motir-core` (`fly secrets list -a motir-core`, 2026-09-20), and Fly secrets are
  app-wide, so the `worker` process group — which calls `Sentry.init` through
  `serverSentryInitOptions()` in `scripts/worker.ts:132` — has it. Read from the
  platform, not from `fly.toml`.

### What this means, stated plainly

**The chain was not silent. It was not yet born.** The alert is three weeks older
than the poll, the poll's binding is a day old, and the dead letters are five days
to seven weeks old. There is no defect to fix in the three hops, and a card
written to repair one would have found nothing wrong.

## Q3 — should a DEPTH-triggered filing exist? **YES**

**Recommendation: yes, and it is a different signal from the event path rather
than a louder copy of it.**

The event path answers _did this job fail?_ from a thrown error at the instant of
failure. A depth trigger answers _has nobody disposed of this function's
failures?_ from a standing table. Different source, different question, different
remedy — fix the code, versus drain the queue. That is what makes it an addition
and not a duplicate.

**The argument that decides it** is the one this epic was founded on, applied to
its own instruments. MOTIR-3606 fixed a probe and left its verdict with no
consumer; MOTIR-4918 then measured the delivery hop and found that _"no delivered
alert creates an OBLIGATION."_ MOTIR-5840 has just made the `Failed jobs` number
correct — it now reports standing depth rather than 24-hour arrivals — but a
number on a health page is precisely what `jobFailureAlert.ts`'s own header calls
the original defect: _"a place a person has to decide to go and look."_ Making the
figure true is not the same as giving it a consumer, and this project has now paid
for that distinction twice.

**And the blind spot is structural, not incidental.** An edge-triggered path
reports a condition once, at the moment it occurs. If nobody is listening at that
moment — the monitor unbound, disconnected, degraded, or simply not yet built, as
here — the backlog becomes invisible permanently, because the event will not
happen again. The DLQ row, by contrast, is durable and is still sitting there. A
state trigger is the only thing that can read it.

### The alternative this REJECTS

**"No new mechanism — the event path is sufficient."** It is a serious answer and
it nearly wins, for two reasons. The 1,381 rows are a one-off artefact of three
mechanisms landing in sequence, and once MOTIR-5844 drains them the DLQ should
stay near zero with every new arrival covered by the event path — including
recurrence, since `reconcileIssue` re-files (`refiled`, `relates_to` the old) when
a done bug is sighted again. And a second mechanism reading the same table is
exactly the duplication hazard to avoid.

**It is rejected because the event path has no disposal semantics.** A bug filed
from a Sentry issue is closed when the _code_ is fixed. Nothing in that path
replays or discards the `job_run_dlq` rows, so residue from fixed faults
accumulates monotonically and silently — which is most of what the 1,381 now are.
No amount of correctness in the event path reaches that, because it is not an
error condition at all; it is an undone chore with no owner. The rejection is
narrow, and it is what bounds the trigger in Q4: the depth filer must never file
_"job X is failing"_, which is the event path's sentence and would duplicate it.

## Q4 — the trigger, and what stops it re-filing

**Threshold — AGE, not count: a `function_id` with at least one unreplayed
`job_run_dlq` row whose `last_failed_at` is more than 7 days old.**

Count is the wrong predicate and is the one the parent card reached for. Count
measures a _fault's blast radius_ — a single broken deploy produced 670
`work-item/embedding.requested` rows, and that is one problem, not 670. Age
measures _nobody having acted_, which is the condition this is for. Seven days is
chosen as comfortably longer than any legitimate triage latency and far shorter
than the seven weeks these rows actually stood.

**Host — a dedicated scheduled job, NOT `system.daily-health-check`.** That job is
itself in `job_run_dlq` 35 times; an alarm that dead-letters into the queue it
watches has already failed, and this project has paid for that shape twice
(MOTIR-3606, MOTIR-4918). The separation that makes the pair sound: the depth
sweep's own terminal failure is an EVENT, so the event path catches it, while the
event path's blind spot is standing state, which the sweep catches. **Neither
watches itself.**

**Dedup key — one open bug per `function_id`, held in a row, not inferred.** Reuse
the `monitor_issue` shape rather than inventing one: a claimed-and-locked row
keyed on the function id, carrying the filed `work_item_id`.

**Re-arm — only when that function's standing depth returns to zero.** This is the
load-bearing asymmetry and the whole answer to _"what stops it re-filing"_:

- **Closing the bug does NOT re-arm.** If it did, a backlog nobody drains would
  produce a new card every sweep — one unattended queue becoming a board nobody
  can drain, which is the failure this epic exists to prevent, reproduced by the
  mechanism meant to prevent it.
- **Draining without closing the bug is fine** and re-arms normally.
- While a bug is open for a function, the sweep files nothing more for it,
  whatever the depth does.

**Close condition — a person or a run closes it when the rows are disposed of
under MOTIR-5844's stated rule.** The sweep never auto-closes: disposal is a
judgement with user-visible consequences (`replayDLQ` re-emits, and for
`email.send` that is real mail to real users), and a mechanism that closed its own
card would assert a disposal it did not make.

### The boundary against MOTIR-3765

MOTIR-3765 (`todo`) is the queue-depth ALERT — `job_queue` pending depth and
oldest-pending age, _"the page that fires when nothing is claiming"_. This is a
different table (`job_run_dlq`), a different condition (terminal failures
undisposed, not work unclaimed) and a different instrument (a filed work item, not
a page). They do not overlap and neither subsumes the other. This card consumes
nothing from MOTIR-3765 and carries no dependency on it.

## What this record did NOT measure

**Whether any dead letter has ARRIVED since the binding at 2026-09-19T20:58:19Z.**
If one had, the event path should have filed a bug for it, and that would be the
strongest possible forward confirmation. It needs a production read of
`job_run_dlq`, which this run's sandbox refuses (`fly ssh console` and the
date-filtered tenant search were both blocked). It is owed, it is cheap, and it is
already MOTIR-5844's own first acceptance criterion — _"the table is re-measured on
production"_. **That re-measurement should record, beside the counts, whether any
row postdates the binding and whether a bug exists for it.** Nothing in this
record's conclusions depends on the answer: both loss hops are decided by dates
alone.

## Consequences

- The three-hop event path is **correct as it stands** and needs no change. Do not
  file a bug against it; there is no defect in it.
- The 1,381 standing rows are **not evidence that the chain is broken** and must
  not be cited as such. They are older than the chain.
- A future reader asking _"why did nothing file a bug for the dead letters?"_ has
  the answer here, with the three dates, and does not need to re-derive it.

## The implementation card

**The depth filer is NEW WORK, not a fix**, so it is not a `bug` and a `motir run`
may not write it into the tree directly. It was submitted as **plan
`cmu9o28hf0038hytxm18va5s6`** (_"The DLQ standing-depth filer — MOTIR-5845's
decision, implemented"_, `planned`, one proposal), carrying:

> **(motir-core) The DLQ standing-depth FILER — one bug per function whose dead
> letters have stood 7 days, re-armed only when that function's depth returns to
> zero** · `task` / `code` / `coding_agent` · 5 points · 70 min · beside this card
> under epic MOTIR-4926 · `blocked_by` **MOTIR-5845** (this record) and
> **MOTIR-5844** (the triage).

**It is `blocked_by` MOTIR-5844 deliberately.** Shipping the filer before the
triage drains the queue would fire it on day one against all seven standing
functions, filing seven bugs about a backlog somebody is already working. The
edge is the ordering, not a formality.

**The `MOTIR-<n>` key follows approval** — a proposal has no key until a person
approves the plan in Motir, which is the one path from a proposal to a row. When
it is approved, that key belongs in this section.

**This card implements nothing**, as its own acceptance criteria require: the only
artefact it ships is this record.
