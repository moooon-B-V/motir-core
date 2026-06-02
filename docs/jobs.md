# Background jobs

Prodect runs background work on [Inngest](https://www.inngest.com/) — durable,
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
  singleton. Everything composes `defineJob` / `sendEvent` on top of it.
- **The 4-layer rule still holds.** No file outside `lib/jobs/**` and
  `app/api/inngest/**` may import the `inngest` SDK directly (enforced by an
  ESLint `no-restricted-imports` rule). Routes/services emit events via
  `sendEvent`; job handlers receive the injected service-layer bag and call
  services exactly as a route would.

## Environment

| Var                   | Where          | Notes                                                                                                       |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `INNGEST_DEV=1`       | local dev only | Forces dev mode; without it the serve route 500s locally. Set by `pnpm dev:inngest`. UNSET in preview/prod. |
| `INNGEST_EVENT_KEY`   | preview + prod | Authenticates `sendEvent`. Blank locally / in tests.                                                        |
| `INNGEST_SIGNING_KEY` | preview + prod | Verifies control-plane requests. Read automatically by the SDK. Blank locally.                              |

In preview/prod both keys come from the **official Inngest↔Vercel
integration**, which also configures the Vercel Deployment-Protection bypass
the control plane needs to reach protected previews. See "Cloud + Vercel
wiring" below.

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

| Field         | Default       | Meaning                                                                                                                          |
| ------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | —             | The job id, **also the triggering event name** (1:1 convention). Must be a key of `JobEventDataMap` in `lib/jobs/types.ts`.      |
| `retryPolicy` | `'transient'` | Named retry policy — the preferred way to declare retry intent. See **Retry policies** below. Mutually exclusive with `retries`. |
| `retries`     | —             | Raw Inngest retry count (escape hatch; prefer `retryPolicy`). Passing both throws.                                               |
| `concurrency` | —             | Max simultaneous runs (forwarded as `{ limit }`).                                                                                |
| `idempotency` | —             | Event-payload-keyed dedup template (Inngest event-level dedup).                                                                  |
| `cron`        | —             | Schedule the job instead of event-triggering it. See **Scheduled jobs** below.                                                   |

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
across retries and only flips to `failed` on the **final** attempt (when the
retry budget is exhausted) — at which point it also writes a dead-letter row
(see **Dead-letter queue**). So a job that's mid-retry reads as in-flight, not
prematurely failed. The writes run inside `step.run(...)`, so they execute
exactly once per run even when the handler replays across step boundaries — one
row per run, not one per replay (the `job-run:start` step's result is reused
across retries too). This is the read path the operator dashboard (1.6.5)
renders without calling Inngest's API. `workspace_id` is null for system jobs.

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

System events (the `system.*` namespace) are untenanted by design and are NOT
dispatched through `sendEvent` at all — they're **cron-triggered** (e.g.
`system.daily-health-check`, see **Scheduled jobs**) or driven by the in-process
test harness. (`sendEvent`'s type excludes the `system.*` namespace.)

## Canonical job: `email.send`

`email.send` (`lib/jobs/definitions/emailSend.ts`) is the first production job
and the reference exemplar — every transactional email in prodect-core flows
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
- **Idempotency.** The job is configured with
  `idempotency: 'event.data.idempotencyKey'`. Inngest dedups same-key events
  inside its window, so a retried Server Action that re-fires the same token
  collapses to one delivery. This is **event-level dedup enforced by the Inngest
  runtime** (validated on the dev-server / cloud surfaces in 1.6.1). The
  in-process unit harness runs the handler directly and does **not** simulate
  the dedup layer — so the unit tests assert the _wiring_ (the config carries
  the expression) and the _caller contract_ (the key is supplied), not the
  runtime drop. The key is also recorded on the `job_run` row.
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
   give it a `cron` (system jobs, see **Scheduled jobs**).
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
  calls `replayDLQ(dlqId, tx)` (`lib/jobs/dlq.ts`), which re-emits the
  **original** event and stamps `replayed_at` so the action is auditable.
- **When NOT to replay** — if the failure was a bad payload or a since-removed
  code path, replaying just re-fails. Fix forward first; replay only transient
  infrastructure failures (provider outage, expired upstream token now renewed).

**Idempotency caveat (important).** Replay re-emits the event **as-is**,
including its original idempotency key. If the job was defined with an
`idempotency` expression and Inngest's dedup window has **not** elapsed, the
replay is **dropped** (same key → no re-execute). To force a replay through:
either wait the dedup window out, or — when a code change has made the original
a no-op — re-shape the idempotency key so the replay reads as a new event. A
job with **no** idempotency key replays unconditionally.

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

Inngest's cron trigger means there's **no separate scheduler service** to run.
Cron jobs are uniform with event-triggered jobs in the ledger: the wrapper
records the `job_run` row's `event_name` as the synthetic `scheduled.{job_id}`
(a cron run carries no real triggering-event name), so the dashboard treats both
kinds the same, and a scheduled run that fails surfaces in the DLQ exactly like
any other job. `system.daily-health-check`
(`lib/jobs/definitions/dailyHealthCheck.ts`) is the reference example — a no-op
that proves the scheduled path end-to-end.

Cron jobs live in the `system.*` namespace (untenanted — `workspace_id` is null)
and are **not** emitted via `sendEvent`. The cron syntax is standard 5-field
(`min hour day month weekday`); see the
[Inngest cron docs](https://www.inngest.com/docs/features/inngest-functions/cron).

## Cloud + Vercel wiring (human-gated)

Going live in preview/prod requires steps a coding agent can't do (dashboard
access, secrets, an Inngest account). Tracked in PRODECT_FINDINGS #30 and as a
dedicated manual Subtask:

1. Install the **official Inngest↔Vercel integration** — provisions the keys
   into Preview + Production and configures the Deployment-Protection bypass so
   the control plane can reach protected `/api/inngest` previews (without it,
   the endpoint 401s and the keys are inert — finding #30 sharp edge #8).
2. Confirm `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` in both Vercel scopes.
3. Sync the preview `/api/inngest` URL and trigger a run from the Inngest
   dashboard to confirm end-to-end.
