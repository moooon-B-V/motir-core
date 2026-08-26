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

| job id                              | cron                       | disposition | why — the staleness argument                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system.abandoned-plan-sweep`       | `10 * * * *`               | `latest`    | Reconciles `generating` plans from live state. One pass sees every plan six missed passes would have; the pause it lifts is hourly-grained.                                                                                                                                                                             |
| `system.attachment-gc`              | `30 3 * * *`               | `latest`    | A missed night is a night of un-collected orphans, and nothing else collects them — so it must not be skipped. One pass re-reads the whole orphan set; the cursor bound means a backlog drains across the following nights, which is the cadence the sweep was designed for.                                            |
| `system.auto-plan-cadence-tick`     | `20 * * * *`               | `latest`    | Every gate is re-derived per run, and a project that fired now holds an undecided plan, so replaying older fires is a guaranteed no-op. An hour of drained ready-set is worth one catch-up.                                                                                                                             |
| `system.automation-retention-sweep` | `15 4 * * *`               | `latest`    | A 90-day retention window is a commitment; a skipped day defers it by a day. The predicate is `expires_at < now`, so one pass covers the gap.                                                                                                                                                                           |
| `system.ci-actions-gate-sweep`      | `30 * * * *`               | `latest`    | The RESUME half has a deadline: GitHub drops a queued job that finds no runner after 24 h, and an org that topped up cannot re-meter while its Actions are off. An hour of that deadlock is exactly what the hourly cadence exists to bound.                                                                            |
| `system.ci-minutes-reconcile`       | `0 4 3 * *`                | `latest`    | Monthly. Skipping means the month is never audited. See §11.6 — the one job whose _correct_ disposition is `all`, and cannot be until it reads its fire instant.                                                                                                                                                        |
| `system.ci-runner-provision-sweep`  | `* * * * *`                | **`skip`**  | The next fire is at most 60 seconds away, so the catch-up saves less than the claim loop's own poll interval — while a six-hour outage would enqueue 360 rows fanning out against a batch ceiling that exists to protect GitHub's registration limit. The one job where the catch-up is measurably worse than the wait. |
| `system.ci-runner-reap`             | `7,17,27,37,47,57 * * * *` | `latest`    | Not `skip`, despite the ten-minute cadence: an orphaned container bills for every minute it survives, so after an outage the immediate reap reclaims spend the next fire would not. Reaping reads current orphans, so one pass suffices.                                                                                |
| `system.code-graph-offboard-sweep`  | `45 4 * * *`               | `latest`    | The retention window §14.5 commits to is the same class of commitment as the automation sweep's. A daily gap is a day of retention owed; one pass re-reads the whole due queue.                                                                                                                                         |
| `system.daily-health-check`         | `0 9 * * *`                | `latest`    | See §11.7 — the disposition interacts with the probe this job carries, and `skip` would make a routine restart across 09:00 report as a fault.                                                                                                                                                                          |
| `system.filter-subscription-tick`   | `0 * * * *`                | `latest`    | A worker back at 14:03 having missed the 14:00 fire delivers the 14:00 hour's digests correctly, because the handler scans the CURRENT UTC hour. The per-occurrence idempotency key collapses a duplicate. See §11.6 for what a catch-up cannot recover.                                                                |
| `system.migrate-onboarding-sweep`   | `7,22,37,52 * * * *`       | `latest`    | What it repairs is a person's wedged onboarding run, and it re-derives from durable state. Fifteen more minutes on top of an outage is paid by a user who is already waiting.                                                                                                                                           |
| `system.plan-target-lock-sweep`     | `*/10 * * * *`             | `latest`    | A stranded lease holds an item NOBODY can plan, with no user-facing remedy. Ten minutes is the cadence that was chosen against exactly that cost; a catch-up honours it on restart.                                                                                                                                     |
| `system.rate-limit-sweep`           | `10 4 * * *`               | `latest`    | Nothing else deletes a `rate_limit_counter` row. One pass; the per-run bound is deliberate ("a backlog drains over several days rather than locking a large slice of a hot table in one pass"), which is also why this is not `all`.                                                                                    |

### §11.5 — Why `all` has no members today, and stays in the vocabulary anyway

Thirteen `latest`, one `skip`, zero `all`. That is a finding, not an omission: **every scheduled job
Motir has is a convergent sweep**, so N missed fires and one missed fire have the same remedy. Naming
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

The one `skip` job is `system.ci-runner-provision-sweep`, whose tolerance is ~2 minutes: any outage
long enough to matter trips the probe whether or not the missed fire is replayed, so skipping costs
the probe nothing.

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
- **A job's own schedule.** No cron expression changes; MOTIR-3416 asserts the fourteen constants
  against their shipped values. The wake-cost argument in `ciRunnerFleet.ts`'s
  `CI_RUNNER_REAP_CRON` comment (fourteen distinct wake-minutes on a suspend-when-idle compute) is a
  separate work item and is not weighed here.

[Graphile Worker]: https://github.com/graphile/worker
[pg-boss]: https://github.com/timgit/pg-boss
