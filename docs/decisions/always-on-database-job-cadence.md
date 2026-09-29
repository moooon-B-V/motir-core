# ADR: motir-core's database is always on, so every 30-minute `system.*` job runs every 5 minutes

- **Status:** Proposed (2026-09-29), for acceptance at MOTIR-6893's `decision_approval` gate. The
  direction was settled with the product owner in the planning conversation on 2026-09-29, after the
  always-on cost was put to them. This record writes it up. It does not reopen it.
- **Card:** MOTIR-6893
- **Evidence pinned at:** `motir-core` `origin/main` @ `be6fdb98b`.
- **Supersedes:**
  - **MOTIR-3314**, clustering the `system.*` crons onto shared minutes. That card is marked
    `deprecated` and superseded by MOTIR-6893.
  - In `application-hosting.md` **§21 — Q19: the DATABASE coupling**:
    - the block _"⚠️ AND THE SCHEDULE IS NOW CLUSTERED — MOTIR-3314, 2026-08-26"_: the `{0, 30}`
      cluster, the 30-minute quiet gap and the shortest-gap guard;
    - its **~30% / ~17% duty-cycle predictions**, and the owed re-measurement that was to settle
      them;
    - the rule _"A job needing finer granularity than 30 minutes is a decision to bring back to
      §21"_, as it is quoted on `SCHEDULE_CLUSTER_MINUTES`;
    - the `motir-core` row of §21's poll table (_"none — every `setInterval` in the repo is
      client-side"_ and _"Scheduled work arrives via Inngest over HTTP"_).
  - The earlier body of MOTIR-6893 itself: a `research` card proposing activity-gated scheduling so
    the database could sleep for hours. It was set aside on 2026-09-29.
- **Amends. This record names each clause; the edit rides MOTIR-6934, not this diff:**
  - `application-hosting.md` **§21**: each clause under _Supersedes_ is struck in place, with a
    pointer here.
  - `application-hosting.md` **§16**, the `motir-core` row _"$0 — no in-process poll (§21)"_. The $0
    stays true for a second WEB machine, but the reason changes: the compute is already awake because
    of the worker, not asleep because nothing polls.
- **Unchanged, and cited:** `job-queue-foundation.md` (the Postgres job engine and its worker), and
  the `motir-ai` and `motir-gateway` rows of §21, whose databases this record does not touch.
- **Consumed by:**
  - **MOTIR-6932**, the eleven crons to `*/5` and the new invariant in `lib/jobs/schedules.ts` and
    its test;
  - **MOTIR-6933**, the cadence comments in `lib/jobs/definitions/*` and `docs/jobs.md`;
  - **MOTIR-6934**, the §21 / §16 strikes named above;
  - **MOTIR-6910** and **MOTIR-6925**, which take their cadence from `fleet-per-org-pool.md`
    (MOTIR-6901) on this record's default.

---

## Context

**The rule being retired.** Since MOTIR-3314 (2026-08-26), every `system.*` cron has fired only on
minute 0 or 30 past the hour:

- `SCHEDULE_CLUSTER_MINUTES = [0, 30]` and `MIN_QUIET_GAP_MINUTES = 30` are in
  `lib/jobs/schedules.ts`.
- `tests/jobs/schedule-cluster.test.ts` fails the build if the shortest gap between two wake-minutes
  drops below 30. It also asserts that exactly 30 schedules are registered.

The rule rests on one premise: that motir-core's Neon compute suspends when nothing touches it for
roughly 5–9 minutes. §21 measured the old spread-out schedule at **100%** awake (MOTIR-2853,
2026-08-21). It predicted that clustering would bring this down to **~30%**, and said that
re-measurement was owed.

**The premise stopped holding when scheduling moved onto the worker.** MOTIR-3418 took scheduled
work off Inngest and onto motir-core's own Postgres job engine. It runs in the `worker` process group
(`fly.toml` `[processes]`, `scripts/worker.ts`). That worker polls:

- **`IDLE_MAX_MS = 5_000`** (`lib/jobs/engine/worker.ts`) caps the idle wait between ticks, so an
  idle worker still ticks at least every 5 seconds.
- **Every `tick()` queries Postgres** before it can find out there is nothing to do:
  - the scheduler hook (`onSchedulerTick`, which enqueues due cron fires);
  - `jobQueueRepository.reclaimExpiredLeases`;
  - `jobQueueRepository.claimDueRuns`.

A query every ≤ 5 s is far inside any suspend delay Neon has shown us. **So the compute cannot
suspend, whatever shape the cron schedule has.** The cluster rule has been protecting nothing since
the worker shipped. §21 and `fly.toml` still describe motir-core as having no in-process poll, with
scheduled work arriving over HTTP.

**What the 30-minute cadence costs instead is latency:**

- A local run that died silently reaches _To fix_ up to ~35 minutes late (MOTIR-6881).
- The supervision sweep's worst case is 15 minutes grace + 30 = **45 minutes**.
- The public-address certificate refresh runs every 30 minutes, where MOTIR-4219 asked for 5.
- The new fleet jobs (MOTIR-6910's live debit, MOTIR-6925's attribution reconciler) would have had to
  wait up to 30 minutes between checks. `fleet-per-org-pool.md` §3 prices each extra minute of that
  as unpaid machine time.

**How the premise is established.** It rests on the code above, not on a platform reading. A
database that never sleeps is an ordinary state for a service with a resident worker. The product
owner waived a Neon control-plane measurement for this record (2026-09-29).

---

## Decision

**motir-core's database is always on, and Motir accepts that bill: ≈ $19.50/mo, the 0.25 CU floor
for 730 h (§21's own figure).** Every `system.*` job that runs every 30 minutes today runs **every 5
minutes** (`*/5 * * * *`). The `:00/:30` cluster rule and its 30-minute quiet-gap invariant are
retired.

### §1 · The database

motir-core's Neon compute is always on. The job worker's ≤ 5 s poll is what holds it awake, and
that is accepted. Scale-to-zero would need a dormant worker that can be woken without touching
Postgres. That is not planned. If it is ever wanted, it is a new decision card that carries a
measured saving.

### §2 · The eleven jobs that move to `*/5 * * * *`

| job (`system.*`)                     | today          | after         |
| ------------------------------------ | -------------- | ------------- |
| `ci-runner-provision-sweep`          | `0,30 * * * *` | `*/5 * * * *` |
| `ci-runner-reap`                     | `0,30 * * * *` | `*/5 * * * *` |
| `supervision-sweep`                  | `0,30 * * * *` | `*/5 * * * *` |
| `run-liveness-sweep`                 | `0,30 * * * *` | `*/5 * * * *` |
| `plan-target-lock-sweep`             | `0,30 * * * *` | `*/5 * * * *` |
| `public-address-certificate-refresh` | `0,30 * * * *` | `*/5 * * * *` |
| `pull-request-reconcile`             | `0,30 * * * *` | `*/5 * * * *` |
| `monitor-issue-reconcile`            | `0,30 * * * *` | `*/5 * * * *` |
| `code-graph-drift-sweep`             | `0,30 * * * *` | `*/5 * * * *` |
| `code-graph-index-catch-up`          | `0,30 * * * *` | `*/5 * * * *` |
| `migrate-onboarding-sweep`           | `0,30 * * * *` | `*/5 * * * *` |

Each job's `catchUp` disposition is unchanged.

**Worst cases after the change:**

- a lapsed local run is closed within 5 min lapse + 5 min tick = **10 min** (was ~35);
- a stalled supervision is caught within 15 min grace + 5 = **20 min** (was 45);
- a certificate state is refreshed within **5 min** (was 30);
- a stranded planning lease clears within 30 + 5 = **35 min** (was 60, §21's own arithmetic).

### §3 · Hourly and slower: unchanged

The other nineteen jobs keep their schedules:

- **5 hourly:** `abandoned-plan-sweep`, `auto-plan-cadence-tick`, `ci-actions-gate-sweep`,
  `filter-subscription-tick`, `organization-erasure-sweep`;
- **12 daily**, **1 weekly** (`public-follow-digest`) and **1 monthly** (`ci-minutes-reconcile`).

Their period is what they are for: a daily retention sweep is daily because a day is the unit its
policy speaks in, not because of the database. Their minutes no longer need to be 0 or 30, but
nothing moves them. The nightly table-walking sweeps stay spread across the early-morning hours,
because that keeps two heavy scans from sharing a cold cache. That reason survives the database
being awake.

### §4 · The invariant that replaces the quiet gap

**Every sub-hourly cron is `*/5 * * * *`, unless it is named in a commented exception list with a
one-line reason.** The list is `SUB_HOURLY_CADENCE_EXCEPTIONS` or similar. MOTIR-6932 names and
builds it.

- A job that needs to run more often than every 5 minutes joins the list with its reason, for
  example a debit period derived from an overshoot bound. So does a job that must run sub-hourly but
  less often than every 5 minutes.
- A job that runs hourly or slower is outside the rule.
- **No hard-coded job count.** The `length === 30` assertion goes. A new job is checked by the rule,
  not by a count someone has to bump.

**New jobs.** MOTIR-6910's live debit and MOTIR-6925's attribution reconciler take the cadence
`fleet-per-org-pool.md` (MOTIR-6901) derives: 5 minutes, which is this record's default, so neither
needs an exception. The agent-instance sweep that `agent-instances.md` §5 runs every 5 minutes is
legal as written.

---

## Alternatives rejected

- **Keep the cluster, and add an activity gate so the database can sleep for hours.** This was this
  card's own earlier proposal. It saves at most ~$14–16/mo, and only if the worker's poll is also
  replaced by a dormant worker woken without Postgres. That is a sizeable rebuild of how jobs are
  woken, and it buys a small saving. It was set aside by the product owner.
- **Keep the cluster as it is.** It costs up to 30 minutes of latency on every sub-hourly job and
  saves nothing, because the worker already holds the compute awake.
- **One-minute cadence everywhere.** Nothing asks for it. The exception list is the door for a job
  that does.

---

## Consequences

- The Neon line for motir-core is ≈ $19.50/mo as a standing, accepted cost, not a defect to engineer
  away. §21's ~$5.85/mo projection is retired with the prediction behind it.
- Eleven jobs fire 12× an hour instead of 2×. Each tick writes a `job_run` row (`defineJob`). That is
  132 extra rows an hour, well inside what the job engine's retention (`job-run-reap`) is for.
- Latency bounds shrink as listed in §2. The fleet decisions can take their timings from what the
  money needs.
- A future job that picks a sub-hourly cadence other than `*/5` fails a test until it names its
  reason. The same structural defence the cluster had, for the new rule.

---

## What this does NOT decide

- **motir-ai's and the gateway's databases.** Their §21 rows stand: motir-ai has no idle poll, and
  the gateway syncs every 1800 s.
- **Any hourly-or-slower cadence.**
- **An activity gate or a dormant worker.** Neither is planned. Either one would be a new decision
  with a measured saving.
- **The worker's `IDLE_MAX_MS`.** It is cited here as the reason the compute is awake. Whether it
  should change is not in scope.
- **Which jobs, if any, join the exception list.** None does today. MOTIR-6932 builds the list and
  the test.
- **The Neon compute size or autoscale range.** They stay at 0.25–8 CU, as §21 read them.
