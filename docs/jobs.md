# Background jobs

Prodect runs background work on [Inngest](https://www.inngest.com/) — durable,
event-driven functions with built-in retries and step memoization. This
document covers the runtime landed in Subtask 1.6.2: the client, the
`defineJob` / `sendEvent` wrappers, the `job_run` ledger, and how to add a job.

> Deeper sections — idempotency, retry tuning, the dead-letter queue, and the
> operator runbook — arrive with Subtasks 1.6.4 and 1.6.5.

## Runtime overview

```
emit:   route/service ──sendEvent("x.y", { workspaceId, … })──▶ Inngest
run:    Inngest ──POST /api/inngest──▶ serve route ──▶ defineJob wrapper ──▶ your handler
ledger: defineJob writes a job_run row: running ─▶ succeeded | failed
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
  { id: 'invoice.send', retries: 3, concurrency: 5 },
  async (ctx, services) => {
    const { workspaceId, invoiceId } = ctx.event.data;
    await services.workspaces.something(workspaceId);
    return { sent: true };
  },
);
```

**Options**

| Field         | Default | Meaning                                                                                                                     |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`          | —       | The job id, **also the triggering event name** (1:1 convention). Must be a key of `JobEventDataMap` in `lib/jobs/types.ts`. |
| `retries`     | `3`     | Inngest retry count on failure.                                                                                             |
| `concurrency` | —       | Max simultaneous runs (forwarded as `{ limit }`).                                                                           |
| `idempotency` | —       | Event-payload-keyed dedup template (the ledger-side dedup lands in 1.6.4).                                                  |

**Handler signature** — `(ctx, services) => result`:

- `ctx` — the Inngest context: `ctx.event` (`.name`, `.data`, `.id`),
  `ctx.step` (durable step tools), `ctx.runId`, `ctx.attempt`, `ctx.logger`.
- `services` — the injected service-layer bag (`lib/jobs/services.ts`):
  `workspaces`, `workspaceInvites`, `projects`, `workItems`, `users`, `email`.
  Use these instead of importing service singletons directly, so handlers stay
  testable with a stubbed bag.
- The return value becomes the run's resolved output.

**Run ledger.** Around every handler, `defineJob` writes one `job_run` row:
`running` at start → `succeeded` on return, or `failed` (with the serialized
error) on throw, then re-throws so Inngest's retry machinery still sees it. The
three writes run inside `step.run(...)`, so they execute exactly once per run
even when the handler body replays across step boundaries — one row per run,
not one per replay. This is the read path the operator dashboard (1.6.5)
renders without calling Inngest's API. `workspace_id` is null for system jobs.

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
dispatched through `sendEvent` at all — they're triggered by crons (1.6.4) or,
for the `system.ping` smoke job, by the in-process test harness. (`sendEvent`'s
type excludes the `system.*` namespace.)

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
  runtime drop. The key is also recorded on the `job_run` row (the ledger-side
  dedup that reads it is 1.6.4).
- **`workspaceId: null`** for password reset (cross-workspace); the invite path
  passes its real workspace id.

## How to add a new job

1. **Declare the event** in `lib/jobs/types.ts` — add a key + payload to
   `JobEventDataMap`. Business-event payloads must include `workspaceId` —
   `string`, or `string | null` for a genuinely cross-workspace event (see the
   `null` carve-out above).
2. **Define the job** in `lib/jobs/definitions/<name>.ts` via `defineJob`.
3. **Register it** — add it to the `jobFunctions` array in `lib/jobs/registry.ts`.
   (The serve route imports from the registry, so it never changes.)
4. **Emit it** from a route or service via `sendEvent` (business events) — or a
   cron trigger for system jobs.
5. **Test it** with `@inngest/test`'s `InngestTestEngine` against the real
   Postgres (see `tests/jobs/ping.test.ts`). Pass the real event explicitly via
   `events: [{ name, data }]` — the default synthetic event is
   `inngest/function.invoked`.

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
