# ADR: The Postgres job engine builds on a hand-rolled queue, not Graphile Worker or pg-boss

- **Status:** Accepted (2026-08-23)
- **Story / Subtask:** The Postgres job engine (MOTIR-3414) · Subtask MOTIR-3419
- **Epic:** MOTIR-3413 — Own the job substrate
- **Supersedes / superseded by:** none
- **Evidence pinned at:** `motir-core` `origin/main` @ `165f1485`
- **Consumed by:** MOTIR-3420 (the schema), MOTIR-3421 (the worker), MOTIR-3422 (the `step`
  shim), MOTIR-3423 (fan-out + the cutover switch), MOTIR-3424 (retry / `onFailure` / DLQ
  parity), MOTIR-3426 (the story gate).
- **Ships no behaviour.** This record fixes shapes. Nothing here changes what production does,
  and no sibling card may treat any table or module named below as present until MOTIR-3420
  and MOTIR-3421 land it.

---

## §1 — The question, and the constraint that is not negotiable

**What does the Postgres job engine build ON — [Graphile Worker], [pg-boss], or a queue we
write ourselves?**

One constraint is inherited from the epic rather than chosen here: **no candidate that requires
Redis, or any other new running service, is admissible.** The whole point of MOTIR-3413 is to
remove an external dependency from the background layer, and swapping Inngest for something that
needs a second daemon would trade one operational surface for another while paying the migration
cost anyway.

All three candidates pass that filter — all three are Postgres-only — so it eliminates nobody and
is recorded here as **applied, not assumed**, which is what the card asked for. It does eliminate
the obvious fourth candidate (BullMQ and everything else in the Redis family), and that is the
work the constraint actually did.

## §2 — The axis that separates them is the one row where all three are identical

|                                    | Graphile Worker   | pg-boss                        | hand-rolled |
| ---------------------------------- | ----------------- | ------------------------------ | ----------- |
| storage                            | Postgres          | Postgres                       | Postgres    |
| wake mechanism                     | `LISTEN`/`NOTIFY` | polling + notify               | ours        |
| cron                               | built in          | built in (`schedule`)          | ours        |
| debounce / singleton               | no                | **yes** (singleton / throttle) | ours        |
| retries + backoff                  | built in          | built in                       | ours        |
| **durable, memoized steps**        | **no**            | **no**                         | **no**      |
| **one event → N subscribing jobs** | **no**            | **no**                         | **ours**    |

**The last two rows decide this record, and they decide it before any comparison of the others.**

- **No candidate implements memoized steps or a durable sleep.** They are job queues: a row goes
  in, a handler runs, the handler either returns or throws. There is no notion of a run that has
  completed steps 1–3, yielded, and must resume at step 4 without re-executing the first three.
  **So the `step` shim (MOTIR-3422) is ours to build under every option**, and it needs a
  `job_step` table under every option.
- **No candidate implements fan-out.** `sendEvent('work-item/transitioned', …)` must reach four
  subscribing jobs today. A queue enqueues a job; it does not hold an event log and derive
  subscribers from a registry. **So the dispatcher (MOTIR-3423) is ours under every option**, and
  it needs a `job_event` table under every option.

That reframes the decision. It is not _"which framework runs our jobs"_ — no framework runs our
jobs, because our jobs are stepped and fan-out-triggered and nothing off the shelf is either. It
is: **given that we are writing the event log, the dispatcher, the step store and the shim
regardless, do we also write the claim loop, or do we adopt a dependency for that one piece?**

Stated that way, the thing on offer is a claim loop, a backoff, and a cron tick.

## §3 — What the candidates would supply, priced against what this repository already has

| what a library brings            | what we already have                                                                                                                                                | net                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claim with `SKIP LOCKED`         | `lib/services/codeGraphIndexAdmissionService.ts` — a `FOR UPDATE` claim already in this tree, and `CLAUDE.md`'s lock-before-a-contended-update rule that governs it | ~30 lines of SQL we know how to write and are already required to test for concurrency (MOTIR-3421's AC demands a genuine two-worker race whichever way this goes) |
| cron scheduling                  | **`lib/jobs/cron.ts`** — 192 lines, a UTC 5-field evaluator with `previousFireAtOrBefore`, already shipped for the schedule-health check (MOTIR-1970)               | a tick loop over a table we own; the hard part (parsing, POSIX day-of-month ∧ day-of-week) is written and tested                                                   |
| retry + backoff                  | `lib/jobs/retries.ts` — the three NAMED policies (`transient` 3 / `idempotent` 5 / `none` 1) with their rationales, which MOTIR-3424 must preserve exactly          | a library's own retry model would have to be **mapped onto** these, not adopted — attempt budgets are already a decided product surface                            |
| pg-boss's `singleton` / throttle | one consumer: `codeGraphRefresh`'s debounce, keyed per repo                                                                                                         | genuinely useful, and the single strongest argument for pg-boss — see §9                                                                                           |

**The honest summary of the column on the right: the substrate we would be adopting a dependency
for is the part we have the most existing code and the most existing discipline for.** That is not
an argument that writing code is free. It is an argument that this particular code is small,
well-understood, already exercised elsewhere in the tree, and — crucially — **already required to
be written and tested by cards in this story regardless of which option wins**.

## §4 — The decisive finding: a library's own schema sits OUTSIDE this database's tenancy perimeter

This is the finding that moves the decision from _"marginal, pick either"_ to _"one of them is
wrong"_, and it is specific to this repository rather than a general preference.

Both libraries create and own their tables in **their own Postgres schema** — `graphile_worker`
for Graphile Worker, `pgboss` for pg-boss — created by the library at boot or by its own
migration CLI, with a shape the library controls and revises across versions.

**This database grants nothing there.** Read on `origin/main`, in
`prisma/migrations/20260810000000_rename_app_role_to_motir_app/migration.sql`:

```sql
CREATE ROLE motir_app LOGIN NOSUPERUSER NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO motir_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO motir_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO motir_app;
```

Every clause is **`IN SCHEMA public`**, and the default-privileges rule is additionally scoped to
the migration-running role's future objects. Three consequences, in order of severity:

1. **The application role could not use the library's tables at all.** Production connects as
   `motir_app`, which is `NOBYPASSRLS` and holds no `USAGE` on a `pgboss` / `graphile_worker`
   schema and no privileges on anything inside it. The worker would fail on its first claim until
   somebody hand-wrote a grant migration — and **every library upgrade that adds a table
   reintroduces the gap silently**, because the default-privileges rule that covers our own new
   tables does not reach that schema.
2. **RLS could not be applied the way this repository applies it.** `job_event` and `job_queue`
   carry `workspace_id` (a job payload is tenant data), and MOTIR-3420's acceptance criteria
   require the `job_run` / `job_run_dlq` pattern: `ENABLE` + `FORCE ROW LEVEL SECURITY` and a
   `workspace_or_system_admin` policy over `current_setting('app.workspace_id', true)`. Writing
   that policy onto a table whose columns a library owns means our tenancy guarantee is pinned to
   a third party's schema and breaks on their minor version.
3. **The schema stops being fully described by `prisma/migrations/`.** A production database's
   shape would then come from two sources with no shared ordering.

**Consequence (1) alone is disqualifying**, and it is not a preference — it is a privilege grant
that does not exist. Consequence (2) is the one that would still bite if somebody fixed (1) with a
grant migration: we would have adopted a dependency and then had to add our own tables beside it
anyway, for `job_event` and `job_step`, which §2 already established the library cannot supply.

**So the end state under either library is: their tables for `job_queue`, our tables for
`job_event` and `job_step`, two migration systems, two grant regimes, and a tenancy policy
straddling both.** That is strictly worse than three tables in `public` that our own migrations
create, with the grants and the RLS the repository already applies by default.

### §4a — The answer to the card's question 2, stated plainly

**No: neither candidate's own tables can carry `job_step`.** Both model a job row, not a step
ledger; there is no `(run_id, step_id)` memo table to extend, and adding one means our own table
regardless — in `public`, where it is grantable and RLS-able. The library would own one of the
three tables and the least interesting one.

## §5 — What was checked and did NOT decide this, recorded so it is not re-derived

**The schema-drift gate does not catch a library's tables, and an earlier draft of this record
claimed it did.** The correction is kept rather than deleted, because the wrong version is a
plausible reading of the same CI file and the next person will reach for it.

`ci.yml`'s `build` job runs, at line 553:

```yaml
- name: Assert the datamodel and the migrations agree (no schema drift)
  run: pnpm prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --exit-code
```

The argument that suggested itself: _a library creates tables Prisma does not model, so the diff
sees them and CI goes red._ **It does not.** The comment directly above the step says what the
target database is — `pnpm build` ran `prisma migrate deploy` against the job's ephemeral
Postgres, so it is **a from-empty replay of our migrations and nothing else**. A library's tables
are created at worker boot, which never happens in that job, so they are not in the replay and the
diff cannot see them.

The gate is therefore silent on this choice. §4's grant argument stands on its own and does not
need it — but a reader who assumes CI would have caught the problem will under-weight §4, which
is exactly the wrong conclusion to leave available.

## §6 — Licence, read from the installed artifact

The card requires the chosen package's licence be read from the installed artifact rather than a
project page. **The choice is hand-rolled, so no package is added and there is no new licence to
record.** Discharging the criterion honestly means reading the licence of what the engine actually
runs on, and of what it replaces:

```
$ node -e "const p=require('./node_modules/pg/package.json');console.log(p.name,p.version,p.license)"
pg 8.21.0 MIT

$ node -e "const p=require('./node_modules/inngest/package.json');console.log(p.name,p.version,p.license)"
inngest 4.5.0 Apache-2.0
```

- **`pg@8.21.0` — MIT.** Already a direct dependency; the engine adds no new one. Prisma is the
  access path for everything the 4-layer rule governs, and `pg` is present for the raw
  `FOR UPDATE SKIP LOCKED` claim the ORM cannot express.
- **`inngest@4.5.0` — Apache-2.0**, and it stays installed for the whole migration: both engines
  run side by side behind the cutover switch, and MOTIR-3413's retirement story is the only card
  that removes it.

**The distinction this criterion exists to preserve is worth restating**, since it is the reason
the card demanded the installed artifact: Inngest's **SDK** is Apache-2.0, as read above, while
Inngest's **server** is SSPL. A project page that says "open source" describes one of those. The
migration is not motivated by the SDK's licence — the SDK is permissive and would stay permissive
— which is worth being clear about so nobody later cites a licence problem that the installed
artifact does not show.

**Zero new production dependencies is a real property of this choice**, and it is the cleanest
form of §7's answer.

## §7 — What it costs to leave

The card asks this because we are migrating off a substrate right now, and the reason it is
expensive is exactly that Inngest's abstractions reached past the seam: `step.run` is in 58 call
sites, `ctx` is Inngest's own type, and `JobContext` is _inferred from the SDK_
(`Parameters<Parameters<typeof inngest.createFunction>[1]>[0]` — `lib/jobs/defineJob.ts`). A
candidate that repeats that shape repeats the bill.

**Hand-rolled has the lowest exit cost of the three, and the mechanism is structural rather than a
promise:** the engine is reached only through `defineJob` / `sendEvent`, its types are ours, and
its tables are three models in our own schema. Replacing it later means rewriting `lib/jobs/` — the
same blast radius this story is already scoped to — with no vendor type escaping into a handler
signature, because there is no vendor.

Under either library, the claim loop's semantics (visibility timeouts, its own retry columns, its
notion of a job id) become load-bearing in `lib/jobs/`, and leaving means a second migration of the
same kind as this one.

**The counterweight, stated rather than skipped:** the exit cost of a library is low _in the other
direction_ too — adopting one is reversible if it disappoints, and "we own it" is also "we
maintain it, including the bug we have not hit yet." §4 is what makes that trade lopsided here.
Without §4 this would be a close call and the record would say so.

## §8 — What this settles for the sibling subtasks

- **MOTIR-3420 (schema):** three tables — `job_event`, `job_queue`, `job_step` — as Prisma models
  in `public`, created by our migrations, with FKs modelled as `@relation` on both sides and RLS
  mirroring `job_run` / `job_run_dlq`'s `workspace_or_system_admin` policy. No library schema
  exists to sit beside. `job_step` is keyed uniquely on `(run_id, step_id)`.
- **MOTIR-3421 (worker):** the claim is ours, written as `SELECT … FOR UPDATE SKIP LOCKED` in one
  transaction with the state write, side effects strictly after the commit. No library claim loop
  to interoperate with, so the card's concurrency criterion is a test of our own SQL.
- **MOTIR-3422 (shim):** ours under every option — this record's §2 is the reason the card exists
  and it must not be read as a gap the foundation left.
- **MOTIR-3423 (fan-out + switch):** ours under every option, for the same reason.
- **MOTIR-3424 (retry / `onFailure` / DLQ):** `lib/jobs/retries.ts`'s named policies are the
  contract; the engine implements them rather than mapping a library's model onto them.
- **MOTIR-3426 (story gate):** the import-boundary assertion has a simpler target — nothing
  outside `lib/jobs/**` may import the engine's internals, mirroring the existing ESLint boundary
  for Inngest. There is no third-party module to add to that boundary.

**One enumeration correction the sibling cards should carry.** MOTIR-3414 states "the 13 scheduled
jobs". Measured on `origin/main@165f1485`, **13 definition FILES declare a cron and they contain 14
cron functions** — `ciRunnerFleet.ts` declares two (`CI_RUNNER_PROVISION_SWEEP_CRON` and
`CI_RUNNER_REAP_CRON`). MOTIR-3416 is the card that owns that population; it should plan for
fourteen. (The `step.run` enumeration in MOTIR-3414 / MOTIR-3422 was corrected on those cards by the
same run; planning bug MOTIR-3428.)

## §9 — The rejected options, and the reason each was rejected

### pg-boss — rejected

**The strongest candidate, and the one with a real feature we want.** Its `singleton` / throttle
options are the closest off-the-shelf thing to `codeGraphRefresh`'s debounce, which is the hardest
option in `defineJob`'s surface to reproduce and the one MOTIR-2994 measured the hard way.

Rejected on **§4**: it creates and owns a `pgboss` schema, which `motir_app` has no `USAGE` on and
no default privileges in, so the non-bypass role production runs as cannot touch it — and the RLS
policy MOTIR-3420 must apply would have to be written onto tables whose shape pg-boss revises
between versions. Since §2 already forces us to add `job_event` and `job_step` ourselves, adopting
it buys one table out of three at the price of a second schema, a second migration system and a
grant regime that must be re-checked on every upgrade.

**The debounce is not lost, and it is not a reason to reconsider.** It has exactly one consumer.
Its semantics are "hold until `period` passes with no further same-key event, then run once with
the latest" — a `run_at` that is pushed forward on each same-key arrival, which is a column and an
upsert on a table we own, not a subsystem. The measured limit MOTIR-2994 recorded (a stream faster
than ~1/s defeats the `timeout` cap on the dev server) is a property of Inngest's implementation
that we are free not to reproduce.

### Graphile Worker — rejected

Rejected on **§4** identically — it owns a `graphile_worker` schema with the same grant and RLS
consequences — and it is the weaker of the two libraries for this codebase besides: **no debounce
or singleton**, so the one option pg-boss would have genuinely supplied is absent, leaving a
candidate whose entire contribution is a `LISTEN`/`NOTIFY` claim loop and a cron tick against a
tree that already contains `lib/jobs/cron.ts` and an existing `FOR UPDATE` claim.

Its `LISTEN`/`NOTIFY` wake is a real strength and it is **not** exclusive to it: `NOTIFY` is a
Postgres feature, and MOTIR-3421's "a newly emitted event is picked up promptly rather than at the
next poll boundary" criterion is satisfied the same way without the dependency.

### Redis-backed queues (BullMQ and family) — rejected without evaluation

**Rejected by the epic's premise, applied rather than assumed (§1):** they require Redis, a new
running service. Recorded so the constraint is visibly enforced rather than silently satisfied by
a shortlist that happened to contain no Redis candidate.

### Doing nothing / staying on Inngest — out of scope here

MOTIR-3413 settled that; `docs/decisions/job-lane-occupancy.md` is the measurement behind it. This
record chooses a foundation, not whether to move.

## §10 — The risk this decision accepts, named

**We now own a concurrency-critical claim loop.** The failure mode is specific and known: a
read-derived write without `FOR UPDATE SKIP LOCKED` lets two workers execute one row, and **a
serial test cannot see it** — it needs genuine concurrency against a warm pool, which is why
MOTIR-3421 and MOTIR-3426 both carry that criterion and why neither may discharge it with a
sequential test.

That is the bug a mature library would most plausibly have saved us from. It is accepted because
the alternative does not actually avoid it — MOTIR-3426's crash-resume and two-worker guards test
_our_ step shim and _our_ dispatcher either way — and because §4 makes the libraries unusable here
for reasons that have nothing to do with the quality of their claim loops.

## §11 — What a missed tick does: the catch-up policy, per job (MOTIR-3468)

**Amendment, 2026-08-25.** §4–§8 chose a foundation and settled the dispatcher, the claim and the
retry model. They did not answer the question that only appears once the _scheduler_ is ours:
**the worker was down across a scheduled fire — does that fire run late, or is it lost?** Inngest
answered it for us and it never had to be written down. MOTIR-3416 builds the scheduler
(`engineScheduledJobs()` has existed since MOTIR-3421 with no caller), so the answer is now a
decision this project owns, and an undeclared one is how a sweep stops running for a week
unnoticed.

### §11.1 — Three dispositions, because "catches up" is under-specified

"Catch up" names three different behaviours, and a policy that does not choose between them has not
been made:

| disposition  | what the scheduler does on restart                                      |
| ------------ | ----------------------------------------------------------------------- |
| **`all`**    | enqueue **every** fire the expression owed across the gap, oldest first |
| **`latest`** | enqueue **only the most recent** owed fire; the older ones are dropped  |
| **`skip`**   | enqueue **nothing**; the next scheduled fire is the next run            |

### §11.2 — `retryPolicy` is NOT a catch-up licence

`attachmentGc`, `rateLimitSweep`, `ciMinutesReconcile` and nine others declare
`retryPolicy: 'idempotent'`. That says a handler may safely run the SAME tick twice. It says nothing
about whether a tick that is now six hours **stale** is still worth running. The two are independent
axes and conflating them is how a sweep gets replayed against a world that has moved on: a fleet
provisioner is perfectly idempotent and still provisions against a fleet state that no longer exists.

**So every row below is justified by STALENESS, and no row cites a retry policy.**

### §11.3 — The discriminator: what does waiting for the NEXT fire cost?

A scheduled job's work is either **convergent** — re-derived from current state, so one run answers
for every fire it missed — or **per-fire**, owning a period or a cohort no later run will redo. All
fourteen of Motir's are convergent; each is a sweep over `WHERE <predicate on now>`. That collapses
the question to latency:

- The next scheduled fire is **imminent** (a minute away) and the missed work is convergent ⇒ the
  catch-up buys nothing measurable, and after a long outage it would fan out a burst against a
  batch-capped external call for the sake of that minute ⇒ **`skip`**.
- The next scheduled fire is an hour, a day or a month away ⇒ waiting is a real cost paid by a
  person or a bill ⇒ run it once, now ⇒ **`latest`**.
- Each fire owns work no later fire redoes ⇒ **`all`**.

### §11.4 — The table (one row per scheduled job)

The row set is derived from the registry, not transcribed: `engineScheduledJobs()` is the authority,
and `tests/jobs/engine-units.test.ts` fails when a job in it carries no disposition, so a fifteenth
cron job cannot ship without joining this table.

| job id                              | cron           | disposition | why — the staleness argument                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system.abandoned-plan-sweep`       | `0 * * * *`    | `latest`    | Reconciles `generating` plans from live state. One pass sees every plan six missed passes would have; the pause it lifts is hourly-grained.                                                                                                                                                                                                                                                                                                                                                                      |
| `system.attachment-gc`              | `30 3 * * *`   | `latest`    | A missed night is a night of un-collected orphans, and nothing else collects them — so it must not be skipped. One pass re-reads the whole orphan set; the cursor bound means a backlog drains across the following nights, which is the cadence the sweep was designed for.                                                                                                                                                                                                                                     |
| `system.auto-plan-cadence-tick`     | `30 * * * *`   | `latest`    | Every gate is re-derived per run, and a project that fired now holds an undecided plan, so replaying older fires is a guaranteed no-op. An hour of drained ready-set is worth one catch-up.                                                                                                                                                                                                                                                                                                                      |
| `system.automation-retention-sweep` | `30 4 * * *`   | `latest`    | A 90-day retention window is a commitment; a skipped day defers it by a day. The predicate is `expires_at < now`, so one pass covers the gap.                                                                                                                                                                                                                                                                                                                                                                    |
| `system.ci-actions-gate-sweep`      | `30 * * * *`   | `latest`    | The RESUME half has a deadline: GitHub drops a queued job that finds no runner after 24 h, and an org that topped up cannot re-meter while its Actions are off. An hour of that deadlock is exactly what the hourly cadence exists to bound.                                                                                                                                                                                                                                                                     |
| `system.ci-minutes-reconcile`       | `30 5 3 * *`   | `latest`    | Monthly. Skipping means the month is never audited. See §11.6 — the one job whose _correct_ disposition is `all`, and cannot be until it reads its fire instant.                                                                                                                                                                                                                                                                                                                                                 |
| `system.ci-runner-provision-sweep`  | `0,30 * * * *` | `latest`    | **Was `* * * * *` / `skip` until MOTIR-3314**, and the cadence was what justified the disposition: "the next fire is at most 60 seconds away" and "a six-hour outage would enqueue 360 rows" are both properties of a minute cron. At `0,30` the next fire is up to 30 minutes away and a six-hour outage owes 12 fires, so §11.3 lands on the other side. Convergent (`listRunnableIntentIds` reads the current pending set), and 30 minutes of a stranded intent is paid by whoever is waiting on a CI runner. |
| `system.ci-runner-reap`             | `0,30 * * * *` | `latest`    | Not `skip`, despite the ten-minute cadence: an orphaned container bills for every minute it survives, so after an outage the immediate reap reclaims spend the next fire would not. Reaping reads current orphans, so one pass suffices.                                                                                                                                                                                                                                                                         |
| `system.code-graph-offboard-sweep`  | `0 5 * * *`    | `latest`    | The retention window §14.5 commits to is the same class of commitment as the automation sweep's. A daily gap is a day of retention owed; one pass re-reads the whole due queue.                                                                                                                                                                                                                                                                                                                                  |
| `system.data-export-expiry-sweep`   | `30 5 * * *`   | `latest`    | The seven-day retention on a built personal-data archive is a promise made to the reader on the pane, and nothing else deletes the blob — so a missed night must not be skipped, it is a night of data we said was gone still sitting in the private bucket. One pass suffices because the predicate is `status = 'ready' AND expires_at <= now`, which covers every fire the outage swallowed.                                                                                                                  |
| `system.daily-health-check`         | `0 9 * * *`    | `latest`    | See §11.7 — the disposition interacts with the probe this job carries, and `skip` would make a routine restart across 09:00 report as a fault.                                                                                                                                                                                                                                                                                                                                                                   |
| `system.filter-subscription-tick`   | `0 * * * *`    | `latest`    | A worker back at 14:03 having missed the 14:00 fire delivers the 14:00 hour's digests correctly, because the handler scans the CURRENT UTC hour. The per-occurrence idempotency key collapses a duplicate. See §11.6 for what a catch-up cannot recover.                                                                                                                                                                                                                                                         |
| `system.job-run-reap`               | `0 6 * * *`    | `latest`    | A missed fire still owes its work, and what waiting for the next one costs is another day of the operator surface showing a dead run as `running` — the precise harm the job exists to end. One pass sees everything every missed pass would have, because the candidate set is defined by elapsed time rather than by the fire instant; replaying is free because a closed row stops matching `status = 'running'`.                                                                                             |
| `system.migrate-onboarding-sweep`   | `0,30 * * * *` | `latest`    | What it repairs is a person's wedged onboarding run, and it re-derives from durable state. Fifteen more minutes on top of an outage is paid by a user who is already waiting.                                                                                                                                                                                                                                                                                                                                    |
| `system.public-follow-digest-tick`  | `0 9 * * 1`    | `latest`    | Weekly, and the longest gap of any job here — a worker back on Tuesday having missed Monday's fire still owes that week's digest, and skipping it means a follower simply never hears about the week. Safe to catch up because the handler derives due-ness from each follower's own `lastDigestAt` rather than from the fire instant, and the per-occurrence key (`<followId>:<ISO week>`) collapses a duplicate at the runtime and at the provider.                                                            |
| `system.plan-target-lock-sweep`     | `0,30 * * * *` | `latest`    | A stranded lease holds an item NOBODY can plan, with no user-facing remedy. Ten minutes is the cadence that was chosen against exactly that cost; a catch-up honours it on restart.                                                                                                                                                                                                                                                                                                                              |
| `system.rate-limit-sweep`           | `0 4 * * *`    | `latest`    | Nothing else deletes a `rate_limit_counter` row. One pass; the per-run bound is deliberate ("a backlog drains over several days rather than locking a large slice of a hot table in one pass"), which is also why this is not `all`.                                                                                                                                                                                                                                                                             |

### §11.5 — Why `all` has no members today, and stays in the vocabulary anyway

**Fifteen `latest`, zero `skip`, zero `all`** (MOTIR-3314 moved the one `skip` — see its row; MOTIR-1115
added the weekly follower digest). That
is a finding, not an omission: **every scheduled job Motir has is a convergent sweep**, so N missed
fires and one missed fire have the same remedy. Naming
`all` for a job in that class would enqueue N rows that each recompute the same answer — cost with no
information.

The member is kept because the class it names is real and one job is one change away from joining it
(§11.6). Its criterion is written down so a future job can be classified rather than defaulted:
**a job takes `all` when a fire owns work no later fire will redo** — it closes a named period, drains
a cohort selected by its own fire time, or emits something a consumer counts per interval.

### §11.6 — What a caught-up run carries, and the one thing it cannot carry

A caught-up run is an ordinary `job_queue` row. Specifically (MOTIR-3469, MOTIR-3471):

- **`scheduled_for` is the FIRE instant, never the enqueue instant.** It is the per-tick key
  `@@unique([jobId, scheduledFor])` dedups on, which is what makes two workers ticking the same
  minute produce one run.
- **`run_at` is that same fire instant**, so a caught-up run is immediately claimable and the claim's
  `ORDER BY run_at` puts it ahead of anything enqueued since — oldest owed work first.
- **`event_name` is `scheduled.<job_id>`**, late or on time, so `jobScheduleHealthService` reads it
  with no change (§11.7).

**Can a handler tell it is late? Today: no — and that is a stated gap, not an oversight.** The engine
hands a cron run an empty payload (`scripts/worker.ts`'s `payloadFor` returns `{}` for a row with a
null `event_id`), so `scheduled_for` sits on the row and never reaches `ctx`. Every job in the table
is unaffected, because a convergent sweep does not need to know. **One job would be:**
`ciMinutesReconcile` derives its period from `previousPeriodStart(new Date())` — the month before
_now_, not the month before its fire. Inside a month that is identical and correct. Across a month
boundary it is not: a worker down from 3 September to 5 October reconciles September twice and never
audits August, and `all` would not save it — both rows would read the same clock. **The fix is to
give the handler its fire instant, not to change this job's disposition**, and it is deliberately out
of MOTIR-3416's scope: the story ends at the jobs firing on the engine, and this needs an outage
spanning a whole month to bite. `system.filter-subscription-tick` has the same shape one order of
magnitude down — it scans the current UTC hour, so a fire missed by more than an hour delivers the
wrong hour's digests — and the same remedy.

### §11.7 — What the schedule-health probe means after the cutover, and why `daily-health-check` catches up

`lib/services/jobScheduleHealthService.ts` is **unchanged by this decision**, and its meaning is not.

- Today it detects a **stale Inngest app registry**: a cron job that has stopped firing because the
  cloud's registered function list fell behind the deployed build (`docs/jobs.md` § Registration —
  five jobs dead for a month).
- For a job routed to the engine the same silence means **a dead worker or a stalled scheduler**.
  Same probe, same tolerance, different diagnosis. `docs/jobs.md` carries the operator-facing form.

**Its tolerance is what makes `latest` the right disposition for the probe's own host job.** `judge()`
holds a job to the fire BEFORE the most recent one, so exactly one missed tick is forgiven. With
`latest`, a worker that restarts after an outage enqueues the missed 09:00 fire, the probe runs, and
`lastRunAt` is stamped — the tolerance keeps meaning what it was designed to mean. With `skip`, a
routine restart spanning 09:00 would leave `system.daily-health-check` two ticks stale the following
day, and the probe's first act would be to **report itself overdue and dead-letter** — a fault report
manufactured by the catch-up policy rather than observed. A checker that fails because of how it is
scheduled is worse than no checker.

**There is no `skip` job any more (MOTIR-3314).** This paragraph read: _"The one `skip` job is
`system.ci-runner-provision-sweep`, whose tolerance is ~2 minutes: any outage long enough to matter
trips the probe whether or not the missed fire is replayed, so skipping costs the probe nothing."_
Both numbers came from the minute cadence. At `0,30 * * * *` the probe holds that job to the fire
BEFORE the most recent one, so its tolerance is ~60 minutes rather than ~2 — and with `latest` the
missed fire is replayed and `lastRunAt` stamped, which is the same property that makes `latest`
right for the probe's own host job in the paragraph above. The reasoning is unchanged; only the
job it was applied to has moved.

### §11.8 — Where the disposition is DECLARED: beside the cron, not in a second list

**Decided: a required `catchUp` option on `defineJob`, carried onto `EngineJobDefinition` by
`registerEngineJob`, typed so a definition supplying `cron` cannot omit it and an event-triggered
definition cannot supply it.**

This repository has already made this argument twice and both times in the file that would have
drifted. `lib/jobs/schedules.ts`: _"a hand-maintained array is a second source of truth that a new job
forgets to join."_ `lib/jobs/engine/registry.ts`: _"Two lists drift; one list cannot."_ `defineJob` is
the single choke point every job passes through, so a declaration there is complete **by
construction** — the same property the schedule table and the engine registry already depend on.

**No default.** A default is precisely how a cron job added next year inherits a disposition nobody
chose for it, which is the failure this section exists to prevent, one turn of the crank later. The
type is what enforces it; `tests/jobs/engine-units.test.ts` asserts it at run time as well, walking
`engineScheduledJobs()` rather than a transcribed list of fourteen — the enumeration that was already
wrong once (§8: the count read FILES, and `ciRunnerFleet.ts` declares two).

**Rejected: a `Map<jobId, CatchUpPolicy>` beside the scheduler.** Cheaper to write, and a second list
by construction: a new cron job compiles, registers, schedules and fires without ever appearing in it,
and the omission surfaces only as an unexplained replay after the next outage.

**Rejected: reading the disposition from the ADR.** A policy whose only home is a document is a policy
nothing enforces. This section is the REASONING; the code is the record.

### §11.9 — What §11 does not settle

- **The scheduler's own placement and start-up guard** are MOTIR-3471's (the worker process, beside
  the claim loop; a refusal to start against an empty registry).
- **The production flip** — which ids are actually in `MOTIR_POSTGRES_JOB_IDS` — is an operator action
  and a property of the deployment. Nothing here transcribes it.
- **A job's own schedule.** ~~No cron expression changes; MOTIR-3416 asserts the fourteen constants
  against their shipped values. The wake-cost argument in `ciRunnerFleet.ts`'s
  `CI_RUNNER_REAP_CRON` comment (fourteen distinct wake-minutes on a suspend-when-idle compute) is a
  separate work item and is not weighed here.~~ **DISCHARGED by MOTIR-3314**, which is that separate
  work item. Every `system.*` expression is now clustered onto `SCHEDULE_CLUSTER_MINUTES` (`{0, 30}`,
  `lib/jobs/schedules.ts`), leaving a longest quiet gap of **30 minutes** against a suspend delay
  observed at ~9 min. §11.4's table moved with the code and is still asserted against it by
  `tests/jobs/engine-units.test.ts`; the GAP is asserted separately by
  `tests/jobs/schedule-cluster.test.ts`, so a fifteenth job cannot re-open it. The trade each job
  made is argued at its own constant, and the duty-cycle arithmetic lives in
  `docs/decisions/application-hosting.md` §21. **The clause is struck rather than deleted** because
  §11's own catch-up reasoning was written against the old cadences, and a reader who finds a
  disposition surprising should be able to see that the schedule under it moved.

## §12 — How the EMIT PATH learns the subscriber set: a data-only manifest, not a side-effect import (MOTIR-3455)

> **Numbered §12, not §11.** This section was authored as §11 against a tree whose last section was
> §10, and MOTIR-3468's catch-up policy took that number first by merging first. Renumbered on the
> merge rather than renumbering the section already on `main`, and recorded here because a citation
> of "§11" written before 2026-08-26 may mean either one.

- **Amends this record.** §4 and §8 name the dispatcher and the registry without settling this.
- **Evidence pinned at:** `motir-core` `origin/main` @ `18d60791`.
- **Consumed by:** MOTIR-3458 (the implementation + its guard), MOTIR-3416 (which inherits the
  answer for `lib/jobs/schedules.ts` rather than re-deriving it).
- **Ships no behaviour.** This section decides a shape. The code change is MOTIR-3458's.

### The defect

`dispatchEventToEngine` resolves its fan-out with `engineSubscribers(name)`, which filters the
module-level `Map` in `lib/jobs/engine/registry.ts`. `registerEngineJob` fills that `Map` from
inside `defineJob`, so **it holds only the jobs whose definition MODULE has been evaluated in this
process.** `registry.ts`'s own header says so, and points at `schedules.ts` as the precedent.

`lib/jobs/sendEvent.ts` imports exactly `./client`, `./types` and `./engine/dispatcher`; the
dispatcher imports `./engine/registry`. **Nothing in that graph reaches a definition module.** So
on a Next.js request path `engineSubscribers` returns `[]`, `dispatchEventToEngine` returns early
without writing a `job_event` row, `hasInngestSubscribers` returns its documented safe default
`true`, `inngest.send()` fires — and for a job whose id IS in `MOTIR_POSTGRES_JOB_IDS`,
`defineJob`'s Inngest handler returns `{ skipped: 'routed-to-postgres-engine' }`.

**The event runs on neither lane, silently.** No error, no fallback, no log. That is a worse
failure than the latency MOTIR-3413 was filed to fix, and it would surface weeks after a cutover as
notifications that stopped arriving.

### Why every existing signal is green

- **The dispatcher suite** carries `import '@/lib/jobs/registry';` at `tests/jobs/engine-dispatcher.test.ts:24`,
  with a comment explaining that it is there for its side effect. That import makes the registry
  complete inside the test process by a route no production request takes.
- **The E2E lane** runs `inngest-cli dev -u http://localhost:${PORT}/api/inngest --no-discovery`
  (`playwright.config.ts:437`). The sync evaluates the serve route — and therefore
  `lib/jobs/registry.ts` — inside the same Next server process the specs then drive.
- **In production neither happens.** The serve route is evaluated only on a machine Inngest has
  synced against, and `fly.toml:118` sets `min_machines_running = 2`.

### The options, and what each costs `lib/jobs/schedules.ts`

`schedules.ts` carries the identical caveat in its own header ("COMPLETENESS DEPENDS ON IMPORT"),
and `jobScheduleHealthService` is its one reader today. MOTIR-3416's scheduler will be its second,
on the same emit-side footing — so each option is priced for both tables, not just the engine's.

**(a) Side-effect import** — add `import '@/lib/jobs/registry';` to `sendEvent.ts` or the
dispatcher. One line. Fixes `schedules.ts` at the same time and at no extra cost, because the same
import populates both `Map`s.

**(b) A data-only subscriber MANIFEST** — split registration so the emit path reads only
`{ id, trigger, cron, maxAttempts }` and never `handler`. The manifest module imports no services,
so importing it eagerly from `sendEvent` is cheap and acyclic. The worker keeps importing the full
registry for the handlers it must execute. `cron` rides the same record, so `schedules.ts`'s reader
can move to the manifest and inherit the fix.

**(c) A database-backed subscriber table**, written at deploy or boot. Removes the import question
entirely, at the cost of a read on the emit path and a table that can go stale against the deployed
code. It would fix `schedules.ts` only by giving it a second staleness surface.

### The measurement that settled it

MOTIR-3455 required option (a) to be **measured rather than argued**. It was, by building the app
with the side-effect import present and absent, from the same clean `.next`, on the same machine:

|                | baseline (`18d60791`)   | (a) STATIC `import '@/lib/jobs/registry'` in `sendEvent.ts` | (b) AS BUILT — dynamic load on the emit path |
| -------------- | ----------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `next build`   | **succeeds** (`EXIT=0`) | **FAILS** (`EXIT=1`)                                        | **succeeds** (`EXIT=0`)                      |
| compile        | 22.0 s                  | 30.0 s                                                      | 28.9 s                                       |
| `.next/server` | 198 485 126 B           | 377 079 602 B (**+178.6 MB, +90.0 %**)                      | 299 731 544 B (**+101.2 MB, +51.0 %**)       |

The third column was measured after MOTIR-3458 landed and is recorded here rather than left in a
pull-request body, because a record whose only measurement is of the REJECTED option tells a later
reader nothing about what the accepted one cost. **(b) is not free** — it is half of (a)'s growth,
in a split chunk rather than inlined into every emitting route, and it builds.

The failure is not incidental and not a flake:

```
✓ Compiled successfully in 30.0s
ReferenceError: Cannot access 'e5' before initialization
> Build error occurred
Error: Failed to collect page data for /api/_test/work-item-links
```

**That is the import cycle closing, observed as a temporal-dead-zone error.** The cycle is:

```
sendEvent.ts → lib/jobs/registry.ts → lib/jobs/definitions/* → defineJob.ts
             → lib/jobs/services.ts → lib/services/workItemsService.ts → sendEvent.ts
```

**Nine of the services in `defineJob`'s injected bag import `sendEvent`** — `workItemsService`,
`usersService`, `watcherNotificationsService`, `mentionNotificationsService`,
`automationEngineService`, `workspaceInvitesService`, `savedFilterSubscriptionsService`,
`parentStatusRollupService` and `childStatusCascadeService` — so the cycle is not reachable by one
unlucky path, it is the normal one.

**The route named in the error is where page-data collection reached the cycle first, not a
property of that route.** `app/api/%5Ftest/work-item-links/route.ts` imports `workItemsService`; so
do **42** other route and page modules under `app/`, four of them server-action files. Any of them
closes the same cycle.

### The decision

**Option (b), the data-only manifest.** The measurement did not merely fail to contradict the
recommendation — it removed (a) from the table entirely: an option that does not build is not a
simpler option, and the 90 % server-bundle growth would have been a reason to decline it even had
it built.

Two independent supports, recorded because the measurement alone would date badly if the cycle were
ever broken for unrelated reasons:

- **Rung 2 — the emit path already needs no handler.** `dispatchEventToEngine` reads only `sub.id`
  and `sub.maxAttempts`; `hasInngestSubscribers` reads only `id` and `trigger`.
  `EngineJobDefinition.handler` is the one field that drags the service graph in, and it is exactly
  the field neither emit-path caller touches. (b) is not a new abstraction — it is the split the
  existing call sites already imply.
- **Rung 1 — the mirror.** Inngest resolves an event's subscribers server-side from a function
  manifest synced at deploy; the emitting process sends a name and a payload and knows nothing about
  who consumes it. A manifest is the mirror product's shape, not an invention.

**(a) is rejected on the measurement above.** **(c) is rejected on the reasoning
`lib/jobs/engine/cutover.ts` already records for the routing set**: a cached or replicated view of
the deployed code's shape can go stale, and stale here means a job running on both engines or on
neither — the one outcome the switch exists to prevent.

**For `lib/jobs/schedules.ts`: MOTIR-3416 did NOT need this, and the prediction below was wrong in a
way worth recording rather than deleting.**

> ⚠️ **Corrected on the merge (2026-08-26).** This paragraph predicted that the scheduled story would
> take the manifest too. It did not, and it was right not to: the reachability problem is a property
> of the EMIT PATH, and a scheduler is not on one. `JobScheduler` runs inside the worker, which
> imports `lib/jobs/registry.ts` for its handlers anyway, so `engineScheduledJobs()` is already
> complete there and no manifest is needed. `manifestScheduledJobs()` survives as the manifest's own
> partition helper — the story gate asserts the cron and event-triggered halves add up — and is
> deliberately NOT the scheduler's source.
>
> The general shape, which is the part worth keeping: **this whole section is about a table read from
> a process that did not load what fills it. A consumer that already loads the definitions has no
> such problem, and giving it the manifest anyway would be a second door for no reason.**

The original prediction, left for the record: The
manifest carries `cron`, so a scheduler reading the manifest gets the same completeness property
from the same source. MOTIR-3458 is not obliged to migrate `schedules.ts` — its scope is the emit
path — but if the manifest makes that free, it should take it and say so.

### The risk this decision accepts, named

**A manifest that `defineJob` does not populate is a second list, and this record has already
argued twice that two lists drift** (`registry.ts`'s header, and §8's enumeration correction). The
mitigation is not vigilance: **the manifest MUST be registered from inside `defineJob`**, the single
choke point every job passes through, exactly as `registerEngineJob` and `registerSchedule` already
are. A hand-authored manifest file would reintroduce precisely the defect this section exists to
close, in a form that is harder to see because it would look complete.

**That property is not self-enforcing at the module level**, which is why MOTIR-3458 owes a guard
that builds the two subscriber sets from **different module graphs** and asserts they are equal. A
guard that derives both from one import cannot fail, and the absence of such a guard is what let
this defect ship green.

### ⚠️ How the manifest is LOADED — corrected against what MOTIR-3458 found

**This section originally said the manifest would be "imported eagerly from `sendEvent`". It is
not, and the correction is recorded rather than quietly applied**, because the eager form is the one
a reader re-derives from the paragraphs above and it does not survive contact with the code.

A manifest is complete only in a process that has EVALUATED the definition modules, so something has
to evaluate them on the emit path. Two ways to make that affordable were tried, and only the second
works:

1. **Defer `defineJob`'s OWN service import** — `await import('./services')` inside the handler, so
   the definitions become cheap to evaluate and a static import of the registry becomes viable. It
   does break the cycle. **It also breaks `@inngest/test`:** four `system.daily-health-check` tests
   in `tests/jobs/schedule-health.test.ts` go red with the job returning `undefined`, because the
   harness cannot tolerate a dynamic import inside a job handler. It fails identically with the
   import at the top of the handler and with it placed after the first `step.run`. **Rejected on
   that evidence**, and `defineJob`'s handler is left byte-for-byte as it was.
2. **Defer the LOAD ITSELF, on the emit path** — `lib/jobs/engine/subscribers.ts` holds a memoised
   `ensureJobManifestLoaded()` whose `import('@/lib/jobs/registry')` is dynamic, and
   `dispatchEventToEngine` awaits it before resolving subscribers. **This is what shipped.** A
   dynamic import is not a module-evaluation edge, so nothing sits in a temporal dead zone and the
   bundler splits the definitions into their own chunk instead of inlining them into every route
   that emits. No job handler is involved at all.

**⚠️ AND THE LOAD IS SKIPPED ENTIRELY UNTIL A JOB IS ACTUALLY ROUTED — a correction this record
owes, because the table above priced the BUILD and the bill actually arrives on a REQUEST.**

Emitting is post-commit on a request path and `workItemsService.createWorkItem` AWAITS it, so
whatever the deferred load costs lands inside a user's mutation. Measured after MOTIR-3458 first
shipped, in a fresh process:

|                                               |             |
| --------------------------------------------- | ----------- |
| first `dispatchEventToEngine`                 | **6224 ms** |
| second                                        | **0 ms**    |
| `lib/jobs/engine/manifest.ts` alone           | 3 ms        |
| `lib/jobs/registry.ts`, services already warm | 158 ms      |
| **`lib/jobs/services.ts` alone**              | **8808 ms** |

**The bill is the SERVICE BAG, exactly as this section predicted — and option (b) as first built still
paid it**, because the manifest was populated by loading the whole registry and the definitions reach
the bag through `defineJob`. Being handler-free bought the build, not the request. CI said so before
anyone read it: `tests/integration/work-items/revisions.test.ts` went red on a one-second freshness
window it had always met (`expected 1437 to be less than 1000`), and the failure reproduces locally
with the fix removed (`expected 4000 to be less than 1000`).

**The remedy is not to make the load cheap or early, but to notice it is not needed.** The subscriber
set exists only to be filtered by `routedToEngine`, so when `MOTIR_POSTGRES_JOB_IDS` is empty the
answer is _enqueue nothing_ whatever the manifest holds. `dispatchEventToEngine` therefore returns
before loading anything when the routing set is empty — which is not an optimisation of a correct
path, it IS the correct path one step earlier. **Before any job is cut over — the state of every
deployment today, and of every test that does not set the routing set — the emit path pays nothing.**
The load happens on the first emit AFTER an operator routes a job, which is the one moment it is
needed at all, and it is memoised from then on. `ensureJobManifestLoaded` also returns immediately
when the manifest is already populated, which covers the worker, the serve route and the nineteen
test files that import the registry themselves.

**Two things a future reader should NOT re-derive, both tried and both rejected on evidence.**

- **Warming the load eagerly.** Starting it during `subscribers.ts`'s own module evaluation, and then
  from a `setTimeout(0)`, each re-entered a module graph that was still initializing — vite-node
  resolves imports through promises, so even a macrotask interleaves with graph evaluation — and
  eleven job suites failed to load with `ReferenceError: Cannot access '__vite_ssr_import_3__' before
initialization`. The same temporal-dead-zone shape as the build failure above, one level down.
- **Making `defineJob` stop importing the bag.** Also breaks the cycle, and breaks `@inngest/test`:
  four `system.daily-health-check` tests return `undefined`, with the import both at the top of the
  handler and after the first `step.run`. The bag reaches the definitions through the one choke point
  every job passes through, and that is where it belongs.

**One ordering consequence, and it is load-bearing.** `hasInngestSubscribers` is synchronous and
cannot await the loader, so it is correct only because `sendEvent` dispatches to the engine FIRST
and asks about Inngest second. That ordering is asserted by the reachability guard rather than left
as a comment.

### One enumeration correction MOTIR-3455 should carry

**MOTIR-3455's evidence block states that `git grep -l "@/lib/jobs/registry'"` at `b944dab5`
returns three files. At that ref it returns nineteen.** Re-measured on the ref the card itself
names, and again at `18d60791`, where the count is also nineteen — so this is an enumeration that
was wrong when written, not drift since.

Two of the nineteen are non-test — `app/api/inngest/route.ts` and `scripts/worker.ts` — and those
two are the load-bearing fact the card's conclusion rests on. **The conclusion is unaffected and
stands:** no module on any production emit path imports the registry. The other seventeen are all
under `tests/`, and they make the "why nothing caught it" argument _stronger_ rather than weaker —
seventeen suites evaluate the definition modules in their own process, so a great deal of the
job-suite's greenness is measured on a module graph production never has.

Planning bug filed under MOTIR-1465.

## §13 — What a supervision loop keeps as a durable STEP, and what it may spend as a plain `await` (MOTIR-3482)

**Amendment, 2026-08-26.** §1–§10 chose a foundation, §11 settled what a missed cron tick does and
§12 settled how the emit path finds its subscribers. This settles the question the container
supervisors raise and no other job does: **when the worker process dies half an hour into
supervising a running container, what is the handler allowed to have forgotten?**

It is asked now because [MOTIR-3417] deletes the stepped shape those loops were written in. That
shape exists for a reason that has expired — `app/api/inngest/route.ts` pins `maxDuration = 300`,
and `lib/jobs/indexFleetSteps.ts` says in its own words that _"A STEP, NOT A RUN, IS THE UNIT THE
PLATFORM'S TIMEOUT APPLIES TO, so the WAITING is `ctx.step.sleep`"_. `Dockerfile` ends
`CMD ["node", "server.js"]` and the worker is its own long-lived Fly process group, so that ceiling
binds nothing any more. **But the ceremony and the durability are the same `ctx.step` calls**, so
"delete the ceremony" is not an instruction anyone can follow until the line between them is drawn
once, in one place, for both loops.

### §13.1 — The rule

> **A supervision loop's durable boundary is the SIDE EFFECT, never the WAIT.**
>
> 1. **`step.run` wraps every operation that PROVISIONS, CLAIMS or TEARS DOWN something outside
>    this process** — anything whose second execution would leave a second thing existing: a
>    container, a registered runner, a capacity slot, a destroyed machine, a metered usage row.
> 2. **`step.run` ALSO wraps a result that later steps are KEYED BY**, so a resume cannot re-point
>    them at different work. This limb is not about repetition cost; it is about identity.
> 3. **Everything else is ordinary control flow** — the interval between polls, the poll itself,
>    the loop counter, the classification of what came back, the waiting inside a backoff. A plain
>    `await` in a plain `while`.
> 4. **A step id still names the UNIT OF WORK, never a loop position.** That rule survives the
>    collapse unchanged and matters more afterwards, because there are far fewer step ids left and
>    each one carries more.
>
> **The test to apply to a step you are about to delete: _if this ran a second time, what would
> exist twice?_** A container, a runner registration, a slot, a usage row ⇒ keep the step. A wait,
> a read, a counter, a verdict ⇒ drop it. **If the answer is not obvious, KEEP the step** — one
> extra `job_step` row is a bounded cost and a duplicated external effect is not.
>
> **And the corollary for everything dropped: a restart forgets it.** So _no verdict may depend on
> the ABSENCE of an in-memory observation._ Either re-derive the observation from the source (the
> happy path in `pollIndexContainer` already does — `if (status.startedAt && !startedAt) …`), or
> gate the verdict on positive evidence. A branch that reads "we have not seen it start" is, after
> the collapse, indistinguishable from "we have forgotten that we saw it start."

### §13.2 — Why this is safe, read off the worker rather than assumed

The rule is only defensible because of what `lib/jobs/engine/worker.ts` actually does, and each of
these is a property of that file rather than a hope about it:

- **A long run is the NORMAL case.** A claim carries a lease (`LEASE_MS` = 60 s) renewed by a
  heartbeat every `RENEW_MS` = 20 s — a 3× margin, so two consecutive missed beats are needed
  before a live worker looks dead. The header says so outright: _"a run legitimately longer than
  the lease is the normal case, not the exception (the container supervisors sleep for half an
  hour)."_ **So an in-memory wait needs no `step.sleep` to survive a live worker.** The heartbeat
  is what distinguishes a long run from a dead one; nothing about duration alone can.
- **A reclaim re-invokes the handler FROM THE TOP.** `lib/jobs/engine/runner.ts`'s `runQueuedJob`
  builds a fresh context and calls `def.handler`; `createStepApi` in `lib/jobs/engine/step.ts` then
  serves each `step.run` from `job_step` when a row exists. So a memoized step is what makes
  re-entry cheap, and an un-memoized side effect is what makes it dangerous. That asymmetry IS the
  rule.
- **Both attempt refunds are real.** `jobQueueRepository.reclaimExpiredLeases` and
  `releaseClaims` both write `"attempts" = GREATEST("attempts" - 1, 0)`, so a worker death and a
  graceful drain each cost zero attempts. A supervisor may therefore be restarted repeatedly
  without eating a retry budget — which is what makes `retryPolicy: 'none'` on
  `system.ci-runner-boot` survive a deploy (§13.4).
- **The cross-pass identities survive.** `buildEngineContext` sets `event.id` from `run.eventId`
  and `runId` from the queue row's id — both stable for the life of the run — so
  `dispatchId = ctx.event.id ?? ctx.runId` (`indexFleetSteps.ts`, MOTIR-2160) names the same
  dispatch on every pass.
- **The wall clock is anchored to the SESSION, not to the loop.** `pollIndexContainer` computes
  `elapsed` from `session.bootedAt`, a field on the memoized boot result, so `indexTimeoutMs`
  (1 800 000) keeps bounding a container across a restart. `ciRunnerBootService`'s `jobTimeoutMs`
  (3 600 000) is anchored the same way.

**And the option this rejects, with its reason on the record: keeping everything durable.** It is
correct, and it is what the engine gives for free — but on our engine a `step.sleep` is not free
the way Inngest's was. Each one is a `JobStepYield`, a re-enqueue, a re-claim by some worker and a
replay of the handler from the top, during which every earlier step is re-read from `job_step`. A
loop that polls _N_ times therefore performs on the order of _N²_ memo lookups and 2*N* row writes;
`indexFleetSteps.ts` counts the shipped figure at _"roughly 128 sub-second steps"_ per 30-minute
index. Porting that shape would move the cost from a platform we no longer pay onto a database we
do. **The option at the other extreme — nothing durable at all — is rejected outright:** a restart
would re-execute the boot, which provisions a SECOND billed container and takes a second admission
slot, which is the exact failure the whole fleet is built around not having.

### §13.3 — The three consequences, each disposed of

**(a) The poll ITERATION counter restarts, so `maxPollIterations` stops bounding TOTAL polls per
container. ACCEPTED — the ceiling was never the real bound, and the real one survives.**

`INDEX_FLEET_TIME_BUDGETS.maxPollIterations` is 500 and `FLEET_TIME_BUDGETS.maxPollIterations` is
2 000, and both files already say what they are for: _"not the bound that matters — it is the bound
that still holds if the clock does something surprising."_ The bound that matters is the wall clock,
and §13.2 shows it is anchored on the memoized `session.bootedAt` rather than on the loop. So after
a restart the FIRST poll of the new pass re-evaluates `elapsed` from the original boot instant, and
a container already past `indexTimeoutMs` settles immediately rather than being watched for another
500 polls.

What the ceiling becomes is a **per-pass runaway guard**, and it should be described that way in
the code rather than silently demoted. **Deriving the count from elapsed time instead is refused**:
it would make the guard depend on the very clock it exists to be independent of.

The residue, stated rather than hidden: total polls across a run are bounded by
_(number of restarts) × (polls until the deadline)_, so an unbounded restart loop is unbounded in
poll count while remaining bounded in container lifetime. That is acceptable because a worker that
cannot survive one supervision is a worker-level fault an operator sees, and because every one of
those polls is a read — under §13.1's test, nothing exists twice.

**(b) The `catch`-arm `startedAt` read. FIXED, not accepted — and the fix is the third option:
the failed-read arm may not reach a BOOT-deadline verdict at all.**

Today `pollIndexContainer`'s `deadlineVerdict` is consulted from both the happy path and the
provider-read `catch`, and its first arm is `if (!startedAt && elapsed >= bootDeadlineMs)` →
`provision_failed` / `never_started`. On the happy path that is sound, because `startedAt` has just
been re-derived from the provider's own status. In the `catch` arm there is no successful read, so
`!startedAt` means _either_ "the container never started" _or_ "this pass has not managed to ask
yet" — and after the collapse the second reading becomes reachable at any elapsed time, because a
restart resets the in-memory value. A container running healthily for twenty minutes, met by a
reclaim and one failed provider read, would be classified `never_started`.

**The disposition is §13.1's corollary applied literally: a boot-deadline verdict requires positive
evidence, so it may only be reached from a SUCCESSFUL read.** The failed-read arm evaluates the
overall `indexTimeoutMs` bound only — which depends on `session.bootedAt` and not on any in-memory
observation, and which still guarantees that an unreadable provider can never extend a container
past its timeout. Teardown is unaffected: both arms still return a `done` verdict, so the only exit
remains `settleIndexContainer`.

Two notes on scope. This is a latent defect **today**, not one the collapse introduces: a first
read failing at `elapsed > bootDeadlineMs` on a slow-but-live boot misclassifies on the shipped
code too. What the collapse changes is how often the second reading is reachable. And the fix is
owned by [MOTIR-3484], which is the card that edits that file; the CI fleet's `pollContainerOnce`
is to be read for the same shape by [MOTIR-3485].

**Persisting the observed `startedAt` as a memoized step was considered and REJECTED.** It reads as
the obvious fix and it is a trap of exactly the kind this record exists to catch: a `step.run` with
a fixed id memoizes its FIRST answer forever, so `index-started:<projectId>` observed before the
container started would pin `null` for the life of the run — the same defect as a single
`index-admit:<projectId>` freezing a `deferred` verdict, which is why that id carries an attempt
number today.

**(c) A reclaim re-asking ADMISSION. SAFE, and read rather than assumed.**

`codeGraphIndexAdmissionService.admit` opens by resolving `slotRef = indexSlotRef(projectId,
repoRef)` and calling `slots.findByRef(...)`; when a row exists it returns `heldVerdict(held,
slotRef, request.dispatchId)`. `heldVerdict` compares `held.ownerRef` with the asking
`dispatchId` and — **when they match — returns `{ outcome: 'already_held', admission }`**, an
`IndexAdmission` ticket carrying the existing `slotRef` and its original `admittedAt`. A different
holder gets `{ outcome: 'deferred', reason: 'repo_index_in_flight' }` instead. Since §13.2 shows
`dispatchId` is stable across passes, **a resumed run re-asking admission recovers its own slot
rather than taking a second one**, and `bootIndexContainer` accepts that ticket exactly as it
accepts a fresh `admitted` one — both arms of `waitForAdmission`'s return type already are
`'admitted' | 'already_held'`.

**But there is an ORDERING obligation that follows from it, and it is the non-obvious half.** The
admission ask must sit INSIDE a memoized step, not before one. If the backoff loop becomes a plain
`await` while the boot stays memoized, then a resume that lands **after** the settle step has
already released the slot would re-ask admission, be granted a FRESH slot, replay the boot and the
settle from their memos, and never release the new one — a slot leaked until its TTL, on a path
where nothing looks wrong. **So `waitForAdmission` collapses into ONE memoized step of its own
(`index-admit:<projectId>`, the backoff loop inside it) rather than into the surrounding
control flow.** It is a CLAIM under §13.1's first limb, and the fact that it also happens to
contain a wait does not move it.

### §13.4 — Applying the rule: the disposition of every `ctx.step` call in the two loops

Recorded per call site so [MOTIR-3484] and [MOTIR-3485] apply a decision rather than re-derive one.

| loop  | today's step                 | disposition           | why                                                                                                                                                                                   |
| ----- | ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| index | `resolve-target`             | **KEEP**              | limb 2 — its `projectIds` are the identity every later step is keyed by; a re-read could re-point the fan-out mid-run                                                                 |
| index | `assert-fleet-configured`    | **DROP**              | a read of process configuration that throws; a second evaluation leaves nothing behind                                                                                                |
| index | `index-admit:<pid>:<n>` ×60  | **KEEP, as ONE step** | a CLAIM (limb 1), with the backoff loop inside it — §13.3(c)'s ordering obligation. The per-attempt ids go: they existed only so Inngest would not freeze the first `deferred` answer |
| index | `index-admit-wait:<pid>:<n>` | **DROP**              | a wait                                                                                                                                                                                |
| index | `index-boot:<projectId>`     | **KEEP**              | provisions a container — the canonical limb-1 case                                                                                                                                    |
| index | `index-wait:<pid>:<n>`       | **DROP**              | a wait                                                                                                                                                                                |
| index | `index-poll:<pid>:<n>`       | **DROP**              | one provider read and a classification                                                                                                                                                |
| index | `index-settle:<projectId>`   | **KEEP**              | tears down, meters, and releases the slot                                                                                                                                             |
| index | `cancel-offboarding`         | **KEEP**              | a write; and the run's last act, so a resume past it should not re-touch the offboarding queue                                                                                        |
| CI    | `boot-runner`                | **KEEP**              | admits, claims, mints a JIT registration and provisions — four limb-1 effects in one operation                                                                                        |
| CI    | `supervise-wait:<n>`         | **DROP**              | a wait                                                                                                                                                                                |
| CI    | `supervise-poll:<n>`         | **DROP**              | one provider read                                                                                                                                                                     |
| CI    | `settle-runner`              | **KEEP**              | tears down, de-registers the runner, meters, and settles the intent                                                                                                                   |

**Two properties that must SURVIVE the collapse with a different mechanism, and must be re-proven
rather than inherited:**

- **Teardown is reached on every path out of the loop.** It is currently a step reachable from both
  exits precisely because a `finally` could not be trusted across invocations. On a long-lived
  worker an ordinary `try`/`finally` is trustworthy again — and the guarantee changes mechanism, so
  it needs a test per exit path (a `done` verdict, the iteration ceiling, a throw from inside the
  loop) rather than the old comment.
- **`system.ci-runner-boot`'s single attempt.** `retryPolicy: 'none'` is a correctness decision —
  a retry re-enters from the top — and it survives a restart only because of the refund quoted in
  §13.2. **A worker restart mid-supervision does NOT consume it**; a genuine handler failure does.
  That is the one job in the tree where the difference between a reclaim and a failure is the
  difference between resuming and dead-lettering, so [MOTIR-3485] asserts it against the worker's
  real reclaim path rather than citing this paragraph.

### §13.5 — What this does NOT settle

- **Whether the supervisors move to the engine at all.** [MOTIR-3417] settled that.
- **The debounce.** Its own sibling; §9's rejected-pg-boss note is the decision it implements.
- **The admission cap and `lib/ciFleet/limits.ts`.** [MOTIR-3417] forbids touching either, because
  container admission is a different resource and a regression there costs money.
- **Any change to a poll cadence, a backoff or a budget.** Every value in
  `INDEX_FLEET_TIME_BUDGETS`, `INDEX_ADMISSION_BUDGETS` and `FLEET_TIME_BUDGETS` is unchanged by
  this rule; it moves where durability lives, not how long anything waits.

## §14 — The engine does NOT enforce per-job concurrency, and the type is what says so (MOTIR-3731)

[MOTIR-3418] removed `defineJob`'s `concurrency` option rather than porting it, on the evidence
that no job declared one. That evidence was a **count of a population that was still moving**:
[MOTIR-3701] landed `account/data-export.requested` carrying
`concurrency: { limit: 1, key: 'event.data.userId' }` between the measurement and the merge, so
for the window in between the substrate accepted a field the engine had never read. The option is
gone now; the QUESTION it left is what this section answers, because otherwise the next job to
want one finds a deletion and no reasoning.

**The question: should `job_queue` grow a per-job, event-keyed concurrency limit enforced at CLAIM
time — at most N runs of job X in flight per key?**

### §14.1 — The decision: NO — and it is a decision about WHERE a limit lives, not about whether serialisation is wanted

**The queue is the wrong place to express "one at a time per key", and the engine will not grow an
option for it.** Serialisation is a legitimate and recurring requirement, and §14.3 is a table of
the four places this repository already expresses it. What is refused is the specific mechanism —
an admission decision taken inside the claim.

**The refusal is carried by the TYPE, not by this paragraph.** `DefineJobOptions` declares no such
member, and `tests/jobs/defineJob-options-are-read.test.ts` asserts that **every option the type
declares is read by something** — by `defineJob`'s own body, or by a module it hands the whole
options object to. So the failure mode this section is named after cannot come back as a
forwarded-and-ignored field. That guard is deliberately about the PROPERTY (an accepted option
nobody reads) rather than about the word `concurrency`: a ban on the word would pass while the
next such option shipped under a different name.

### §14.2 — Why not, in the order the reasons actually weigh

**1. The one place this org has shipped this mechanism, it wedged.** `motir-ai`'s planning queue
does exactly what is proposed here: `claimNextQueued` skips any job whose `concurrencyKey` has a
`running` row, with `concurrencyKeyFor` deriving `session:<aiProjectId>:<scopeKey>`. The
consequence is recorded in `docs/decisions/application-hosting.md` Amendment 7 (_"The remedy,
decided"_): **one abandoned `running` row wedges every future job of that planning session,
permanently** — no poll interval reaches it, because the predicate excludes it at every tick for
ever. That is not an argument that the shape is unimplementable; it is the measured cost of the
liveness obligation it creates. `job_queue` would discharge that obligation better than `motir-ai`
does — `reclaimExpiredLeases` bounds an abandoned claim to `LEASE_MS` rather than to for ever — but
**the obligation is the feature**, and it is new surface area on the one path the engine cannot
afford to be subtly wrong on.

**2. The claim is the engine's hottest statement, and its shape is asserted rather than assumed.**
`jobQueueRepository.claimDueRuns` is one `UPDATE … FROM (SELECT … ORDER BY run_at FOR UPDATE SKIP
LOCKED LIMIT n)`, and `tests/jobs/engine-schema.test.ts` pins its plan to
`job_queue_state_run_at_idx` with **no `Sort`** — an assertion, not a comment. A keyed limit is a
correlated anti-join against the running set, evaluated per candidate row inside the lock, and
that is precisely the predicate that takes the ordering off the index. The `ORDER BY run_at` is
not a nicety: it is what makes the queue fair.

**3. Head-of-line blocking is the semantics, not a detail.** A blocked keyed row is by
construction the OLDEST due row, so it is the first thing the `LIMIT` reaches. Skip it and the
batch silently shrinks — one hot key starves a batch shared by every other job; apply the `LIMIT`
after the filter and the claim scans an unbounded prefix of the queue under a row lock. Both are
defensible, they behave completely differently under load, and **there is no consumer to calibrate
the choice against.** Picking one on taste is how a fairness property ends up decided by whoever
happened to write the query.

**4. The demand does not exist — and this time the count is taken on a ref.**
`git grep -nE '^\s*concurrency\s*:' origin/main -- lib/jobs` returns **nothing**: no definition
declares one. Every occurrence of the word under `lib/jobs/definitions/` is prose, in four files,
three of which (`codeGraphIndex.ts`, `codeGraphRefresh.ts`, `dataExportBuild.ts`) exist to explain
why that job deliberately has none. **Unlike the measurement [MOTIR-3418] relied on, nothing here
rests on that staying true**: the guard in §14.1 fires on the DECLARATION, whenever it arrives.

**5. What bounds concurrent work is now ours, which removes the pressure the option existed under.**
`docs/decisions/job-lane-occupancy.md` §3 measured a vendor-account ceiling of **five concurrent
steps, partitioned by nothing** and shared by every function — the arithmetic in which a single
status change occupied four of five slots. Under `job_queue` the ceiling is the `worker` process
group's machine count times `CLAIM_BATCH`, both of which this repository sets. **A per-job limit is
a way to protect a pool you cannot resize; that is not the pool we have.**

### §14.3 — What a job should reach for instead

Ordered by strength, which is close to the opposite of the order they come to mind in.

| want                                             | reach for                                                                                                                       | why it is stronger than a claim-time limit                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **one unit of work per subject at a time**       | a **request-time row lock** on the row the work is about — `SELECT … FOR UPDATE`, and do not emit when one is already in flight | it holds under a worker restart, a reclaimed lease and an event replay, none of which a scheduler's admission decision survives. `dataExportService.requestDataExport` is the shipped example        |
| **at most one QUEUED run per key**               | `defineJob`'s **`idempotency`** template, enforced by the `(job_id, idempotency_key)` partial unique index at ENQUEUE           | a uniqueness constraint rather than a read-derived write, so it cannot race with itself and it has no liveness obligation at all                                                                     |
| **one run per burst, carrying the latest event** | `defineJob`'s **`debounce`** (`key` + `period` + `timeout`)                                                                     | coalesces at enqueue, and its cap is measured from FIRST arrival, so a steady stream cannot defer it for ever (§9)                                                                                   |
| **N concurrent units of a NON-queue resource**   | an **admission cap in the job's own domain** — `lib/ciFleet/limits.ts` is the shipped one                                       | what is being rationed is containers, money or a provider's rate limit, none of which the queue can see. `docs/decisions/code-graph-index-fleet.md` §7 decides exactly this, for exactly this reason |

**The row lock and the queue are not two ways of doing one thing.** A claim-time limit answers
_"how many of these may RUN at once"_; a row lock answers _"may this work be REQUESTED at all"_ —
and where both are available, only the second survives a restart. The export job wanted the first
as belt to the second's braces, and losing the belt cost it nothing.

### §14.4 — The trigger to revise

This decision is about a demand that does not exist yet, so it names the evidence that would
overturn it rather than waiting to be re-argued from scratch. **Both, together:**

- **a job whose serialisation cannot be expressed at request time** — because the subject is not a
  row there is anything to lock (a whole-workspace reindex, an external tenant), AND
- **a measured cost from running two of them concurrently.** Not a tidiness argument, and not the
  belt-and-braces case: a second, weaker guard beside a row lock is what this section declines.

With both in hand, the open design question is the one §14.2.3 refuses to answer on taste —
whether a blocked key shrinks the batch or extends the scan — now decidable against that job's
numbers, and owing the liveness argument §14.2.1 makes unavoidable. The parts exist:
`concurrency_key` would be a column beside `debounce_key`, populated at dispatch from an event
expression by the machinery `lib/jobs/engine/eventExpression.ts` already runs for `debounce.key`.
**What is missing is not the plumbing; it is the fairness decision and a consumer to make it for.**

### §14.5 — What §14 does not settle

- **`motir-ai`'s own queue.** §14.2.1 reads it as EVIDENCE, not as a thing to change. Different
  service, different table, different resource — whether its wedge is fixed, and how, is
  Amendment 7's business and not this record's.
- **Whether `CLAIM_BATCH` or the worker machine count is right.** Those are the real concurrency
  controls now (§14.2.5); neither is examined here.
- **The two jobs that deliberately carry no limit.** `codeGraphIndex.ts` and `codeGraphRefresh.ts`
  each record their own reason at length. This section is why the OPTION is absent, not why those
  two do not want one.

[MOTIR-3417]: https://app.motir.co/items/MOTIR-3417
[MOTIR-3418]: https://app.motir.co/items/MOTIR-3418
[MOTIR-3484]: https://app.motir.co/items/MOTIR-3484
[MOTIR-3485]: https://app.motir.co/items/MOTIR-3485
[MOTIR-3701]: https://app.motir.co/items/MOTIR-3701
[Graphile Worker]: https://github.com/graphile/worker
[pg-boss]: https://github.com/timgit/pg-boss
