# Background jobs

Motir runs background work on [Inngest](https://www.inngest.com/) — durable,
event-driven functions with built-in retries and step memoization. This
document covers the runtime landed in Subtask 1.6.2: the client, the
`defineJob` / `sendEvent` wrappers, the `job_run` ledger, and how to add a job —
plus the cross-cutting patterns added in 1.6.4: named **retry policies**, the
**dead-letter queue** + replay, and **scheduled (cron) jobs**.

> The operator dashboard that renders the ledger + DLQ (with a UI "Replay"
> button) arrives in Subtask 1.6.5. Until then the DLQ + `replayDLQ` are
> reachable programmatically / via the runbook below.

## Runtime overview

```
emit:   route/service ──sendEvent("x.y", { workspaceId, … })──▶ Inngest
run:    Inngest ──POST /api/inngest──▶ serve route ──▶ defineJob wrapper ──▶ your handler
ledger: defineJob writes a job_run row: running ─▶ succeeded | failed (+ DLQ on exhaustion)
```

- **Serve route** — `app/api/inngest/route.ts`. The single endpoint the Inngest
  control plane (cloud) or the local `inngest-cli dev` server syncs and invokes
  functions through. Exports `GET` (probe), `PUT` (registration), `POST`
  (invocation). It mounts the functions in `lib/jobs/registry.ts`.
- **Client** — `lib/jobs/client.ts`. The one `new Inngest({ id: "prodect-core" })`
  singleton. Everything composes `defineJob` / `sendEvent` on top of it. (The
  app id deliberately kept the pre-rebrand spelling — it identifies the synced
  Inngest Cloud app; changing it needs a dashboard re-sync pass, not a rename.)
- **The 4-layer rule still holds.** No file outside `lib/jobs/**` and
  `app/api/inngest/**` may import the `inngest` SDK directly (enforced by an
  ESLint `no-restricted-imports` rule). Routes/services emit events via
  `sendEvent`; job handlers receive the injected service-layer bag and call
  services exactly as a route would.

## Environment

| Var                   | Where          | Notes                                                                                               |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `INNGEST_DEV=1`       | local dev only | Forces dev mode; without it the serve route 500s locally. Set by `pnpm dev:inngest`. UNSET in prod. |
| `INNGEST_EVENT_KEY`   | prod           | Authenticates `sendEvent`. Blank locally / in tests.                                                |
| `INNGEST_SIGNING_KEY` | prod           | Verifies control-plane requests. Read automatically by the SDK. Blank locally.                      |

In production both keys are **Fly secrets on the `motir-core` app**, set with
`fly secrets set` and readable back only as digests (`fly secrets list`). Their
values come from the Inngest dashboard. There is no preview scope any more: the
only deploy this repository makes is the production release in `ci.yml`'s
`deploy` job. See "Cloud wiring" below.

## Local development

```bash
pnpm dev:inngest      # next dev with INNGEST_DEV=1, app on :3000
# in a second terminal:
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

The dev server discovers functions via the serve route and gives you a local
dashboard (`http://localhost:8288`) to trigger events and inspect runs. We run
the CLI via `npx` rather than a devDependency: pnpm 11 mis-execs the
`.bin/inngest-cli` shim and blocks its native postinstall build (PRODECT_FINDINGS
#30, sharp edges #3/#4), and the CLI is a local-only tool — never imported,
never in CI/prod.

## `defineJob(options, handler)`

The canonical way to define a job — `lib/jobs/defineJob.ts`. Wraps
`inngest.createFunction` and adds the run-ledger bookkeeping automatically.

```ts
import { defineJob } from '@/lib/jobs/defineJob';

export const sendInvoice = defineJob(
  { id: 'invoice.send', retryPolicy: 'transient', concurrency: 5 },
  async (ctx, services) => {
    const { workspaceId, invoiceId } = ctx.event.data;
    await services.workspaces.something(workspaceId);
    return { sent: true };
  },
);
```

**Options**

| Field         | Default                  | Meaning                                                                                                                                                                                                                                                      |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | —                        | The job id, **also the triggering event name** (1:1 convention). Must be a key of `JobEventDataMap` in `lib/jobs/types.ts`.                                                                                                                                  |
| `retryPolicy` | `'transient'`            | Named retry policy — the preferred way to declare retry intent. See **Retry policies** below. Mutually exclusive with `retries`.                                                                                                                             |
| `retries`     | —                        | Raw Inngest retry count (escape hatch; prefer `retryPolicy`). Passing both throws.                                                                                                                                                                           |
| `concurrency` | —                        | Concurrency constraint(s): a bare limit, or Inngest's `{ limit, key?, scope? }`, or an array of them. See **Concurrency** below.                                                                                                                             |
| `idempotency` | —                        | Event-payload-keyed dedup template, honoured by **both** runtimes — Inngest's windowed event dedup on the Inngest lane, a partial UNIQUE index on the Postgres engine. See **Event-level idempotency on the Postgres engine** and the `email.send` exemplar. |
| `cron`        | —                        | Schedule the job instead of event-triggering it. See **Scheduled jobs** below.                                                                                                                                                                               |
| `catchUp`     | — (REQUIRED with `cron`) | What a missed tick does: `all` / `latest` / `skip`. A `cron` job that omits it does not type-check, and a job without a `cron` may not supply it. See **Scheduled jobs** below.                                                                              |

**Handler signature** — `(ctx, services) => result`:

- `ctx` — the Inngest context: `ctx.event` (`.name`, `.data`, `.id`),
  `ctx.step` (durable step tools), `ctx.runId`, `ctx.attempt`, `ctx.logger`.
- `services` — the injected service-layer bag (`lib/jobs/services.ts`):
  `workspaces`, `workspaceInvites`, `projects`, `workItems`, `users`, `email`.
  Use these instead of importing service singletons directly, so handlers stay
  testable with a stubbed bag.
- The return value becomes the run's resolved output.

**Run ledger.** Around every handler, `defineJob` writes one `job_run` row:
`running` at start → `succeeded` on return. On a throw, the row stays `running`
across retries; once the retry budget is exhausted Inngest invokes the
function's **`onFailure` handler**, which flips the row to `failed` and writes a
dead-letter row (see **Dead-letter queue**). So a job that's mid-retry reads as
in-flight, not prematurely failed. The writes run inside `step.run(...)`, so
they execute exactly once per run even when the handler replays across step
boundaries — one row per run, not one per replay (the `job-run:start` step's
result is reused across retries too). This is the read path the operator
dashboard (1.6.5) renders without calling Inngest's API. `workspace_id` is null
for system jobs. On success the row also records the handler's JSON-safe
return value in its `output` column (5.2.7) — a run's summary (e.g. the
attachment-GC's `{ scanned, deleted, failed }`) is readable from our ledger,
not only from Inngest's dashboard; a non-JSON-safe return degrades to a NULL
`output`, never a failed run.

> **Why `onFailure`, not a try/catch (1.6.6).** The dead-letter write used to
> live in a `try/catch` around the handler, on the "final attempt" branch. On
> the **real Inngest executor** a `step.run` scheduled from a catch block _after_
> the step that terminally failed is never executed — the run is already
> finalizing as failed — so the failed/DLQ rows silently never got written in
> production (only the in-process unit harness, which runs the catch
> synchronously, made it look like they did). `onFailure` is Inngest's
> first-class "run exactly once after all retries are exhausted" hook, so the
> write is reliable. It's a **separate** invocation from the failed run, so it
> carries the original event but not the row id — `jobRunsService`
> correlates back to the `running` row by `(functionId, eventId)` (the
> `@@index([eventId])` exists for this). See `PRODECT_FINDINGS.md` #39.

The ledger tables (`job_run`, `job_run_dlq`) are **workspace-scoped by RLS**
(1.6.4): a tenant sees only its own workspace's rows. The runtime writes them
under a trusted **system-admin context** (`withSystemContext`) so the wrapper —
which has no workspace context — can record rows for any/no workspace, and
operator tooling can see untenanted `system.*` runs. See the
`add_job_run_dlq_and_rls` migration for the policy.

## `sendEvent(name, data)`

The only way to emit an event — `lib/jobs/sendEvent.ts`. Wraps `inngest.send`
and enforces the **workspace-scoping invariant**: every event carries an
**explicit** `workspaceId`. The field is required by each event's payload type
(a forgotten id is a compile error) and re-checked at runtime, where `undefined`
(missing) and `''` (empty) are rejected.

```ts
import { sendEvent } from '@/lib/jobs/sendEvent';

await sendEvent('invoice.send', { workspaceId, invoiceId });
```

**The `null` carve-out.** A handful of events are genuinely cross-workspace — a
password-reset email is identity-scoped, not workspace-scoped (the user may
belong to many workspaces or none). Such events type their `workspaceId` as
`string | null`, and `sendEvent` accepts an **explicit `null`** (but never a
forgotten field). `null` is what the `job_run` row stores — its `workspace_id`
FK is nullable. Do **not** invent a `"system"` sentinel string: that's not a
real workspace id and would violate the FK on insert.

System events (the `system.*` namespace) are untenanted by design, so
`sendEvent`'s type still excludes them — a system payload's `workspaceId` is
optional, and widening one function to accept both namespaces would mean dropping
the explicit-tenant assertion for the workspace-scoped events too. Many are
**cron-triggered** (e.g. `system.daily-health-check`, see **Scheduled jobs**) or
driven by the in-process test harness. The ones that are EMITTED go through
`sendSystemEvent` — see the emit seam directly below.

## The emit seam — every event goes through one of three doors (MOTIR-3456)

**Nothing outside `lib/jobs/` calls `inngest.send`.** There are exactly three
ways to emit an event, all in `lib/jobs/sendEvent.ts`:

| door                              | for                                                | on a transport failure |
| --------------------------------- | -------------------------------------------------- | ---------------------- |
| `sendEvent(name, data)`           | workspace-scoped events                            | swallowed + logged     |
| `sendSystemEvent(name, data)`     | `system.*` events                                  | swallowed + logged     |
| `dispatchSystemEvent(name, data)` | `system.*`, for a caller that must SEE the failure | **rethrown**           |

**Why the rule exists, in one line: the per-job cutover switch is read in that
module, so an emitter that bypasses it is an emitter the switch cannot route.**
A job named in `MOTIR_POSTGRES_JOB_IDS` whose event was sent straight through the
client is enqueued on neither lane — the engine never hears about it and
`defineJob`'s Inngest handler declines to run it.

**The strict door is not an inconsistency.** Two callers legitimately need the
failure rather than a log line: `ciRunnerFleet`'s provision sweep emits inside a
`step.run`, where a thrown error buys a free retry of the step, and
`dispatchCiRunnerBoot` REPORTS `'send_failed'` to its caller. Both behaved that
way before they were routed through this module, and moving WHERE an event is
dispatched must not silently change WHETHER a caller finds out that it failed.

**Two things enforce this, and they cover different halves.**

- **ESLint** — `INNGEST_CLIENT_RESTRICTION` in `eslint.config.mjs` refuses an
  import of `@/lib/jobs/client` from outside `lib/jobs/**`, `scripts/worker.ts`,
  `app/api/inngest/**` and `scripts/experiments/**` (the measurement harnesses,
  which exist to drive the vendor directly). ⚠️ Note it restricts OUR CLIENT, not just the
  `inngest` package. The older `INNGEST_RESTRICTION` guards the package, and for
  a long time it guarded the door nobody uses: four `system.*` emitters bypassed
  the switch under a green lint run because they imported our own thin wrapper
  one file over.
- **A guard test** — `tests/jobs/emit-seam.test.ts` asserts on the TypeScript AST
  that `inngest.send` is CALLED in exactly two files (`sendEvent.ts` and
  `dlq.ts`). ESLint cannot cover this half: one of the original bypasses lived
  INSIDE `lib/jobs/**`, where the import is legitimate. The test counts calls
  rather than grepping the string, because the tree carries `inngest.send()` in
  several comments and one seed fixture.

If one of these fails, it is telling you the switch cannot reach your job — the
fix is a door above, not a disable comment.

## Canonical job: `email.send`

`email.send` (`lib/jobs/definitions/emailSend.ts`) is the first production job
and the reference exemplar — every transactional email in motir-core flows
through it.

**Why it exists.** Password reset (`lib/auth/index.ts`) and workspace invites
(`lib/services/workspaceInvitesService.ts`) used to render + `sendEmail()`
**inside the HTTP request**. A slow or down provider stalled the request or
returned a misleading success while no mail went out. Now those sites call
`sendEvent('email.send', …)` and return immediately; the job does the delivery
with retries, off the request path. Terminal failures surface in the jobs
dashboard (1.6.5), not as a silent drop.

**Shape.**

```ts
// caller (request lifecycle) — enqueue and return
await sendEvent('email.send', {
  workspaceId, // a workspace id, or null for a cross-workspace email
  idempotencyKey: token, // the reset token / invite token
  to: user.email,
  template: 'password-reset', // discriminant
  data: { recipientName, resetUrl }, // exactly that template's props
});
```

- **Layering.** The job handler owns no email logic. Rendering + dispatch live
  in `emailService` (`lib/services/emailService.ts`), which the handler reaches
  via the injected `jobServices` bag — the 4-layer rule (a job handler is the
  "service caller" for a background trigger). `@/lib/email` (`sendEmail`) is
  import-restricted to `emailService` alone; every other caller must enqueue.
  Templates stay pure render functions in `lib/emailTemplates/`.
- **Durability.** The single `step.run('send', …)` persists the send result, so
  a retry of a different step never re-delivers.
- **Idempotency — THREE layers, and `idempotency` does not mean "Inngest".** The
  job is configured with `idempotency: 'event.data.idempotencyKey'`, so a
  retried Server Action that re-fires the same token collapses to one delivery.
  That one declaration is read by two different runtimes, and a third mechanism
  sits underneath both of them:

  | layer                                        | lives in                                                          | applies when                                                                   | window                                                         |
  | -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
  | Inngest's event-level dedup                  | the Inngest runtime, server-side                                  | `email.send` is on the **Inngest lane** — absent from `MOTIR_POSTGRES_JOB_IDS` | Inngest's own dedup **window**                                 |
  | `job_queue_job_idempotency_key` (MOTIR-3459) | the **Postgres engine** — `lib/jobs/engine/idempotency.ts`        | `email.send` is on the **engine lane** — named in `MOTIR_POSTGRES_JOB_IDS`     | **unbounded**: a partial UNIQUE on `(job_id, idempotency_key)` |
  | Resend's `Idempotency-Key` header            | the **provider adapter** — `resendIdempotencyKey`, `lib/email.ts` | `EMAIL_PROVIDER=resend` — i.e. production                                      | Resend's own, per request                                      |

  **The first two never compose — the cutover switch routes a job to exactly one
  lane.** `sendEvent` picks the lane and `defineJob`'s Inngest handler returns
  `{ skipped: 'routed-to-postgres-engine' }` for a job that has moved
  (`lib/jobs/engine/cutover.ts`; **Cutting a job over to the Postgres engine**
  below). So "the dedup window" for a given deployment is whichever lane that job
  is on, and the two windows are not the same window: Inngest's expires, the
  index does not — a deliberate divergence argued in
  **Event-level idempotency on the Postgres engine**.

  **The third one DOES stack on top of whichever lane is live**, and it is the
  only layer that is a property of the DESTINATION rather than of the queue: it
  collapses two accepted sends of the same key at Resend even when both reached
  the provider.

  **⚠️ And the provider layer is absent locally and in E2E.**
  `resendIdempotencyKey` is called only from `resendProvider()`; `consoleProvider`
  and `fileProvider` never read `msg.idempotencyKey` at all. Whatever the lane
  does not catch is therefore written twice to the console log or the file
  outbox — dev and E2E differ from production in exactly this dimension, so a
  duplicate that production would swallow is visible here, and a behaviour that
  looks deduped here is not evidence that the queue deduped it.

  **What is tested where.** The in-process unit harness runs the handler directly
  and does **not** simulate Inngest's dedup, so the unit tests on that lane assert
  the _wiring_ (the config carries the expression) and the _caller contract_ (the
  key is supplied), not the runtime drop. The ENGINE lane's drop **is** tested —
  including a concurrent duplicate against real Postgres — in
  `tests/jobs/engine-idempotency.test.ts`. The key is also recorded on the
  `job_run` row.

- **Retry policy.** `email.send` uses `retryPolicy: 'transient'` — a send fails
  on transient provider/network blips, so a few attempts with backoff is the
  right intent (see **Retry policies**). A terminal failure dead-letters.
- **`workspaceId: null`** for password reset (cross-workspace); the invite path
  passes its real workspace id.

## How to add a new job

1. **Declare the event** in `lib/jobs/types.ts` — add a key + payload to
   `JobEventDataMap`. Business-event payloads must include `workspaceId` —
   `string`, or `string | null` for a genuinely cross-workspace event (see the
   `null` carve-out above).
2. **Define the job** in `lib/jobs/definitions/<name>.ts` via `defineJob`. Pick
   a `retryPolicy` that matches the failure surface (see **Retry policies**).
3. **Register it** — add it to the `jobFunctions` array in `lib/jobs/registry.ts`.
   (The serve route imports from the registry, so it never changes.)
4. **Emit it** from a route or service via `sendEvent` (business events) — or
   give it a `cron` **and a `catchUp`** (system jobs, see **Scheduled jobs**).
   The two go together and the compiler enforces it: there is no default, because
   a default is how a cron job added later inherits a catch-up disposition nobody
   chose for it. Decide it deliberately — the three answers and the argument for
   picking between them are in **Scheduled jobs**.
5. **Test it** with `@inngest/test`'s `InngestTestEngine` against the real
   Postgres (see `tests/jobs/scheduled.test.ts` for a cron job,
   `tests/jobs/dlq.test.ts` for the failure/DLQ path). For an **event-triggered**
   job pass the real event explicitly via `events: [{ name, data }]`; for a
   **cron** job omit `events` so the engine uses the direct-invoke path (a cron
   job has no event trigger to match).

## Retry policies

A job declares its retry **intent** with a named policy (`lib/jobs/retries.ts`)
rather than a magic count, so the choice is self-documenting and visible in the
operator dashboard. Each policy is defined in terms of total **attempts**
(including the first); the module translates that to Inngest's `retries` value
(`retries = maxAttempts − 1`). Inngest applies exponential backoff between
attempts automatically — the policies differ by their attempt **budget**, not by
a hand-tuned curve.

| Policy       | Attempts | When to pick it                                                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `transient`  | 3        | **Default.** Failures are usually transient (flaky provider, network blip). `email.send` uses this.             |
| `idempotent` | 5        | The operation is read-only or naturally idempotent, so repeating is always safe — a longer budget is upside.    |
| `none`       | 1        | Run **at most once**: a retry would be semantically wrong (e.g. "send this signup notification once or never"). |

```ts
defineJob({ id: 'invoice.send', retryPolicy: 'idempotent' }, handler);
```

Passing both `retryPolicy` and a raw `retries` throws (ambiguous intent). When a
job specifies neither, it gets `transient`. On the **final** failed attempt the
run dead-letters (below); `none` therefore dead-letters on the very first
failure.

## Concurrency — a bare limit is a GLOBAL lane every tenant queues in

`concurrency` accepts three shapes, all of them Inngest's own:

```ts
concurrency: 4                                        // a bare limit
concurrency: { limit: 1, key: 'event.data.workspaceId' }  // one sub-queue per tenant
concurrency: [                                        // both at once
  { limit: 1, key: 'event.data.workspaceId' },        // no tenant monopolizes
  { limit: 4 },                                       // total capacity
]
```

`key` is a CEL expression evaluated against the triggering event; each distinct
value gets its own sub-queue. `scope` (`'fn'` | `'env'` | `'account'`) widens
the limit beyond this one function; the default `'fn'` is almost always what a
job wants. An ARRAY means every constraint must admit a run before it starts.

**Reach for the keyed form whenever the job is triggered by a multi-tenant event
stream.** A bare number is a single lane for the whole environment, so one
workspace's backlog delays every other workspace's first run — the shape that
made a stranger's five-repo index queue land on someone else's onboarding
spinner (MOTIR-1982; before that card, `defineJob` typed the option as `number`
and emitted `{ limit: n }`, so no job in this repo could express anything else).

### The fairness claim is MEASURED, not assumed

The two-constraint idiom only buys fairness if the scheduler **skips over** a
key-blocked run to a runnable one instead of head-of-line blocking behind it.
That is a property of Inngest's scheduler, not of our config, so it was measured
rather than reasoned about — `scripts/experiments/inngest-concurrency-fairness.mjs`
saturates one tenant and times how long an unrelated tenant waits.

Workload: 20 events for tenant A, then 1 for tenant B; handler holds 500 ms;
`inngest-cli` 1.27.0 dev server, SDK 4.5.0. Time is measured from enqueue.

| Constraint                                  | Tenant B's wait (3 trials) | A's backlog drains |
| ------------------------------------------- | -------------------------- | ------------------ |
| `{ limit: 2 }` (today's bare number)        | 2.0 s / 3.0 s / 5.0 s      | ~6.1 s             |
| `[{ limit: 1, key: tenant }, { limit: 2 }]` | 0.27 s / 0.35 s / 0.71 s   | ~11.7 s            |

**The scheduler interleaves.** With the keyed constraint B started in the first
wave every time, while A — correctly — took nearly twice as long to drain,
because its own key holds it to one slot. The bystander's wait stopped scaling
with the flooder's backlog, which is the entire point. Without a key, B waited
through a third to five-sixths of a queue it had nothing to do with.

Two things the numbers do NOT say, so don't read them in:

- **This was the dev server, not Inngest Cloud.** The cloud scheduler is a
  different implementation and was not measured. The keyed config is
  unambiguously correct either way (it is Inngest's documented contract); what
  remains unverified is only the exact interleaving latency in production.
- **Order within a key is not FIFO.** The dev server started tenant A's events
  out of order (A5, A4, A2, A3, A1). A job that needs per-key ORDERING must get
  it from somewhere else — a concurrency key bounds parallelism, it does not
  sequence.

To re-run it: start `pnpm inngest-cli dev -u http://localhost:3987/api/inngest
--no-discovery --port 8388` (any free ports — a sibling dev server on 8288 will
silently take the default and the harness will talk to the wrong one), then
`LAB_MODE=keyed|global INNGEST_DEV=1 INNGEST_BASE_URL=http://localhost:8388 node
scripts/experiments/inngest-concurrency-fairness.mjs`.

### A WAIT is not an OCCUPANCY — a sleeping run holds no slot (MEASURED)

The constraint above only binds a run that is **executing code**. A run parked in
`ctx.step.sleep`, `step.sleepUntil`, `step.waitForEvent` or `step.invoke`
occupies **nothing** — which is what makes the durable poll loop in
`lib/jobs/indexFleetSteps.ts` affordable, and what makes an Inngest-level cap on
a container supervisor meaningless.

This corpus asserted the OPPOSITE for a month, in a comment, and a whole bug's
mechanism was built on it (MOTIR-3245). It is now measured, because the
disagreement was between two comments and a third citation would not have settled
it — `scripts/experiments/inngest-sleep-concurrency.mjs` runs three events
through `concurrency: { limit: 1 }` where the only variable is HOW each run holds
for 8 s:

| Arm                                      | When each run first executed code | Spread     |
| ---------------------------------------- | --------------------------------- | ---------- |
| `step.run` that awaits 8 s **(control)** | 241 ms / 8 328 ms / 16 429 ms     | 16 188 ms  |
| `step.sleep(8 s)`                        | 315 ms / 465 ms / 609 ms          | **294 ms** |

Two trials each, reproducing to within milliseconds. Under `sleep` all three runs
also _finished_ inside 8.6 s; had the sleep held the slot the third could not have
finished before ~24 s, which is exactly what the control did.

**The control is the load-bearing half.** Without an arm that demonstrably DOES
occupy the limit, a prompt start is equally well explained by the limit never
applying — so a measurement of this shape without a control proves nothing.

Consequence for any stepped supervisor: its occupancy is the **sum of its
`step.run`s**, not its wall-clock life. A 30-minute index is ~128 sub-second
steps, releasing the slot between every one — so the worst a queued run waits
behind it is one poll. `docs/decisions/job-lane-occupancy.md` carries the
arithmetic, the pool's scope, and which remedies the answer rules out.

Same caveat as the row above: **this is the dev server, not Inngest Cloud.**

## Debounce — coalescing is REAL; the `timeout` cap and an unresolvable KEY are not

`debounce` delays a run until `period` has passed with no further same-`key`
event, then runs ONCE with the LATEST event. `timeout` is meant to cap the total
deferral so a continuous stream still runs.

```ts
debounce: { key: "event.data.installationId + '/' + event.data.repoOwner", period: '2m', timeout: '15m' }
```

**`key` is a CEL expression, not a typed reference**, and that is the sharp edge
below. The documented limits: `period` is at least 1 second and at most 7 days,
and debounce does not combine with batching.

> ⚠️ **THIS SECTION IS ABOUT WHICH LANE A JOB IS ON (amended 2026-08-26,
> MOTIR-3488).** Everything from "What the SCHEDULER actually does" down is a
> measurement of **INNGEST's** executor — it is history, it is why the option is
> written the way it is, and it stays. The **Postgres engine implements the
> option itself** (MOTIR-3483), and the two do not behave identically: the engine
> is stricter in one place and safer in another. **§ The engine's debounce**,
> below the Inngest material, is that half. Read the one for the lane your job is
> actually routed to.

### What the SCHEDULER actually does — MEASURED, not assumed

A config-level assertion (`expect(fn.opts.debounce).toEqual(…)`, which
`tests/jobs/code-graph-index.test.ts` makes for `system.code-graph-refresh`)
proves the option was FORWARDED. It passes whatever the runtime then does with
it — including dropping the runs it declines to enqueue, which is what
MOTIR-2994 was filed to look for. So the behaviour was measured against the real
scheduler: `scripts/experiments/inngest-debounce-coalescing.mjs` registers a
probe function, sends a burst, and counts the runs that execute.

`inngest-cli` **1.27.0** dev server, SDK 4.5.0. Re-check these on a CLI upgrade —
the version is the measurement's scope, not a footnote.

| Burst                                                         | Debounce           | Runs                              | Contract |
| ------------------------------------------------------------- | ------------------ | --------------------------------- | -------- |
| 4 events, no debounce (the CONTROL)                           | —                  | 4                                 | 4 ✓      |
| 4–8 same-key events, sent SERIALLY                            | `2s` (± `30s` cap) | **1**, carrying an ARBITRARY one  | 1 ✓ ⚠️   |
| the same 4–8, sent concurrently or as ONE batched `send`      | `2s` (± `30s` cap) | **1**, carrying an ARBITRARY one  | 1 ✓ ⚠️   |
| 30 DISTINCT keys in one `send`                                | `2s` + `30s` cap   | **30**                            | 30 ✓     |
| 24 events, 18 across 3 keys + **6 whose key field is ABSENT** | `2s` + `30s` cap   | **4** — 3 keyed + **1 for all 6** | 9 ✗      |
| same key, one event every **1.0 s** for 20 s                  | `30s` + `5s` cap   | **5**, at ~5 s intervals          | ✓        |
| same key, one event every **0.9 s** for 20 s                  | `30s` + `5s` cap   | 4                                 | ✓        |
| same key, one event every **0.7 s** for 14 s                  | `2s` + `4s`/`10s`  | **1**, only after the stream ends | ✗        |
| same key, one event every **0.5 s** for 20 s                  | `30s` + `5s` cap   | **1**, only after the stream ends | ✗        |

**Coalescing is real. WHICH event survives is arbitrary — including for a serially-sent
stream.** The property
`docs/decisions/code-graph-index-fleet.md` §7.3 leans on — a push storm to one
repo produces one refresh of the newest head — holds on the dev server in every
burst shape tried, including the one a bulk producer actually emits (the whole
array in a single `send`). No run was dropped, and
`error enqueueing debounce job: queue item already exists` appeared **zero**
times across ~20 trials. **Distinct keys stay independent**: one key's burst
never swallowed another's run.

**⚠️ WHICH event survives is not defined for ANY send shape — corrected 2026-08-22
(MOTIR-3398).** This section previously claimed the last event wins for a serially-sent
stream, and `tests/jobs/debounce-burst.test.ts` asserted it. **A measurement falsifies
it.** With `burst()` instrumented to read the dev server's OWN `received_at` per event
(the sibling field `ts` is client-supplied and echoes whatever the sender sets), six
SERIAL awaited sends landed inside **one millisecond** on the scheduler's clock —
`schedulerSpanMs: 0`, one run, nothing stalled or split — and that run carried **event
5**. On a second occasion, event **4**. Two of ten instrumented runs, `inngest-cli`
1.27.0 / SDK 4.5.0.

So serial sending buys no ordering at this timescale: the debounce keeps an arbitrary
member, exactly as it does for a batched `send`. The old claim survived because it
presents identically to a real stall in a CI log — one run, a non-last payload — and was
diagnosed as a timing failure four times before the scheduler-side span (MOTIR-3371)
made the two distinguishable. For
`system.code-graph-refresh` this is immaterial: the run re-reads the repo's
default-branch head rather than reading anything off the event. That is exactly
the property to check before relying on "the latest event wins" — a job that
takes a SHA from the event and is fed by a batched producer can coalesce onto a
stale one.

**⚠️ An UNRESOLVABLE key does not disable the debounce — it MERGES.** When the
`key` expression names a field the event does not carry, the scheduler does not
fall back to "not debounced": every such event lands in ONE shared bucket, so N
unrelated events produce ONE run and N−1 units of work vanish with nothing raised
to the sender. Inngest documents no behaviour here, so this is measured. **The
rule that follows: a debounce `key` may only name fields the event's payload type
makes REQUIRED.** `key` is a string, so TypeScript cannot check it and a field
turned optional later breaks it silently. MOTIR-2902 is the instance —
`key: 'event.data.parentId'` on `work-item/created`, where a ROOT item has no
parent, so every root creation in a bulk import debounced against every other
one; its E2E saw 3 derivation runs where it required 4.

**⚠️ `timeout` does NOT cap the deferral for a stream faster than ~1 event/second.**
At a 1.0 s inter-event gap the cap fires on schedule; at 0.7 s and below it never
fires at all and the run lands only after the stream stops — the exact scenario
`timeout` exists for. Treat the cap as a best-effort bound on a slow stream, and
never as a latency guarantee. (Whether a job is EXPOSED depends on its producer:
`system.code-graph-refresh` is driven by default-branch pushes to one repo, which
do not arrive faster than one a second, so its `15m` cap is unexercised rather
than wrong.)

### What this does NOT say

- **This was the dev server — the one CI's E2E lane and every self-hosted
  deployment runs — not Inngest Cloud.** Production uses Cloud, whose scheduler
  is a different implementation and was NOT measured: a controlled probe needs
  the production account's `INNGEST_EVENT_KEY`, which is a Fly secret, and firing
  probe events into the production environment is human-gated (see "Cloud
  wiring"). Inngest's own documentation states the coalescing contract without
  distinguishing environments, and documents nothing about an unresolvable key —
  so for Cloud the first row of the table is a documented promise and the two ✗
  rows are UNKNOWN, not known-good.
- **A dev-only defect is still a defect.** Two of the three findings above bite
  exactly where nobody is watching: self-hosted runs on this scheduler, and CI's
  E2E lane is the only place any test can observe a debounce at all.

### The guard

`tests/jobs/debounce-burst.test.ts` boots the pinned `inngest-cli` and asserts
the first three rows of that table against the real scheduler — one run for a
same-key burst, one run PER distinct key, and the keyless collapse pinned as a
characterization so a change upstream surfaces here. **Any job that grows a
`debounce` belongs in it**: a scheduler that drops runs then fails the build
instead of a story. It also asserts that `system.code-graph-refresh`'s key names
only fields `CodeGraphRefreshData` makes required, which is the compile-time half
of the unresolvable-key rule.

To re-run the standalone probe: start `node_modules/inngest-cli/bin/inngest dev
-u http://localhost:3988/api/inngest --no-discovery --port 8488
--connect-gateway-port 8489 --connect-gateway-grpc-port 50252
--connect-executor-grpc-port 50253` (any free ports — a sibling dev server on
8288 will silently take the default and the harness will talk to the wrong one),
then `LAB_MODE=same-key|distinct-keys|absent-key|no-debounce INNGEST_DEV=1
INNGEST_BASE_URL=http://localhost:8488 node
scripts/experiments/inngest-debounce-coalescing.mjs`. `LAB_SEND=serial|parallel|batch`
selects how the burst is delivered and `LAB_GAP_MS` spaces it out — the two knobs
the last four rows of the table turn.

### The ENGINE's debounce — the same option, implemented by us (MOTIR-3483)

`docs/decisions/job-queue-foundation.md` §9 chose the mechanism while rejecting
pg-boss, whose `singleton`/throttle options were the strongest argument for
adopting a library at all: _"a `run_at` that is pushed forward on each same-key
arrival, which is a column and an upsert on a table we own, not a subsystem."_
That is what shipped. `job_queue` carries `debounce_key` and
`debounce_first_seen_at`, and `lib/jobs/engine/debounce.ts` is the arithmetic.

**How the key is resolved, and when the resolver REFUSES.** One resolver serves
`debounce.key` and `idempotency` alike (`lib/jobs/engine/eventExpression.ts`).
The grammar is a `+`-joined sequence of `event.data.<field>` terms and
single-quoted literals — the shape `system.code-graph-refresh` declares — and it
is TOTAL: an expression it cannot parse throws at REGISTRATION, as the definition
module is evaluated, so every process that loads the registry sees it. **This is
the one place the engine is deliberately STRICTER than Inngest**, and it is the
finding directly above that makes it worth being: there an unresolvable key does
not disable the debounce, it MERGES, and N unrelated events become one run with
nothing raised to the sender. Here the job cannot start.

**What pushes `run_at` forward.** The enqueue looks for a PENDING, unclaimed run
holding `(job_id, debounce_key)`, locks it with `SELECT … FOR UPDATE`, moves its
`run_at` to `now + period` and REPOINTS its `event_id` at the newer event — which
is what makes the coalesced run carry the latest push rather than the first.
Two concurrent FIRST arrivals have no row to lock, so both insert; a PARTIAL
UNIQUE index on `(job_id, debounce_key) WHERE debounce_key IS NOT NULL AND
state = 'pending'` catches the loser, which then RETRIES the coalesce. Reading
that `P2002` as "already enqueued" — which is right for the idempotency
constraint beside it — would silently discard a push.

**A same-key event arriving while the debounced run is EXECUTING enqueues a NEW
run.** The claim clears `debounce_key`, so the window belongs to a pending row
and a push during an index is never folded into work that has already started.
Clearing it at the claim is also what keeps a RETRY safe: `rescheduleAt` puts the
row back to `pending`, and a row that still carried its key would collide with
the row that push enqueued — a unique violation on the retry path.

**The deferral cap FIRES here, and this is where the engine is better than what
it replaces.** MOTIR-2994 measured that Inngest's `timeout` does not fire for a
stream faster than ~1 event/second — the exact case it exists for. The engine
stamps `debounce_first_seen_at` on the first arrival and refuses to push `run_at`
past `first_seen + timeout`, whatever the arrival rate. A deliberate divergence
from MOTIR-3413's "no job's observable behaviour changes", stated on the day it
was made rather than discovered later — and one that can only make a run happen
SOONER than the lane it replaces would have.

**A payload that cannot supply the key gets its own row** (not coalesced, not
merged) — the opposite of Inngest's behaviour, and the safe direction: losing
coalescing costs money, merging loses events.

**The guard** is `tests/jobs/engine-debounce.test.ts`, against real Postgres —
including the concurrent first arrival, which a serial test cannot see.
`tests/jobs/debounce-burst.test.ts` (the Inngest-side guard above) is its sibling,
not its replacement: the two lanes are measured separately because they are two
implementations.

## Wall clock — the step is the unit, and every I/O call needs a deadline

**A retry budget does not help a job that runs out of TIME**, and this is the
failure mode that has actually cost us production runs (MOTIR-1974). Three rules
follow, and they are coupled — changing one means checking the others.

**1 · A step is the unit of DURABILITY. It used to be the unit of the platform's
TIMEOUT as well, and that half has expired (amended 2026-08-26, MOTIR-3488).**

This rule read: _"The platform timeout applies to an INVOCATION, i.e. to a step …
A handler that does everything in one `step.run` has opted out of checkpointing
entirely: it must fit end-to-end in a single invocation, and if it doesn't, it is
killed mid-flight on **every** attempt and burns its whole budget getting
nowhere."_ **That was true, and it was true of VERCEL.** `app/api/inngest/route.ts`
declares `maxDuration = 300`, which is a Next.js route-segment directive the
DEPLOYMENT PLATFORM enforces; motir-core has run as a long-lived Fly process
since MOTIR-2384 (`Dockerfile` ends `CMD ["node", "server.js"]`), and the
Postgres job engine's worker is its own process group with a renewed lease. A
long-running handler is not killed by anything of ours.

**What is true now, and it is a different sentence:**

- **On the POSTGRES ENGINE**, a run may span half an hour and that is the
  documented NORMAL case — `lib/jobs/engine/worker.ts` says so, renewing a 60 s
  lease every 20 s so a long run and a dead worker stay distinguishable. A step
  is what survives a WORKER RESTART: `step.run` memoizes a completed operation in
  `job_step`, and a reclaim re-invokes the handler from the top and replays it.
  So the question a step answers is no longer "does this fit?" but **"if this ran
  a second time, what would exist twice?"** —
  `docs/decisions/job-queue-foundation.md` §13 states the rule and tables the
  per-call-site disposition for both container supervisors.
- **On the INNGEST lane**, the executor still re-invokes the handler at each step
  boundary, so rule 4 below (code outside a step runs once per PASS) is unchanged
  and still bites. What has gone is the CEILING, not the checkpointing.

**2 · `/api/inngest` still declares `maxDuration = 300`, and nothing of ours
enforces it.** Every job is invoked through that one route. The declaration is
kept — it is the honest statement of what a SERVERLESS deployment of this app
would get, and MOTIR-1974 declared it precisely so the number would be reviewed
rather than inherited — but read it as a property of a platform we left, not as a
budget any step must fit inside today. The one place it is still asserted against
is `tests/ciFleet/fleetTimeBudgets.test.ts`, deliberately: rule 3's inequality
needs SOME ceiling to be stated against, and re-choosing that number is its own
work item rather than a side effect of this amendment.

**3 · Every network call a job makes carries a deadline.** `fetch` has none of
its own: an unresponsive dependency is waited on until the platform kills the
invocation, and that arrives as a bare `FUNCTION_INVOCATION_TIMEOUT` 504 with no
step output — indistinguishable from a crashed app, and nothing a retry budget
can reason about. A bounded call fails as a typed error instead, INSIDE the
budget, and retries meaningfully. The deadlines in play:
`MOTIR_AI_REQUEST_TIMEOUT_MS` (30s) in `lib/ai/motirAiClient.ts` — the only one
left on that boundary since the 180s tarball-upload deadline went with the
upload client itself (MOTIR-2138) — `REPO_TARBALL_TIMEOUT_MS` (60s) in
`lib/git/provider.ts`, `RUNNER_JIT_REQUEST_TIMEOUT_MS` (15s) in
`lib/github/runnerJitConfig.ts`, and `ORCHESTRATOR_REQUEST_TIMEOUT_MS` (30s) in
`lib/orchestrator/errors.ts`. **Their sum along the slowest step must stay under
a STATED ceiling** — currently the route's `maxDuration`, for want of a better
number (rule 2), and no longer because a platform enforces it. That inequality is
what guarantees a hung dependency surfaces as a typed failure.

⚠️ **The inequality survives rule 1's amendment; the WORD does not, quite.**
Nothing kills an invocation any more, so the failure it prevents has changed
shape: a step with no clock on its calls now hangs FOREVER, holding a lease it
keeps renewing, and a run that never returns is worse than one that is killed —
there is no error, no attempt spent, and nothing to alert on. So the deadlines
matter MORE than they did, and `maxDuration` is what the ceiling is still stated
against for want of a better number (rule 2).

The fleet's boot step is the worked example of the sum, because it is the one
step that makes TWO external calls: the JIT mint and the container provision.
Both deadlines are re-exported as `FLEET_TIME_BUDGETS.mintDeadlineMs` /
`.containerCallDeadlineMs` and `tests/ciFleet/fleetTimeBudgets.test.ts` asserts
their sum against `stepWorkBudgetMs` and the route's `maxDuration` — so the
inequality is a failing test rather than a paragraph. (It reads the route's
number deliberately: rule 2 keeps that declaration as the one STATED ceiling, and
re-choosing it is its own work item rather than a side effect of MOTIR-3488.) It was a paragraph until
MOTIR-2011: the boot path had the right SHAPE (one small step) with no CLOCK on
either call, and a step that makes one call still runs forever if the call does.

**What this looked like when it was wrong.** `system.code-graph-index` ran a
tarball fetch plus one motir-ai upload per project inside a single `step.run`,
against an undeclared `maxDuration`, with no deadline on either call. All five
production repos exhausted all five attempts on `FUNCTION_INVOCATION_TIMEOUT`
and dead-lettered — including a repo small enough that size cannot explain it.
The first fix (MOTIR-1974) split it into one `resolve-target` step plus one
`index-project:<id>` step per project — a shape `system.code-graph-refresh` kept
running until MOTIR-2057 (`lib/jobs/codeGraphSteps.ts`, now deleted; refresh
drives the container shape below, keeping only its per-repo debounce, after the
step-per-project shape left it failing ~68% of `motir-core`'s refreshes on the
180 s motir-ai deadline). MOTIR-2027 took the INDEX job off
the bytes path entirely: it dispatches one container per (repo × project) and
supervises it as `index-boot:<id>` → `ctx.step.sleep` → `index-poll:<id>:<n>` →
`index-settle:<id>` (`lib/jobs/indexFleetSteps.ts`), so the run spans minutes and
no step does — the same move `system.ci-runner-boot` made in MOTIR-2007. The
ledger contract is unchanged either way: ONE `job_run` per repo carrying one
`output.repoRef`, which is what makes a failed container fail the RUN rather than
record a diminished success.

**4 · Code OUTSIDE a step runs once per PASS, not once per run.** The same
re-invocation that makes rule 1 true also re-executes everything in the handler
body that is not inside a `step.run` — once for every step boundary the run
crosses. The count is therefore a property of the run's step TOPOLOGY, not of
the handler: adding one bookkeeping step adds one execution of every un-stepped
line, silently, in an unrelated card's diff. And the value the FUNCTION returns
is the last pass's, so an un-stepped body that is not idempotent also makes
Inngest's reported run output disagree with the `job_run` row (which memoized
the first pass's).

Almost always the fix is to wrap the work in a step. **This paragraph used to
continue: _"When the work is LONGER than `maxDuration` — rule 2's ceiling on one
step — the answer is still steps: split it into short ones and let the RUN span
the time, waiting between them with `step.sleep`."_ On the Inngest lane that is
still the shape. It is no longer an answer to a CEILING** (rule 1), and on the
Postgres engine it is the wrong instrument: a `step.sleep` there is a
`JobStepYield`, a re-enqueue, a re-claim and a replay of every earlier step, so a
loop that polls _N_ times costs on the order of _N²_ memo lookups. **Split for
DURABILITY, not for duration** — around the operations whose repetition would
leave something existing twice.

`system.ci-runner-boot` is the worked example, and it is worth reading as a
sequence of THREE fixes now (MOTIR-2002, MOTIR-2007, MOTIR-3485). Its supervision
watches a container for up to an hour. It first stayed un-stepped and was made
explicitly **replay-aware**, memoizing its outcome onto the provisioning intent
keyed by the dispatch. That made the outcome consistent, but it could not make
the work FIT: the invocation was killed at 300s, so teardown never ran and the
intent held a fleet slot until the reaper. MOTIR-2007 took the shape apart —
one `step.run` to boot, then a `step.sleep` + one-provider-read `step.run` per
poll, then a `step.run` to tear down. Every step was milliseconds, the run spanned
the hour, and the memo columns were dropped because step memoization gives
once-per-run for free.

**MOTIR-3485 then took the poll loop back out**, because the ceiling it was
fitting inside had gone. What is left is boot and teardown as memoized steps with
an ordinary `while` loop between them — 2 step rows for a full-length CI job
instead of ~2 400. **None of MOTIR-2007's guarantees was given up**: the boot
still runs once per run (memoization, unchanged), teardown is still reached on
every path out of the loop (an ordinary `finally`, which a long-lived process
makes trustworthy again — and which reaches a THIRD exit the stepped form could
not, a throw from inside the loop), and the single attempt still survives a
restart (a lease reclaim REFUNDS it). The index fleet made the same move in
MOTIR-3484.

**The lesson is the ORDER of the three.** Reach for replay-awareness only when the
work genuinely cannot be split. Reach for splitting when the repetition costs
something. And **when a shape exists to satisfy a platform constraint, write down
which constraint** — MOTIR-2007's comments did, which is the only reason anyone
could tell, four stories later, that the shape had outlived its reason rather
than encoding a durability requirement. And note what un-stepped code
costs you either way: teardown cannot be reached from a `catch` (the executor
finalizes a failed run before running a step scheduled from one — see the
`onFailure` note above), so a stepped loop must return TYPED results rather than
throw, and route its only exit into the teardown step.

⚠️ **Testing a `step.sleep` loop.** `InngestTestEngine` records state only for
steps that RAN, and a sleep never runs — so an un-stubbed `step.sleep` is
re-found forever and `execute()` never resolves. It surfaces as a test TIMEOUT,
which reads like a slow test rather than a missing stub. Pre-fulfil each sleep by
id in the `steps` option (`{ id: 'my-wait:1', handler: () => null }`), and supply
more than the loop can consume.

⚠️ **The two container supervisors no longer have one, and the OPPOSITE problem
replaced it (MOTIR-3484 / MOTIR-3485).** They used to be this note's worked
examples, and `sleepSteps()` helpers in
`tests/jobs/ci-runner-fleet.test.ts` and `tests/helpers/indexFleet.ts` existed for
them. Their waits are ordinary `await`s now, so nothing hangs — and a job-level
test instead SLEEPS FOR REAL at the shipped cadence unless it shortens it.
`driveIndexFleetFast()` (`tests/helpers/indexFleet.ts`) and `superviseFast()`
(`tests/jobs/ci-runner-fleet.test.ts`) do that through the services' own options
seam, changing the cadence and nothing else. The cadence itself is asserted BY
VALUE in `tests/jobs/supervisor-cutover-story-gate.test.ts`, which is where a
number belongs.

**A retrying job looks identical to a healthy one.** `defineJob` writes its
`running` ledger row in a memoized step, so a retry replays it: the row stays
`running` with `attempt` frozen at 0 until the budget is spent. Until the DLQ
row lands, a dying job and an in-flight one are indistinguishable on the
dashboard — so when you are watching a long job, watch `job_run_dlq`, not
`job_run.status`.

## Dead-letter queue

When a job exhausts its retry budget, the wrapper writes a row to `job_run_dlq`
**in the same transaction** that flips the `job_run` to `failed` — so a failed
run and its replayable record always land together. The DLQ row captures
everything needed to replay: the `function_id`, the original `event_name` +
full `event_data` payload, the serialized `failure`, the `attempts` count, and
`first_failed_at` / `last_failed_at`. This is the durable operator surface
(the 1.6.5 dashboard's DLQ tab reads it); Inngest's own failure view stays
available for deep tracing but is **not** the source of truth for operator
action.

**Operator runbook.**

- **How DLQ rows appear** — automatically, once a job's retries are exhausted.
  Each row is one dead-lettered run. `replayed_at` is null until you replay it.
- **How to replay** — click **Replay** on the dead-letter row in the operator
  dashboard (see below). Under the hood the owner-gated `jobsDashboardService`
  calls `replayDLQ(dlqId, tx)` (`lib/jobs/dlq.ts`), which re-emits the original
  event — with a **re-shaped idempotency key** (see below) — and stamps
  `replayed_at` so the action is auditable.
- **When NOT to replay** — if the failure was a bad payload or a since-removed
  code path, replaying just re-fails. Fix forward first; replay only transient
  infrastructure failures (provider outage, expired upstream token now renewed).

**Idempotency on replay (1.6.6).** A replay re-emits the original event but
**re-shapes its idempotency key** to `{original}:replay:{dlqId}`. This is
deliberate: an operator replays precisely when they've fixed a transient failure
and want the job to run **now** — but the original key is, by definition, still
inside Inngest's dedup window, so re-emitting it unchanged (the 1.6.4 behavior)
was silently **dropped**, while the dashboard still toasted success and stamped
`replayed_at`. Re-keying makes the replay a genuinely new event that actually
runs, so the Replay button does what it says. The new key is derived from the
**DLQ row id**, so a double-click of Replay on the same row still dedups to one
re-run (no double-delivery), while a genuinely new failure replays
independently. A job with **no** idempotency key was always replayed
unconditionally and is unaffected. See `PRODECT_FINDINGS.md` #40.

## Event-level idempotency on the Postgres engine (MOTIR-3459)

`defineJob`'s `idempotency` option is an Inngest CEL template evaluated against
the triggering event. **`email.send` is the only job in the tree that declares
one**, as `'event.data.idempotencyKey'`. Inngest evaluates it server-side; the
engine evaluates it itself, in `lib/jobs/engine/idempotency.ts`.

**Which templates the resolver accepts.** Exactly one form: `event.data.<field>`,
one level deep. **Anything else THROWS at registration** — as the definition
module is evaluated, so every process that loads the registry fails loudly. That
is deliberate and is the opposite of the tempting behaviour: a resolver returning
`null` for a template it does not recognise would let a future job keep its
`idempotency` option, keep passing review, and quietly stop deduplicating. The
symptom of that is a second password-reset email to a real person, on the retry
path nobody exercises by hand. To support a richer template, extend the resolver
and its test together — never drop the option.

A missing or non-string VALUE resolves to `null`, which means "do not dedupe".
That is not the same silent arm: the template has already been validated, so it
means the EVENT carried no key. Deduping on a synthesised placeholder would
collide every such event with every other one and drop all but the first.

**How it dedupes: a constraint, not a lookup.** The resolved key is denormalised
onto `job_queue.idempotency_key` at enqueue, under a PARTIAL UNIQUE index on
`(job_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, and a `P2002` is
read as "already enqueued". A check-then-insert would be a read-derived write
with a race in the middle, and the race here is two clicks on one button. This is
the same pattern the dispatcher already applies to its `(event_id, job_id)`
constraint.

### ⚠️ Engine dedup is UNBOUNDED where Inngest's is WINDOWED — chosen, not inherited

**This is a real difference in observable behaviour, and it was decided rather
than absorbed.** Inngest dedupes same-key events inside a window; a unique
constraint dedupes forever.

Forever is the better behaviour for the keys actually in use — a password-reset
token and an invite token should each produce ONE email, not one per window — and
it is race-free where a windowed query is not. It is recorded here because
MOTIR-3413's scope boundary says no job's observable behaviour changes, and an
argued exception written down on the day it is made is a decision, while the same
exception found six months later by someone comparing lanes is a bug report. If a
window is ever wanted instead, that is its own decision and it needs the window's
number and where the number came from.

**A DLQ replay is not affected on either lane.** `lib/jobs/dlq.ts` re-shapes the
key to `{original}:replay:{dlqId}` before re-emitting, on the Inngest arm AND the
engine arm. The engine arm had nothing to be dropped by until dedup existed;
replaying with the original key would now be swallowed as a duplicate and hand
the operator a success toast for a run that never happened.

## Cutting a job over to the Postgres engine — the operator's view

**`MOTIR_POSTGRES_JOB_IDS` is a comma-separated set of `defineJob` ids.** An id
in the set runs on the Postgres engine; an id absent from it runs on Inngest.
Absent is the default, which is a safety property: a job nobody has thought about
cannot be silently migrated, because the only way onto the new engine is for
someone to name it.

- **It is read LIVE**, on every emit (`lib/jobs/engine/cutover.ts`), not captured
  at module load. A change takes effect without a deploy.
- **Rolling back is removing the id.** Same one-line change, same immediacy. That
  reversibility is what the whole migration is built on.

### ⚠️ "A change takes effect without a deploy" is true of the SWITCH and false of a NEW JOB

The bullet above is about the ENV VAR, and it is exact: `routedToEngine` re-reads
`process.env` on every call, so moving an id between lanes needs no deploy. It is
also the sentence that makes the following trap invisible.

**`fly secrets set` restarts the machines on the CURRENT RELEASE, not on `main`.**
The scheduler and the dispatcher both iterate the ENGINE REGISTRY, and the
registry is whatever the running IMAGE's `lib/jobs/definitions` evaluated to. So
routing an id whose job is not in that image routes it **nowhere**: the scheduler
never sees a definition to compute a fire for, `defineJob`'s Inngest guard never
runs because Inngest has no such function registered either, and the job has no
timer on either lane. Nothing errors. The secret reads back byte-for-byte correct
from every machine, which is the reassuring measurement that does not answer the
question.

**Measured on 2026-08-27** (MOTIR-3682): `system.public-follow-digest-tick` and
`public-follow/digest` were routed at 10:32Z and 10:44Z. Both were absent from the
running image, because the last deploy was **v166 at 01:50Z** and the pull request
that added them merged at 07:07Z — releases v167–v172 were all `secrets set`
restarts on that same image. `plan-drift/transitioned`, routed in the same edit,
WAS in the image and did start running. Same command, same secret, two different
outcomes, and only one of them visible from the secret.

**So confirm the job is in the RUNNING IMAGE before reading the ledger for it:**

```bash
# the deployed image, and whether it knows the job at all
fly ssh console -a motir-core -C "sh -c \"grep -rlm1 '<the job id>' /app/worker; echo \$FLY_IMAGE_REF\""
# a hit  → routing it takes effect on the next scheduler tick
# nothing → it has not deployed yet; the ledger will stay empty and that is not a bug
```

An empty `job_run` for a freshly-routed id has two causes that look identical —
_the job has not fired yet_ and _the job is not in the image_ — and the grep above
is what separates them.

### The CENSUS — and why the safety default is not enough on its own

**The default protects a forgotten job from being MIGRATED. It does nothing to
make a forgotten job VISIBLE**, and while this migration was in flight three jobs
joined the codebase and were routed by nobody: `system.public-follow-digest-tick`
and `public-follow/digest` (#2344), and `plan-drift/transitioned` (#2309). Every
cutover card had scoped itself by counting the population — _"the 20
event-triggered jobs"_, _"the 14 SCHEDULED jobs"_ — and every count was correct on
the day it was taken. Nothing noticed the counts and the codebase coming apart;
two of the three were found by hand while fixing the first.

So `tests/jobs/every-job-declares-its-lane.test.ts` (#2348) holds a **census** —
two checked-in lists, `MIGRATED_TO_ENGINE` and `DELIBERATELY_ON_INNGEST`, that
between them name **every** registered job — and asserts it is TOTAL over the
engine registry in both directions. A job cannot then join the codebase without
someone stating its lane: the build fails, by name, on the pull request that adds
it. `DELIBERATELY_ON_INNGEST` going EMPTY is the condition MOTIR-3418
(_"Retire Inngest"_) is premised on, and the honest way to check that premise.

**⚠️ THE CENSUS IS A DECLARATION; THE SECRET IS THE DEPLOYMENT — keep them equal
by hand.** No test can read production, and none should: CI would go red for an
operator action taken minutes earlier and green when somebody changed production
rather than the code. So changing a job's lane is TWO edits plus a read-back, and
doing one without the other is a drift nothing catches:

```bash
# 1. the declaration — move the id between the two lists, and ship it.
# 2. the deployment — set the secret:
fly secrets set -a motir-core "MOTIR_POSTGRES_JOB_IDS=<the full list>"
# 3. the read-back — from inside a machine, NOT from the console:
fly ssh console -a motir-core -C "node -e \"console.log(process.env.MOTIR_POSTGRES_JOB_IDS)\""
```

**⚠️ Step 2 is READ-MODIFY-WRITE on a value two people can be editing.** The
secret is one string, `fly secrets set` replaces it whole, and there is no
compare-and-swap. Two sessions appending an id each will lose one of them — on
2026-08-27 two runs raced on exactly this and the second append re-added an id the
first had already written, leaving a duplicate. That one was harmless
(`parseRoutedJobIds` builds a `Set`), and a LOST id would not have been. Read the
value immediately before you write, write once, and read it back.

**How to confirm a job actually moved.** Two tables, both for that job id:

- `job_queue` — a row per enqueued run (`job_id`, `event_id`, `state`).
- `job_run` — the ledger row the operator dashboard renders (`function_id`,
  `started_at`, `status`).

A `job_queue` row with no `job_run` row means it was enqueued and not yet
claimed; neither means the event never reached the engine at all.

**⚠️ What the INNGEST dashboard shows for a migrated job, and why it is not a
failure.** The Inngest function stays registered — the serve route mounts every
job, and an event with a SPLIT subscriber set still reaches Inngest for the
subscribers that have not moved. So Inngest keeps delivering to the migrated job,
and `defineJob`'s guard returns immediately:

```json
{ "skipped": "routed-to-postgres-engine", "jobId": "email.send" }
```

**That is the system working correctly.** It returns a marker rather than
`undefined` for exactly this reason: a silent no-op on that dashboard is
indistinguishable from a job that broke, and the obvious response to "it looks
like it did not run" is to roll back something that was fine.

## Operator dashboard

`/settings/workspace/jobs` (Subtask 1.6.5) is the in-app surface for the ledger
above — no one needs Inngest's own dashboard for day-to-day operation. It's a
workspace-settings sub-page (a "Job runs" link under the sidebar's Settings
group) backed by `lib/services/jobsDashboardService.ts`.

**Tabs.**

- **Recent runs** (default) — every `job_run` for the active workspace,
  newest-first, 50 per page. Columns: status pill (succeeded / failed /
  running), function, event, attempts, started, duration, and the failure's
  first line (full JSON via the row's **View** dialog). A status-filter row
  (All / Succeeded / Failed / Running) narrows the list.
- **Dead letter** — the workspace's `job_run_dlq` rows, newest-failure-first.
  The tab carries a badge with the count of **not-yet-replayed** entries.
  **Replay** is gated to the workspace **owner** (others see a disabled button
  with a tooltip); **View** opens the failure + the replayable event payload.
- **System** — visible only to a `PLATFORM_ADMIN_EMAIL` operator. Same shape as
  Recent runs but spans **all** workspaces, including untenanted system jobs
  (`workspace_id IS NULL`). This is the pre-Epic-6 escape hatch; real
  platform-admin roles replace the email check in Epic 6 (PRODECT_FINDINGS #36).

**Scoping.** Tenant reads run under `withWorkspaceContext`, so the `job_run` /
`job_run_dlq` RLS policies scope every row to the active workspace (the repo
also filters by `workspace_id` explicitly, so the scope holds in dev/CI where
the superuser bypasses RLS). The System tab is the one `withSystemContext` read.

**No realtime in v1.** There is no polling or websockets — a **Refresh** button
reloads the data. Auto-refresh is deferred to a holistic reporting pass in
Epic 6 (PRODECT_FINDINGS #37).

## Scheduled jobs

A job runs on a schedule instead of an event when you give it a `cron`:

```ts
export const dailyHealthCheck = defineJob(
  { id: 'system.daily-health-check', cron: '0 9 * * *', retryPolicy: 'none' },
  () => ({ ok: true }),
);
```

**There IS a scheduler now, and it is not a service.** This line used to read
_"Inngest's cron trigger means there's no separate scheduler service to run"_, and
the constraint it described has gone rather than the sentence having been wrong:
on the Postgres engine a **tick inside the existing worker process**
(`lib/jobs/engine/scheduler.ts`) turns a cron expression into a `job_queue` row.
It adds no machine, no process and no environment variable — which is why the
correction is worth stating rather than deleting. A job still on Inngest is still
scheduled by Inngest, exactly as before; which engine fires a given job is the
per-job cutover switch's answer (`MOTIR_POSTGRES_JOB_IDS`), not this document's.

### Where the scheduler runs, and the guard that makes that safe

It rides the worker's claim loop, beside the claim rather than on a timer of its
own. A tick that runs late still enqueues the fire it OWED — every fire instant
is computed from the clock against the cron expression, never as "one interval
since the last tick" — so the tick's cadence decides latency and can never decide
which fire.

⚠️ **It refuses to start against an empty registry.** The engine's tables hold only
jobs whose definition module has been EVALUATED, and `scripts/worker.ts` carries a
side-effect `import '@/lib/jobs/registry'` that looks unused for exactly that
reason. A scheduler over an empty registry enqueues nothing, forever, in complete
silence — indistinguishable from a deployment with no cron jobs. So start-up
throws, naming the missing import, rather than proceeding.

### What a MISSED tick does — the catch-up policy

Every scheduled job declares a `catchUp` disposition beside its `cron`, and the
compiler will not let it omit one:

| disposition | on restart, the scheduler…                                    |
| ----------- | ------------------------------------------------------------- |
| `all`       | enqueues **every** fire owed across the gap, oldest first     |
| `latest`    | enqueues **only the most recent** owed fire                   |
| `skip`      | enqueues **nothing**; the next scheduled fire is the next run |

**Thirteen of the fourteen take `latest`** — each is a convergent sweep, so one
run answers for every fire it missed — and `system.ci-runner-provision-sweep`
takes **`skip`**, because at `* * * * *` the next fire is under a minute away and
a long outage would otherwise fan out hundreds of ticks against a batch ceiling.
No job takes `all` today.

**The per-job table and the reasoning live in
[`docs/decisions/job-queue-foundation.md` §11](decisions/job-queue-foundation.md),
and are deliberately not repeated here** — two copies of an argument disagree the
first time one is edited. §11 is the record; this section is the reference.

⚠️ **`retryPolicy` is not a catch-up licence.** `idempotent` says a handler may
safely run the same tick twice. It says nothing about whether a tick that is now
six hours _stale_ is worth running at all. The two are independent axes and every
scheduled job declares both.

### How a scheduled run is identified

- **On the ledger**, by `event_name = scheduled.{job_id}` — unchanged, and the
  key `jobScheduleHealthService` groups on.
- **On the queue**, by `job_queue.scheduled_for`: the cron FIRE INSTANT the row
  stands for, never the moment it was enqueued. A unique on
  `(job_id, scheduled_for)` is what guarantees **one run per tick regardless of
  how many workers are running** — the same NULL-never-equals-NULL property that
  keeps the `(event_id, job_id)` unique off scheduled rows, read the other way
  round. `run_at` is that same instant, so a caught-up run is claimable at once
  and the claim's `ORDER BY run_at` puts the oldest owed work first.

A handler cannot currently tell that it is running late: the engine hands a cron
run an empty payload, so `scheduled_for` sits on the row and never reaches `ctx`.
Every job today is a convergent sweep that does not need to know; the two that
would benefit are named in §11.6.

Cron jobs are uniform with event-triggered jobs in the ledger: the wrapper
records the `job_run` row's `event_name` as the synthetic `scheduled.{job_id}`
(a cron run carries no real triggering-event name), so the dashboard treats both
kinds the same, and a scheduled run that fails surfaces in the DLQ exactly like
any other job. `system.daily-health-check`
(`lib/jobs/definitions/dailyHealthCheck.ts`) is the reference example — it proves
the scheduled path end-to-end, and as of MOTIR-1970 it also carries the
**schedule-health probe** (see "Registration" below). `system.attachment-gc`
(`lib/jobs/definitions/attachmentGc.ts`, Subtask 5.2.7) is the first real
scheduled job: the daily orphan-attachment sweep (unlinked rows past the 7-day
safety window → blob, then row), cursor-bounded per run and idempotent, with
its `{ scanned, deleted, failed }` summary persisted as the run's `output`.

Cron jobs live in the `system.*` namespace (untenanted — `workspace_id` is null)
and are **not** emitted via `sendEvent`. The cron syntax is standard 5-field
(`min hour day month weekday`); see the
[Inngest cron docs](https://www.inngest.com/docs/features/inngest-functions/cron).

## Cloud wiring (human-gated)

Going live in production requires steps a coding agent can't do (dashboard
access, secrets, an Inngest account). Tracked in PRODECT_FINDINGS #30 and as a
dedicated manual Subtask:

1. Take `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the Inngest
   dashboard and set them as Fly secrets on the app:
   `fly secrets set INNGEST_SIGNING_KEY=… INNGEST_EVENT_KEY=… -a motir-core`.
   Setting a secret triggers a release, so the app restarts holding them.
2. Confirm both are present — `fly secrets list -a motir-core` shows names and
   digests, never values.
3. Register the functions and then **watch a real run**: the deploy does this
   itself (step 1 of "Registration" below), and
   `gh workflow run inngest-sync.yml` is the manual lane. A green sync only
   proves the registration was accepted; only a `job_run` row proves invocation.

⚠️ **Do NOT install the official Inngest↔Vercel integration.** It was installed
by MOTIR-66 and **removed by MOTIR-2503** when the app moved to Fly, and it must
not come back: it holds `read-write:deployment` on the Vercel account and
rewrites the Inngest app's registered URL to whatever Vercel deployment it last
probed. That is the direct cause of the month-long silent outage described
below. Registration belongs to `.github/actions/inngest-sync` and to the custom
domain, which is the only URL Inngest can actually reach.

## Registration — the failure mode to know about (MOTIR-1970)

**Inngest only invokes functions it has been TOLD about.** The registration is a
`PUT` to `/api/inngest`; adding a job to `lib/jobs/registry.ts` and deploying is
not enough on its own. When the cloud's registered function list falls behind the
deployed build, every function added since is **dead, silently**: the event is
accepted, `inngest.send()` succeeds, **no run is created**, no `job_run` row is
written, and nothing errors anywhere. A dead job is indistinguishable from a job
nobody triggered.

That happened. Production ran from 2026-07-02 to 2026-08-01 with five jobs
consuming nothing — `system.code-graph-index`, `system.code-graph-refresh`,
`system.auto-plan-cadence-tick`, `system.ci-minutes-reconcile`,
`system.ci-actions-gate-sweep`. **Root cause:** the Inngest↔Vercel integration
probed the per-deployment `motir-core-<hash>.vercel.app` URL, and the Vercel
project ran Deployment Protection at `all_except_custom_domains`, so that URL
answered with a 302 into Vercel's SSO login. The probe never reached the app.
Only the custom domain `app.motir.co` was exempt. (This was MOTIR-66 recurring —
that card fixed the PREVIEW probe with a protection-bypass secret; production
deployment URLs were never covered.)

That integration is **gone** — uninstalled by MOTIR-2503 after the move to Fly,
which is why the section above tells you not to reinstall it. The two mechanisms
below are what replaced it, and they are what this repository relies on now.

Two mechanisms now close it, and they are deliberately independent:

1. **Deploy-time sync** — `ci.yml`'s `deploy` job PUTs
   `https://app.motir.co/api/inngest` as a step after the Fly release is live,
   and **fails the job** if the PUT does not return 200. Motir issues its own
   sync, against the domain protection does not cover, and a failure is a red
   check rather than silence. (`.github/workflows/inngest-sync.yml` is the same
   sync on a manual trigger, for the deploys CI does not make; both call
   `.github/actions/inngest-sync`. It fired on Vercel's `deployment_status`
   until MOTIR-2390 — an event Fly does not raise.)
2. **Runtime detection** — `system.daily-health-check` now runs the
   **schedule-health probe** (`lib/services/jobScheduleHealthService.ts`). It
   walks every registered cron job and fails the run when one has missed more
   than one consecutive tick, dead-lettering with the offenders named in the
   message. Cron jobs are the tripwire because they are the only ones whose
   silence is unambiguous — an event-triggered job that never ran may simply
   never have been triggered.

   ⚠️ **AND THE SAME SILENCE MEANS SOMETHING DIFFERENT FOR A MIGRATED JOB.** The
   probe is UNCHANGED and everything above stays true for every job still on
   Inngest. For a job routed to the Postgres engine there is no app registry to go
   stale, so an overdue verdict means **a dead worker or a stalled scheduler**
   instead. Same probe, same one-tick tolerance, different diagnosis — check the
   `worker` process before the Inngest sync. (This is also why
   `system.daily-health-check` declares `catchUp: 'latest'`: under `skip`, a
   routine worker restart spanning 09:00 would leave the probe two ticks stale
   and its first act the next day would be to report ITSELF overdue — a fault
   manufactured by the schedule rather than observed.)

The probe lives in `system.daily-health-check` **specifically because that job is
old** (2026-06-01) and is therefore registered in any stale sync the cloud could
still be holding: an OLD job checking on NEW ones. A checker defined alongside
the jobs it watches would be stranded by the very fault it exists to report — so
do not move it to a newer job, and do not re-declare that job under a new id.

**To re-sync by hand:** `curl -X PUT https://app.motir.co/api/inngest`. A 200 with
`{"modified": true}` means the registry actually changed. Re-syncing after a long
gap activates every dormant job at once, including crons with real side effects —
check what has been dormant before firing it.
