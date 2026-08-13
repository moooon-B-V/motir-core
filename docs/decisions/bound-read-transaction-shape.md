# ADR: The transaction shape of a bound tenant READ — one transaction per service method

- **Status:** Accepted (2026-08-13)
- **Story / Subtask:** MOTIR-2796 (Bind the READ surface for `motir_app`) · Subtask MOTIR-2799
- **Extends:** MOTIR-2569's `lib/workspaces/tenantRead.ts` seam (the reader owns the
  binding, not the call site) and MOTIR-2685's userless
  `withWorkspaceServiceContext` tier.
- **Consumed by:** MOTIR-2800 … MOTIR-2813 — the fourteen cards that bind the 55
  reads. Every one of them applies this document; none of them re-decides it.
- **Supersedes / superseded by:** none.

> Structured **Context → Decision → Consequences → References**, the convention
> the repo's ADRs set. No product behaviour ships in this subtask. What it freezes
> is the answer fourteen binding cards would otherwise each invent.

---

## Context

`app.workspace_id` is bound with `set_config(…, true)`, which is **transaction-local**.
A read that must be seen by an RLS policy therefore has to run inside a transaction —
and a service method with N such reads has two shapes:

**(A) One transaction per SERVICE METHOD.** `withWorkspaceServiceContext` opens once at
the method boundary; `tx` is threaded into every read beneath it. Prisma serialises
work inside an interactive transaction onto one connection, so an existing
`Promise.all` of N reads becomes N sequential reads.

**(B) One transaction per READ.** Each read gets its own context and `Promise.all`
still parallelises — at the cost of N pooled connections held simultaneously.

Two shipped call sites had already answered this in opposite directions without
either noticing the other, which is why the answer is being written down before the
next fourteen cards touch the same question.

### The measurement

`scripts/bench/boundReadTransactionShape.ts` (`pnpm bench:bound-read-shape`) is the
artefact; re-run it rather than trusting the numbers below. It installs a
query-logging `PrismaClient` as the `@/lib/db` singleton, calls each **real**
repository method once to CAPTURE the exact SQL and bind parameters Prisma sends,
and replays those captured statements under each shape — so it can never measure a
copy that has drifted from the shipped read.

Corpus: `pnpm db:seed:reporting` — the RPT project, **10 000 work items / 28 552
revisions** over 26 weeks, a 180-day / 27-bucket report window. Local Postgres 15,
15 timed iterations after 3 warm-ups.

| shape                                                                  |          p50 |      p95 |
| ---------------------------------------------------------------------- | -----------: | -------: |
| unbound-parallel — _today's code; returns zero rows under `motir_app`_ |      57.0 ms |  69.5 ms |
| unbound-sequential                                                     |     105.7 ms | 123.5 ms |
| **(A)** one transaction, 8 reads sequentially                          | **117.9 ms** | 132.3 ms |
| **(B)** 8 transactions in `Promise.all`                                |  **63.0 ms** |  66.7 ms |
| transaction overhead — `BEGIN` + `set_config` + `SELECT 1` + `COMMIT`  |       0.6 ms |   0.9 ms |

Per statement (p50): `aggregateAverageAgeByBucket` **58.6 ms** · `aggregateNetResolvedByBucket`
18.9 ms · `aggregateResolutionTimeByBucket` 14.1 ms · `aggregateSprintCycleByDay` 7.5 ms ·
`aggregateCreatedByBucket` 4.2 ms · `aggregateDistribution` 3.0 ms ·
`aggregateWorkloadByAssignee` 2.9 ms · `sumStartedForSprint` 0.2 ms.

So the law is simple and holds to within a millisecond: **(A) costs Σ(statements),
(B) costs max(statements)**, and the transaction itself costs 0.6 ms — three orders
of magnitude below the difference the two shapes are actually arguing about.

Read the RATIO, not the absolute times. Repeated runs on a loaded box move every row
together (a second run gave 75 / 139 / 145 / 71 / 0.9 ms) while the Σ-vs-max relation
and the ~2× gap stay put. None of the numbers here is a threshold anything asserts
against; the one that carries weight downstream is the distance to the 5 s
transaction default, and that survives any of these runs by more than an order of
magnitude.

### ⚠️ The 8-wide fan-out being decided on does not exist in the shipped code

MOTIR-2799 describes `reportsService` as holding _"2 such fan-outs, one of them
8-wide"_. Read on this branch, it does not. The eight aggregates sit in **eight
separate report methods**, one aggregate each; the file's only `Promise.all`s are:

- `getCreatedVsResolved` (`:328`) — **2 reads**. (A) ≈ 23 ms, (B) ≈ 19 ms.
- `getVelocity` (`:137`) — a rollup **per completed sprint**, default 7, capped at 52.

The 8-wide row in the table above is therefore a deliberately synthetic **worst
case**: the widest thing that could be built out of this service's reads, not
anything a request performs. It is the right number to _decide_ on and the wrong
number to _quote as a regression_. The velocity loop — the widest fan-out the file
really has — was measured separately, because it is the one place (A) serialises
something genuinely wide:

| velocity fan-out                   | (A) sequential | (B) parallel |
| ---------------------------------- | -------------: | -----------: |
| 7 rollups (the default window)     |         2.4 ms |       1.9 ms |
| 52 rollups (`MAX_LAST_N`, the cap) |        14.9 ms |      13.5 ms |

The widest single-expression fan-out anywhere in the codebase is
`workItemsService.ts:3691-3712` (7 reads for the item-detail relationships panel),
not anything in `reportsService`.

### The pooler, read from the platform

Neon's pooled endpoint is PgBouncer in transaction mode, so **an interactive
transaction holds one server connection for its whole duration**. That makes the
pool the real currency of this decision, and the ceiling is a platform fact rather
than a config claim — so it was probed rather than looked up
(`scripts/` was not the source; a live endpoint was).

Measured against the Neon project that carried motir-core's production data through
2026-08-10, `us-east-1`, via its `-pooler` host:

- `max_connections` = **112**, `superuser_reserved_connections` = 6.
- 140 concurrent pooled transactions, each holding `pg_sleep(5)`: server-side
  backends rose and then **plateaued at exactly 98** and stayed there for the whole
  window; **all 140 transactions completed and none errored**. So the effective
  server-side pool is ~98 (≈ 0.9 × `max_connections`, matching Neon's documented
  `default_pool_size`), and past it PgBouncer **queues rather than refuses**.

**The residual unknown, stated rather than papered over.** The LIVE production
`DATABASE_URL` is stored Vercel-`sensitive`: it pulls **empty** for the project
owner, from both `vercel env pull` and the API, and there is no Neon API token in
this environment. The number above is therefore read from the _predecessor_ project
on the same platform, plan class and region — not from the endpoint production will
use after MOTIR-2515. That gap is load-bearing for shape (B) and irrelevant to shape
(A), which is one of the reasons (A) wins below.

---

## Decision

### 1. The default is (A) — ONE transaction per service METHOD

A service method that reads policy-gated tables opens **one**
`withWorkspaceServiceContext` (or `withWorkspaceContext`, when it has an acting
user) at its own boundary, and threads that `tx` into every read beneath it.
A `Promise.all` inside that boundary collapses to sequential awaits; that is
expected and accepted.

**(A) is not chosen because it is faster. It is 1.9× slower on the synthetic
worst case and it never wins on latency.** It is chosen for four reasons, in
order of weight:

1. **(B) does not use less database — it uses the same database more abruptly.**
   Total connection-time per request is near-identical: (A) holds one slot for
   118 ms; (B) holds eight slots for Σ(statements) ≈ 105 ms plus eight 0.6 ms
   transaction overheads ≈ 110 slot-ms. (B) buys its latency by demanding N slots
   _simultaneously_, not by spending less.
2. **Under pool pressure (B) degrades as the MAXIMUM of N independent queue waits;
   (A) degrades as ONE.** Same throughput, strictly worse tail — and the measured
   failure mode is the bad kind: the pooler queues silently instead of erroring, so
   the symptom is unexplained p99 latency rather than a log line.
3. **(A) is invariant to the number nobody can read.** (B)'s safety margin is a
   function of the live pool ceiling, which is unreadable (above) and will change
   the day the compute is resized. (A) costs one slot per request whatever that
   number turns out to be. Choosing the shape whose correctness does not depend on
   an unobtainable fact is the whole argument in one line.
4. **Snapshot consistency comes free, and it is not cosmetic here.**
   `savedFiltersService` reads `listPage` and `countVisible` together — in two
   transactions those can straddle a write and render _"1–20 of 0"_. The
   created-vs-resolved report can likewise show more items resolved than were ever
   created. Both are the kind of small incoherence that costs trust in a reporting
   surface permanently.

The cost is bounded and, in the code that actually exists, small: **0 ms** on the
six single-read report methods, **+4 ms** on the only 2-wide fan-out, **+1.4 ms** on
the velocity loop at its 52-sprint cap.

### 2. No `TransactionBudget` for read paths — ruled out, with the number

The synthetic worst case is **117.9 ms p50 / 132.3 ms p95** against Prisma's default
`timeout: 5000`. That is a **38× margin** on the widest fan-out that could be
constructed, and the widest one that exists is 23 ms. Adding a `TransactionBudget`
here would raise a limit nothing is near.

So: **a read path does not pass `options` to `withWorkspaceServiceContext`.** The
type keeps its single shipped caller (MOTIR-1972's runner-group sync, which holds a
row lock across network calls). A binding card that finds itself wanting one has
found a read that does not belong in this class — say so on the card rather than
raising the ceiling, and bring the measurement.

### 3. Threading rules the binding cards apply verbatim

- **Repository signature.** A read of a policy-gated table takes
  `tx?: Prisma.TransactionClient` as its LAST parameter and resolves
  `const client = tx ?? db`. This is the form `tests/rls/singletonReadScan.ts`
  already recognises as _bindable_, so adding it removes the read from the scan —
  which is why every binding card must delete its `VERDICTS` entry in the same
  commit. (This narrows, and does not contradict, `CLAUDE.md`'s
  _"read methods used only by read-only service paths may use the `db` singleton"_:
  that licence no longer extends to a policy-gated table.)
- **Never open a second transaction inside one.** Where a read already sits inside
  a write transaction, thread THAT `tx`. Prisma rejects nesting, and a read given a
  bound `tx` needs no context of its own.
- **Bind every CALL SITE of a read, not just the owning service's.** The ratchet
  counts the READ; a read bound at one caller and unbound at another is recorded as
  fixed while a live path stays dark.
- **Raw SQL is not special.** RLS applies to `$queryRaw` exactly as to a model call
  — the policy is on the table. The bindable form is `client.$queryRaw`, where
  `client = tx ?? db`. Twenty-eight of the 55 reads are raw; none of them needs
  different treatment.

### 4. Disposition of the two shipped precedents

**`lib/workspaces/tenantRead.ts` (MOTIR-2569) — RECONCILED; it is the reference
implementation.** Its readers take an optional `tx` and open their own bound
transaction only when the caller has none, which is exactly rule 3. It was read as
"a third convention" only because a _reader_ that opens a transaction looks like
per-read binding; it is per-CALLER binding with a fallback, and every repository
signature this story adds copies it.

**`lib/services/publicProjectsService.ts` (commit `f53d6aaa`) — GRANDFATHERED under
a STRUCTURAL exemption, not a performance one.** Its `Promise.all` of separate
contexts is not (B)-for-speed; it is (B) because **one transaction cannot hold two
different bindings**. `computeStats` mixes two workspace-bound reads with
`publicRequestVoteRepository.countByProject`, and — decisively —
`work_item_public_project_read`'s USING clause fires only when `app.workspace_id` is
**UNSET**, so some reads on that page must run with no binding at all. (A) is not
expressible there.

That gives the one sanctioned exception, stated as a rule rather than an escape
hatch:

> **(B) is permitted only when the members of a fan-out require DIFFERENT bindings**
> — different workspaces, or bound alongside deliberately unbound public-arm reads.
> Performance is never a sufficient reason on its own; a card that wants (B) for
> latency must show (A) exceeding a stated budget, measured, in its PR body.

MOTIR-2807 inherits this directly: `workItemRepository.findByIds` at
`publicProjectsService.ts:874` is on the public path, and binding a workspace there
would DISABLE the public arm rather than fix anything.

---

## Consequences

- The fourteen binding cards have one shape to apply and no judgement to make. A PR
  that opens a second convention is a review finding, not a preference.
- `getCreatedVsResolved`'s and `getVelocity`'s `Promise.all`s become sequential
  awaits. That is intended; the measured cost is +4 ms and +1.4 ms respectively, and
  it should be stated in those PRs rather than hidden.
- Peak pooled-connection demand per request stays at **1**, unchanged from today.
  MOTIR-2515 can therefore cut the deployed runtime over without a pool-sizing
  question attached, which is one fewer unknown on the riskiest card in the effort.
- The unreadable production pool ceiling stops mattering. If it ever needs to be
  known — a future (B) exemption, a capacity review — the path is a Neon API token
  or a non-`sensitive` sibling, not another `vercel env pull`.
- **What would reopen this.** A single service method whose (A) shape is measured
  past ~1 s, or a fan-out member that genuinely cannot share a binding. Both are
  card-level exceptions with evidence, not a re-decision.

---

## References

- `scripts/bench/boundReadTransactionShape.ts` — the benchmark; `pnpm bench:bound-read-shape`.
- `lib/workspaces/context.ts` — `withWorkspaceServiceContext`, `TransactionBudget`,
  and the header paragraph that now states this convention.
- `lib/workspaces/tenantRead.ts` (MOTIR-2569) — the reference implementation of the
  optional-`tx` reader.
- `lib/services/publicProjectsService.ts` (`f53d6aaa`) — the grandfathered (B) site.
- `prisma/migrations/20260811230000_public_project_read_policy/migration.sql` —
  `work_item_public_project_read`, whose USING clause requires `app.workspace_id`
  to be UNSET.
- `tests/rls/singleton-read-guard.test.ts` / `tests/rls/singletonReadScan.ts` — the
  `tx ?? db` form this ADR mandates is exactly what the scanner treats as bindable.
- `docs/rls-runtime-role-inventory.md` — the running measurement this story extends.
