import type { SeedStory } from '../types';

/**
 * Story 1.6 — Background job infrastructure.
 * Faithful transcription of prodect_plan/story-1.6-jobs.html (frozen archive).
 */
export const story_1_6: SeedStory = {
  id: '1.6',
  title: 'Background job infrastructure',
  status: 'done',
  descriptionMd:
    "The durable async substrate every later Epic depends on: long-running LLM calls (Epic 7's " +
    'planning agent passes run 30-60 s and cannot live inside an HTTP request), scheduled work ' +
    '(Epic 5 notification digests, Epic 7 auto-suggest cadences), webhook fan-out (Epic 6 search ' +
    "indexing, Epic 7's GitHub PR-merged → mark-Subtask-done flow), and transactional email " +
    "retries (Story 1.1's password-reset + Story 1.2's workspace invites currently fire " +
    'synchronously and silently swallow provider failures). Ships the runtime + the patterns ' +
    '(idempotency, retries, dead-letter, replay) + the first real production job + the operator ' +
    'surface so failures surface to a human instead of disappearing.\n\n' +
    '**Prerequisites:** Story 1.1 ships the `lib/email.ts` abstraction the first real job (1.6.3) ' +
    "wraps; the password-reset + workspace-invite send-sites become the first job's callers " +
    "(replacing today's synchronous fire-and-pray sends — captured as a finding in " +
    "PRODECT_FINDINGS.md). Story 1.2 ships `WorkspaceMembership`, which 1.6.5's job-runs " +
    "dashboard filters by (so workspace admins only see their workspace's runs). Story 1.5 ships " +
    "`AppLayout` + `Sidebar`; the dashboard route in 1.6.5 hangs off the existing sidebar's " +
    '"Settings" group.',
  verificationRecipeMd:
    '- Pull the merged Story branch; `pnpm install && pnpm dev`; in a second terminal, ' +
    '`npx inngest-cli dev`.\n' +
    '- Sign in as a workspace owner; navigate to Settings → Job runs; confirm both tabs render ' +
    'with empty states.\n' +
    '- Invite a new email address to the workspace → confirm the invite-acceptance row appears in ' +
    '"Recent runs" as `succeeded` within ~3 seconds; the dev-console email body matches the invite ' +
    'template.\n' +
    '- Set `FORCE_EMAIL_FAILURE_FOR=fail@example.test` in the dev shell; invite ' +
    '`fail@example.test` → watch the run climb to attempts=3 then transition to `failed`; confirm ' +
    'the DLQ tab badge increments.\n' +
    '- Open the DLQ tab → click Replay on the failed row → confirm a new `succeeded` run appears ' +
    'AND the DLQ row\'s "Replayed" column shows the timestamp.\n' +
    '- Trigger a password reset → confirm the run appears in the "System" tab (gated to the ' +
    'configured platform-admin email).\n' +
    '- Sign out; sign in as a member (non-owner) of the same workspace → navigate to Job runs → ' +
    'confirm Recent runs renders but Replay is disabled with the tooltip.\n' +
    '- Open the Inngest dev UI in a third tab → confirm every run the dashboard shows is also ' +
    "present in Inngest's own UI, with the same attempt counts and durations. The two surfaces " +
    'must agree.\n' +
    "- Stop and restart `pnpm dev`; confirm the dashboard still shows historical runs (they're " +
    'DB-persisted, not in-memory).\n' +
    '- Resize the dashboard to a 375×812 viewport → confirm the table is horizontally scrollable ' +
    'inside the responsive shell; no layout regressions vs Story 1.5.',
  items: [
    {
      id: '1.6.1',
      title:
        'Runtime validation: Inngest local dev + Vercel deploy + CI test harness ' +
        '(end-to-end smoke, no production wiring)',
      status: 'done',
      type: 'research',
      executor: 'coding_agent',
      estimateMinutes: 24,
      descriptionMd:
        "Validate that Inngest's three load-bearing surfaces actually work against " +
        "`motir-core`'s stack BEFORE the SDK lands in main. The Story's runtime " +
        'decision (Inngest) is durable but unverified — this Subtask is the gate that lets us ' +
        'back out cleanly if the local-dev story or the Vercel deploy story breaks. Three ' +
        'specific things to prove:\n\n' +
        '- **Local dev:** `npx inngest-cli dev` runs alongside `pnpm dev`, discovers a ' +
        'registered function via the `/api/inngest` serve route, and a triggered event invokes ' +
        "the function locally with the function's logs visible in the Inngest dev UI. Smoke " +
        'test: a no-op `example.ping` function that returns `{ ok: true }`.\n' +
        '- **Vercel deploy:** deploy the throwaway branch to a Vercel preview; confirm ' +
        "Inngest's prod control plane discovers the function via the preview URL's " +
        '`/api/inngest` endpoint (registration). Trigger an event from the Inngest dashboard; ' +
        'confirm the preview deployment receives the invocation. This proves the ' +
        "`INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` env-var flow works with Vercel's " +
        'preview-env model + the Vercel-Neon Marketplace preview-branch DB pattern.\n' +
        "- **CI test harness:** Inngest's `@inngest/test` in-process harness invokes a " +
        'function synchronously inside Vitest with no external dev server. Smoke test: same ' +
        'no-op function, asserted via the harness API.\n\n' +
        '**Why a research Subtask, not just "do it in 1.6.2":** If the Vercel preview-env ' +
        "registration model has a gap (e.g., Inngest can't probe ephemeral preview URLs " +
        "reliably; signing-key rotation isn't compatible with Vercel's environment scopes), " +
        'we want to discover it on a throwaway branch with a 2-file diff, NOT after the ' +
        '`lib/jobs/` wrapper and the `email.send` migration are already woven through main. ' +
        'This Subtask is cheap insurance against a 1.6.2 rollback. Output is a finding in ' +
        'PRODECT_FINDINGS.md documenting any sharp edges encountered.\n\n' +
        "**Throwaway branch policy:** this Subtask's PR is for human review only, not merge. " +
        "The artifacts (the validated patterns) feed 1.6.2's prompt; the Subtask branch is " +
        'deleted after the finding is logged. The status flips to `done` when the finding ' +
        'lands; no production code from this branch ever reaches main.\n\n' +
        '**If validation fails:** log the failure mode in PRODECT_FINDINGS.md, re-open the ' +
        'runtime decision (this is the ONE escape hatch from the durable Inngest choice). The ' +
        'replan would be a fresh `motir plan 1.6` with the finding as input.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A throwaway branch (`subtask/PROD-1.6.1-inngest-spike`) demonstrates the no-op ' +
        '`example.ping` function invoked successfully via: (a) the local `inngest-cli dev` ' +
        'server, (b) a deployed Vercel preview, (c) the in-process `@inngest/test` harness ' +
        'in Vitest.\n' +
        '- Screenshots / logs of each of the three invocations are attached to the PR body.\n' +
        '- Env-var requirements documented in the PR body: which Inngest keys are needed in CI, ' +
        'in Vercel preview, in Vercel production; how preview-branch DB isolation interacts with ' +
        "Inngest's prod control plane discovering preview URLs.\n" +
        '- A finding entry exists in `motir-meta/prodect_plan/PRODECT_FINDINGS.md` capturing ' +
        'any sharp edges (e.g., preview-URL registration quirks, dev-server port conflicts with ' +
        'the existing `pnpm dev` port), even if the entry is "no sharp edges discovered."\n' +
        '- The PR is NOT merged; the throwaway branch is deleted after the finding is logged. ' +
        'The next Subtask (1.6.2) reads the finding before starting.\n' +
        '- If validation fails on any of the three surfaces, the finding entry includes the ' +
        "failure mode and recommends an explicit replan; 1.6.2's status stays `planned` until " +
        'a replan resolves the issue.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `lib/env.ts` — the `requiredEnv` pattern any new env vars must register against\n' +
        '- `.github/workflows/ci.yml` — where placeholder env vars get added for the build step\n' +
        '- `.github/workflows/cleanup-preview-deployments.yml` — the existing preview-cleanup ' +
        'workflow that bounds how long a throwaway preview can linger\n' +
        '- Inngest serve docs + dev server docs + testing reference — the three surfaces under ' +
        'validation\n' +
        '- feasibility.html ADR-004 — the open decision this Subtask closes\n' +
        '- PRODECT_FINDINGS.md — where the validation report lands',
    },
    {
      id: '1.6.2',
      title:
        'Inngest SDK + serve route + `lib/jobs/` wrapper (`defineJob`, `sendEvent`); ' +
        'env wiring; smoke job',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['1.6.1'],
      descriptionMd:
        'Land the production runtime in main. Three concrete deliverables:\n\n' +
        '- **SDK + serve route:** install `inngest` as a runtime dependency. Mount the serve ' +
        "route at `app/api/inngest/route.ts` using Next 16's App Router `serve()` adapter. " +
        'The Inngest `client` instance is the singleton from `lib/jobs/client.ts`.\n' +
        '- **`lib/jobs/` wrapper:**\n' +
        '  - `lib/jobs/client.ts` — exports the singleton `inngest` client, configured with ' +
        '`id: "motir-core"` and `eventKey` from `lib/env.ts`.\n' +
        '  - `lib/jobs/defineJob.ts` — the canonical wrapper around `inngest.createFunction()`. ' +
        'Forces every job to declare: `id` (e.g., `"email.send"`), the matching `event` name ' +
        '(always `id`-derived to keep the convention 1:1), `retries` (default 3), `concurrency` ' +
        '(optional), `idempotency` (optional event-payload-keyed template), and a typed handler ' +
        'signature. The wrapper writes a `job_run` row before invoking the user handler and ' +
        'updates it on completion / failure — this is what powers the operator dashboard in ' +
        "1.6.5 without relying on Inngest's API for the read path.\n" +
        '  - `lib/jobs/sendEvent.ts` — wraps `inngest.send()` with the same workspace-scoped ' +
        'event-payload shape every job uses (`{ name, data: { workspaceId, ...payload } }`); ' +
        'throws if `workspaceId` is missing (the durable invariant — every event is ' +
        'workspace-scoped, no untenanted background work).\n' +
        '  - `lib/jobs/registry.ts` — the array of registered functions the serve route mounts. ' +
        'New jobs land in this file; the serve route imports from here, not from individual job ' +
        "files (so adding a job doesn't change the serve route).\n" +
        "  - `lib/jobs/types.ts` — the discriminated-union type for job events; every job's " +
        'event name lives here. Type-safety blocks `sendEvent("typo.event.name")` at compile ' +
        'time.\n' +
        "- **Env + CI:** add `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` to `lib/env.ts`'s " +
        "`requiredEnv`. Add placeholders in CI's workflow env block (same pattern as the " +
        'Better-Auth + Google OAuth env vars in Stories 1.1.2 + 1.1.4). Add real values in ' +
        'Vercel for preview + prod via the Vercel-Inngest Marketplace integration if available; ' +
        'fall back to manual env-var entry otherwise (record the chosen install path in ' +
        'PRODECT_FINDINGS.md).\n' +
        '- **Smoke job:** register a single throwaway `system.ping` job in the registry that ' +
        "returns a static payload. This is what 1.6.2's tests exercise; it stays in the " +
        'registry until 1.6.4 replaces it with the canonical-pattern ' +
        '`system.daily-health-check` job.\n\n' +
        '**4-layer rule:** NO route file outside `app/api/inngest/` imports anything from ' +
        '`inngest` directly. Routes call `sendEvent()`; services own the job handler; ' +
        'repositories stay single-Prisma-op. The `defineJob` wrapper enforces this with a typed ' +
        'handler signature (`(ctx, services) => ...`) that injects the service layer.\n\n' +
        "**What's deliberately deferred:** the actual production job (`email.send`) is 1.6.3. " +
        'The retry/idempotency/DLQ patterns are 1.6.4. The dashboard is 1.6.5. This Subtask ' +
        'only lands the SDK + wrapper + smoke job.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `inngest` in `dependencies`; `@inngest/test` in `devDependencies`.\n' +
        "- `app/api/inngest/route.ts` mounts the serve route via Inngest's Next App Router " +
        'adapter; route accepts GET (registration probe) + POST (invocation) + PUT ' +
        '(registration).\n' +
        '- `lib/jobs/` contains `client.ts`, `defineJob.ts`, `sendEvent.ts`, `registry.ts`, ' +
        '`types.ts` per the description; every public export has typed signatures with no ' +
        '`any`.\n' +
        '- `defineJob` writes a `job_run` row at start and updates it on completion / failure ' +
        '(the schema for `job_run` lands in this Subtask as a Prisma migration — see schema ' +
        'bullet below).\n' +
        '- Prisma migration adds `job_run`: `id` (cuid), `workspace_id` (FK, ON DELETE CASCADE, ' +
        'nullable for system events), `function_id` (text), `event_name` (text), `event_id` ' +
        '(text, indexed), `attempt` (int), `status` (enum: `running`, `succeeded`, `failed`), ' +
        '`started_at`, `finished_at` (nullable), `duration_ms` (nullable), `failure` (jsonb ' +
        'nullable: `{ message, stack, code? }`), `idempotency_key` (text, nullable, indexed). ' +
        'Indexes: `(workspace_id, started_at desc)`, `(workspace_id, status, started_at desc)`. ' +
        'RLS deferred to 1.6.4 (the patterns Subtask folds RLS in alongside the DLQ table to ' +
        'keep migrations atomic by concern).\n' +
        '- `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` in `lib/env.ts`; CI placeholders in ' +
        '`.github/workflows/ci.yml`; Vercel env vars set for preview + prod.\n' +
        '- `system.ping` smoke job registered; Vitest test in `tests/jobs/ping.test.ts` drives ' +
        'the in-process harness and asserts the function runs, returns the static payload, and ' +
        'writes a `job_run` row with `status: succeeded`.\n' +
        '- `docs/jobs.md` created with: runtime overview, `defineJob` API reference, ' +
        '`sendEvent` API reference, the "how to add a new job" recipe. Deeper sections ' +
        '(idempotency, retries, DLQ, operator runbook) added in 1.6.4 + 1.6.5.\n' +
        '- No route file outside `app/api/inngest/` imports from `inngest`; an ESLint ' +
        '`no-restricted-imports` rule enforces this.\n' +
        '- All quality gates green; existing tests + E2E stay green; CI build succeeds against ' +
        'the placeholder Inngest env values.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- The 1.6.1 findings entry — the validated patterns to mirror exactly\n' +
        "- `lib/env.ts` — the `requiredEnv` pattern (extend it; don't re-shape it)\n" +
        '- `lib/auth/index.ts` + `lib/users/repo.ts` + `lib/workspaces/service.ts` — exemplars ' +
        "of the canonical service/repo split `defineJob`'s handler signature must mirror\n" +
        '- `prisma/schema.prisma` — the schema file the `job_run` migration extends\n' +
        '- Inngest TS SDK + Next App Router adapter docs',
    },
    {
      id: '1.6.3',
      title:
        'First production job: `email.send` — migrate password-reset + workspace-invite ' +
        'sends from synchronous to job-backed',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['1.6.2'],
      descriptionMd:
        'Replace the two synchronous email send-sites with the canonical job-backed pattern. ' +
        "Today's sends in `lib/auth/password-reset.ts` (Better-Auth's `sendResetPassword` hook " +
        "from Story 1.1.6) and `lib/workspaces/invites.ts` (Story 1.2's invite create flow) call " +
        '`sendEmail()` from `lib/email.ts` synchronously inside the HTTP request lifecycle. If ' +
        'the provider is slow or down, the user-facing request either stalls or returns a ' +
        'misleading success while the email never goes out. Both sites become ' +
        '`sendEvent("email.send", { ... })` calls; the `email.send` job handler does the actual ' +
        '`sendEmail()` with retries.\n\n' +
        '**Job definition** (`lib/jobs/email/send.ts`):\n\n' +
        '- `id: "email.send"`, `event: "email.send"`, `retries: 3` (Inngest\'s exponential ' +
        'backoff defaults: ~30s, ~2m, ~5m).\n' +
        '- Idempotency: `"{{event.data.idempotencyKey}}"`. Callers must supply ' +
        "`idempotencyKey` in the event payload; for password-reset it's the verification token " +
        "ID; for invites it's the invitation row ID. Inngest dedups same-key events within a " +
        '24-hour window, so a retried Server Action that re-fires the same send becomes a no-op.\n' +
        '- Event payload shape (typed in `lib/jobs/types.ts`): ' +
        '`{ workspaceId: string; idempotencyKey: string; template: "password-reset" | ' +
        '"workspace-invite"; to: string; data: TemplateData }`. `TemplateData` is a ' +
        'discriminated union by `template`; the handler narrows it via the discriminant before ' +
        'calling `sendEmail()`.\n' +
        '- Handler body: a single `step.run("send", async () => ...)` that calls `sendEmail()` ' +
        'and returns its result. The `step.run` wrapper makes the send durable across function ' +
        "retries (Inngest persists the result; a retry that survives the send won't " +
        'double-send).\n\n' +
        '**Call-site migrations:**\n\n' +
        '- `lib/auth/password-reset.ts`: `sendResetPassword({ user, url, token })` stops ' +
        'calling `sendEmail()` directly and instead calls ' +
        '`sendEvent("email.send", { workspaceId, idempotencyKey: token, template: ' +
        '"password-reset", to: user.email, data: { resetUrl: url, name: user.name } })`. ' +
        'Question to resolve in this Subtask: password-reset is pre-workspace-scope (the user ' +
        'might belong to multiple workspaces, or zero); resolution — use a sentinel ' +
        '`workspaceId: "system"` for cross-workspace system events. The `sendEvent` wrapper ' +
        'accepts the sentinel; the dashboard in 1.6.5 surfaces `workspace_id = "system"` runs ' +
        'in a separate "System" tab visible only to platform admins (gated to a hardcoded ' +
        '`process.env.PLATFORM_ADMIN_EMAIL` until real platform-admin roles ship in Epic 6).\n' +
        "- `lib/workspaces/invites.ts`: `createInvitation()`'s tail-end `sendEmail()` becomes " +
        '`sendEvent("email.send", { workspaceId, idempotencyKey: invite.id, template: ' +
        '"workspace-invite", to: invite.email, data: { inviteUrl, workspaceName, ' +
        'inviterName } })`.\n' +
        '- **Both call-sites stop awaiting the email outcome.** The user-facing response ' +
        'returns immediately after the event is enqueued. Failures surface in the dashboard, ' +
        'not in the request.\n\n' +
        '**Test migrations:** existing Vitest specs for password-reset and workspace-invite ' +
        'assert that `sendEmail()` was called with the right template + recipient. They now ' +
        'assert that `sendEvent("email.send", ...)` was called with the right payload, AND that ' +
        'running the in-process harness against the queued event invokes `sendEmail()` with the ' +
        'expected args. The existing dev-console email provider stays the default; production ' +
        "providers (Resend / Postmark) remain per-project planner decisions (per Story 1.1's " +
        '"email provider is per-project" rule).\n\n' +
        "**Why these two sites first:** they're the highest-leverage unreliable surfaces in " +
        'production today (auth recovery + team onboarding); they establish the canonical ' +
        "pattern Epic 5's notification jobs + Epic 7's LLM jobs will mirror; and they tighten " +
        'an existing finding from the Story 1.1 work (silent provider-failure swallowing).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/jobs/email/send.ts` ships the `email.send` job per the description; registered ' +
        'in `lib/jobs/registry.ts`.\n' +
        '- `lib/jobs/types.ts` grows the `email.send` event entry with the discriminated ' +
        '`TemplateData` union (`password-reset` and `workspace-invite` arms).\n' +
        '- `lib/auth/password-reset.ts` and `lib/workspaces/invites.ts` no longer import or ' +
        'call `sendEmail()`; they call `sendEvent("email.send", ...)` instead.\n' +
        '- The `sendEmail()` import is now reachable only from `lib/jobs/email/send.ts`; an ' +
        "ESLint `no-restricted-imports` rule enforces this so a future contributor can't " +
        'accidentally regress.\n' +
        '- The `workspaceId: "system"` sentinel is supported in `sendEvent`\'s typed signature ' +
        'and routed correctly through the `job_run` table (the column is nullable for system ' +
        'events; the dashboard tab gating is wired in 1.6.5).\n' +
        '- Vitest specs in `tests/jobs/email-send.test.ts` + the migrated ' +
        '`tests/auth/password-reset.test.ts` + `tests/workspaces/invites.test.ts` assert: ' +
        'event payload shape; idempotency dedup (same-key event fired twice → handler runs ' +
        'once); handler invokes `sendEmail()` with the right template + recipient.\n' +
        '- Existing Playwright password-reset + invite-acceptance specs stay green — they ' +
        'should be agnostic to the synchronous-vs-async send distinction since both paths ' +
        'complete the user-visible flow identically.\n' +
        '- `docs/jobs.md` grows a "Canonical job: email.send" section walking through the file ' +
        'as the reference exemplar.\n' +
        '- All quality gates green; existing tests + E2E stay green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `lib/email.ts` + `lib/emailTemplates/` — the abstraction the job wraps; no shape ' +
        'change needed\n' +
        '- `lib/auth/password-reset.ts` — the Better-Auth `sendResetPassword` hook ' +
        '(Story 1.1.6)\n' +
        '- `lib/workspaces/invites.ts` — the invite create flow (Story 1.2 invite Subtask)\n' +
        '- `lib/jobs/*` from 1.6.2 — the wrapper APIs to compose against\n' +
        '- The 1.6.2 docs section on `defineJob` + idempotency conventions\n' +
        '- Inngest idempotency reference',
    },
    {
      id: '1.6.4',
      title:
        'Patterns: retry policies, dead-letter queue, scheduled-job primitive, ' +
        'RLS on `job_run` + `job_run_dlq`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['1.6.3'],
      descriptionMd:
        'Codify the cross-cutting patterns every future job (Epic 5 notifications, Epic 7 LLM ' +
        'calls, Epic 6 search indexing) will follow. Five concrete moves:\n\n' +
        '- **Retry policy module** (`lib/jobs/retries.ts`): three named policies `defineJob` ' +
        'accepts via a `retryPolicy` shorthand — `"transient"` (3 attempts, exponential), ' +
        '`"idempotent"` (5 attempts, longer backoff — safe for read-only or naturally-idempotent ' +
        'operations), `"none"` (1 attempt, fail fast — for system jobs where retry semantics are ' +
        'wrong, like "send signup notification once or not at all"). The wrapper translates the ' +
        "policy to Inngest's `retries` + `cancelOn` configuration; the policy choice is " +
        'documented per-job and visible in the dashboard.\n' +
        '- **Dead-letter queue:**\n' +
        '  - Prisma migration adds `job_run_dlq`: `id` (cuid), `workspace_id` (FK, nullable for ' +
        'system events), `function_id`, `event_name`, `event_data` (jsonb), `failure` (jsonb), ' +
        '`attempts` (int), `first_failed_at`, `last_failed_at`, `replayed_at` (nullable). ' +
        'Indexes: `(workspace_id, last_failed_at desc)`.\n' +
        "  - `defineJob`'s failure path: after the final retry exhausts, write a `job_run_dlq` " +
        'row inside a `tx` that also flips the `job_run.status` to `failed`. This is the durable ' +
        "record the dashboard reads from; Inngest's own failure surface stays available for deep " +
        "tracing but isn't the source of truth for operator action.\n" +
        '  - `lib/jobs/dlq.ts` exposes `replayDLQ(dlqId, tx)` — the service-layer function the ' +
        'dashboard\'s "Replay" button calls. Re-emits the original event via `sendEvent()`, sets ' +
        "the DLQ row's `replayed_at`. Replay is auditable; a workspace owner can see when a DLQ " +
        "entry was retried and by whom (reuse Story 1.5's identity propagation through Server " +
        'Actions).\n' +
        "- **Scheduled-job primitive:** `defineJob` accepts an optional `cron` field. Inngest's " +
        '`{ cron: "0 9 * * *" }` trigger pattern lets us schedule jobs without a separate ' +
        'scheduler service. Document the canonical cron usage in `docs/jobs.md`: scheduled jobs ' +
        'emit a synthetic event so the dashboard treats them uniformly with event-triggered jobs ' +
        '(the `job_run` row\'s `event_name` is `"scheduled.{job_id}"`). Add a placeholder ' +
        '`system.daily-health-check` job (cron `"0 9 * * *"`) that no-ops and writes a ' +
        '`job_run` row — proves the scheduled path works end-to-end. Replaces the 1.6.2 ' +
        '`system.ping` smoke job.\n' +
        '- **RLS on `job_run` + `job_run_dlq`:** follow the Story 1.2 workspace-RLS pattern ' +
        'exactly — a policy that filters rows by ' +
        "`workspace_id = current_setting('prodect.workspace_id')::text`. System events " +
        '(`workspace_id IS NULL`) are visible only when the request context sets ' +
        "`prodect.system_admin = 'true'` (the same escape hatch Story 1.2 ships for " +
        'cross-workspace admin tooling). Test: cross-workspace reads return zero rows even when ' +
        'the row exists; system-event reads succeed only with the admin context set.\n' +
        '- **Documentation:** `docs/jobs.md` grows three new sections — **Retry policies** ' +
        '(when to pick each named policy + examples), **Dead-letter queue** (operator runbook: ' +
        'how DLQ rows appear, how to replay, when NOT to replay), **Scheduled jobs** (cron ' +
        'syntax, the synthetic-event convention, how scheduled-job failures surface in the ' +
        'dashboard).\n\n' +
        '**Why bundle these four patterns into one Subtask:** they share the same migration ' +
        'boundary (the DLQ table + RLS policies on both tables ship together as a single Prisma ' +
        'migration), they share the same wrapper surface (`defineJob` grows three new options at ' +
        'once), and they share the documentation block. Splitting them would mean three Prisma ' +
        'migrations and three wrapper-API edits stacked across three PRs against the same files ' +
        '— a high-collision shape per past parallel-Subtask lessons.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `lib/jobs/retries.ts` ships the three named policies; `defineJob` accepts a ' +
        '`retryPolicy` shorthand and maps it to the underlying Inngest config.\n' +
        '- Prisma migration adds `job_run_dlq` per the schema in the description; RLS policies ' +
        'on both `job_run` and `job_run_dlq` mirror the Story 1.2 workspace-scope pattern (with ' +
        'the system-admin escape hatch).\n' +
        "- `defineJob`'s failure path writes a `job_run_dlq` row inside a transaction that also " +
        'flips `job_run.status` to `failed`; verified by a Vitest spec that forces a deliberate ' +
        'handler failure beyond the retry budget and asserts both rows exist.\n' +
        '- `lib/jobs/dlq.ts` exports `replayDLQ(dlqId, tx)`; calling it re-emits the original ' +
        'event and sets `replayed_at`; idempotency-keyed events stay deduped after replay (same ' +
        'key → no double-execute) — this interaction is documented in `docs/jobs.md` with the ' +
        'workaround (re-shape the idempotency key when a code change makes the original a no-op, ' +
        'or wait the window out).\n' +
        '- `defineJob` accepts an optional `cron` field; the `system.daily-health-check` job ' +
        'exists in the registry with a documented cron expression; the 1.6.2 `system.ping` smoke ' +
        'job is removed (replaced by this).\n' +
        '- RLS specs in `tests/jobs/rls.test.ts` cover: cross-workspace reads return zero rows; ' +
        'system-event reads require the `prodect.system_admin` context; the existing ' +
        'workspace-isolation E2E spec is extended with a job-run isolation case.\n' +
        '- `docs/jobs.md` grows the three new sections (Retry policies, DLQ, Scheduled jobs) ' +
        'with worked examples for each.\n' +
        '- All quality gates green; existing tests + E2E stay green.\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        "- `prisma/sql/` + Story 1.2's RLS migration — the canonical RLS pattern to mirror\n" +
        '- `lib/db.ts` + the workspace-context middleware from Story 1.2 — how ' +
        '`prodect.workspace_id` gets set on the session\n' +
        '- `lib/jobs/*` from 1.6.2 + 1.6.3 — the wrapper to extend\n' +
        '- Inngest retries + cron triggers docs\n' +
        '- The 1.6.3 `email.send` job — concrete exemplar to retrofit with a named retry policy',
    },
    {
      id: '1.6.5',
      title:
        'Operator dashboard: `/settings/workspace/jobs` — runs table + DLQ tab + replay action',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['1.5.3', '1.6.4'],
      descriptionMd:
        'The operator surface. When a workspace invite or password reset fails — or (post-Epic-7) ' +
        'a planning agent run fails — the workspace owner needs a place to see it, understand it, ' +
        "and replay it without going to Inngest's dashboard. This Subtask ships that place.\n\n" +
        '**Route:** `app/(authed)/settings/workspace/jobs/page.tsx` — hangs off the existing ' +
        '`/settings/workspace` structure from Story 1.2. The Story 1.5 sidebar gets one new ' +
        'sub-link "Job runs" under Settings.\n\n' +
        '**Page structure:**\n\n' +
        '- **Tabs:** "Recent runs" (default) and "Dead letter" — the latter badged with the ' +
        'current DLQ row count when non-zero.\n' +
        '- **Recent runs table:** columns — Status (pill: succeeded / failed / running), ' +
        'Function (e.g., `email.send`), Event (`email.send` or `scheduled.{job_id}`), Attempts, ' +
        'Started, Duration, Failure (short — first line of the error message, full payload ' +
        'reachable via a row-click that opens a Dialog with the JSON detail). 50 rows per page, ' +
        'ordered `started_at desc`. Filter: a status pill row at top (All / Succeeded / Failed / ' +
        'Running).\n' +
        '- **Dead letter table:** columns — Function, Event, Attempts, First failed, Last failed, ' +
        'Replayed (timestamp or "—"), Actions (Replay button). Row-click opens the same ' +
        'JSON-detail Dialog (now also showing the replayable event payload). Replay button is ' +
        "gated to `owner` role only (reuse Story 1.2's role check); other members see a " +
        'disabled Replay button with a tooltip explaining the gate.\n' +
        "- **System tab:** visible only when the request user's email matches " +
        '`process.env.PLATFORM_ADMIN_EMAIL` (the documented pre-Epic-6 escape hatch from ' +
        'Subtask 1.6.3; tracked as a finding to replace with real platform-admin roles in ' +
        'Epic 6). Same shape as "Recent runs" but queries with the `prodect.system_admin` RLS ' +
        'context set.\n\n' +
        '**Data access:**\n\n' +
        '- `lib/jobs/service.ts`: `listJobRuns({ workspaceId, status?, limit, offset })`, ' +
        '`listDLQ({ workspaceId, limit, offset })`, `countDLQ({ workspaceId })`, ' +
        "`replayDLQ(dlqId)` (wraps 1.6.4's repo-layer `replayDLQ` with role gating + audit " +
        'logging).\n' +
        '- Page is a Server Component; it calls services directly. The replay action is a Server ' +
        'Action declared in the same file (Next 16 pattern from Story 1.5).\n\n' +
        '**Empty states:** an empty "Recent runs" tab shows "No job runs yet — when a background ' +
        'job runs, it\'ll appear here." Empty "Dead letter" tab shows "Nothing in the dead-letter ' +
        'queue — every job has succeeded or is still retrying."\n\n' +
        '**Realtime / refresh:** NO websockets, NO polling in v1. A "Refresh" button reloads ' +
        'the page. Auto-refresh is deferred — a finding logs the future-work item ("dashboard ' +
        'could auto-refresh every 10s; defer until usage shows demand"). This avoids a half-done ' +
        "realtime story that Epic 6's reporting will revisit holistically.\n\n" +
        '**Tokens:** reuses existing pill / badge / table primitives. No new `--el-*` tokens. ' +
        'The status pill maps to existing success / warning / danger tokens.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `app/(authed)/settings/workspace/jobs/page.tsx` ships; sidebar's Settings section " +
        'grows a "Job runs" sub-link routing to it.\n' +
        '- `lib/jobs/service.ts` ships `listJobRuns`, `listDLQ`, `countDLQ`, and a role-gated ' +
        '`replayDLQ`; the underlying repo functions are single-Prisma-op per the 4-layer rule.\n' +
        '- Page renders two tabs ("Recent runs", "Dead letter") with the columns + behaviors in ' +
        'the description; DLQ tab badge shows the current count when non-zero.\n' +
        '- Replay button is enabled only for `owner` role; clicking it calls a Server Action ' +
        "that invokes `replayDLQ`, sets the row's `replayed_at`, re-emits the original event, " +
        'and shows a success toast.\n' +
        "- System tab visible only when the request user's email matches " +
        '`process.env.PLATFORM_ADMIN_EMAIL`; a finding logs the post-Epic-6 replacement plan.\n' +
        '- RLS holds: a member of workspace A querying `/settings/workspace/jobs` while the ' +
        'active workspace is B sees zero runs (verified via the existing isolation E2E pattern ' +
        'extended in 1.6.4).\n' +
        '- Vitest specs in `tests/jobs/service.test.ts` cover: `listJobRuns` filters by status; ' +
        '`countDLQ` excludes `replayed_at IS NOT NULL`; `replayDLQ` rejects non-owner callers; ' +
        'replay re-emits the original event payload byte-for-byte.\n' +
        '- Playwright spec `tests/e2e/jobs-dashboard.spec.ts` covers: dashboard renders empty ' +
        'state for a fresh workspace; after seeding a failed run, the run appears in the Failed ' +
        'filter; DLQ tab badge increments; Replay button re-runs the job.\n' +
        "- All quality gates green; existing tests + E2E stay green; Story 1.5's a11y spec " +
        'extends to cover the new route (zero axe violations).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `app/(authed)/settings/workspace/page.tsx` + the workspace settings layout — the ' +
        'existing structure this Subtask extends\n' +
        '- `app/(authed)/settings/project/page.tsx` — exemplar for the owner-role gating ' +
        'pattern\n' +
        '- `components/ui/AppLayout.tsx` + `Sidebar.tsx` from Story 1.5 — the shell the new ' +
        'route renders inside\n' +
        '- `lib/jobs/*` from 1.6.2 / 1.6.3 / 1.6.4 — the runtime + DLQ this dashboard reads\n' +
        '- The Story 1.2 workspace-membership role-check helper',
    },
    {
      id: '1.6.6',
      title:
        'Story-level E2E: real-failure → DLQ → operator replay → success path ' +
        '(closes the Story)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.6.5'],
      descriptionMd:
        'The Story-closing E2E proves the runtime + the patterns + the dashboard hold together ' +
        'end-to-end against a forced failure. Same shape as Story 1.5.6 — a Playwright spec that ' +
        'drives the user-visible flow, plus a Vitest integration spec for the cross-job ' +
        'invariants.\n\n' +
        '**Spec at `tests/e2e/jobs-flow.spec.ts`** covers:\n\n' +
        '- **Happy-path workspace invite:** sign in as workspace owner → invite a new email → ' +
        'assert the invite-acceptance email is enqueued (visible in the dashboard\'s "Recent ' +
        'runs" tab as a `succeeded` row); the dev-console email provider logs the email body.\n' +
        "- **Forced-failure path:** a Playwright fixture flag makes `lib/email.ts`'s " +
        'dev-console provider throw deterministically for a specific recipient email pattern; ' +
        'invite that email → confirm the run appears as `failed` with attempts climbing to 3 → ' +
        'confirm a row lands in the DLQ tab → confirm the DLQ tab badge increments.\n' +
        '- **Replay path:** clear the failure flag → click "Replay" on the DLQ row → confirm a ' +
        'new `job_run` row appears as `succeeded` → confirm the DLQ row shows a non-null ' +
        '`replayed_at` → confirm the email body now logs to the dev console.\n' +
        '- **Cross-workspace isolation:** as a member of workspace A, navigate to ' +
        '`/settings/workspace/jobs` while workspace B is active → confirm zero runs visible ' +
        "even though workspace A has many. This catches RLS misses the Vitest tests can't " +
        '(they run with a single connection).\n' +
        '- **Role gating:** as a non-owner member of a workspace, the Replay button is disabled ' +
        'with a tooltip explaining the gate.\n' +
        '- **Empty-state path:** a fresh workspace with no job runs shows the documented empty ' +
        'state for both tabs.\n\n' +
        '**Vitest integration spec at `tests/jobs/integration.test.ts`** covers the ' +
        "cross-cutting invariants that don't surface via the browser:\n\n" +
        '- The `system.daily-health-check` scheduled job, manually fired via the in-process ' +
        'harness, writes the expected synthetic-event `job_run` row.\n' +
        '- Idempotency: firing the same `email.send` event twice with the same idempotency key ' +
        'results in exactly one `job_run` row and exactly one `sendEmail` invocation.\n' +
        '- The DLQ replay does NOT bypass the idempotency window (a replay within 24h is a ' +
        'no-op against the original idempotency key — this is the "replay-after-fixing-the-' +
        'underlying-bug-but-the-key-is-still-deduped" trap that real ops surfaces hit; document ' +
        'the workaround inline with the test).\n\n' +
        '**Story-level verification recipe** (manual, ≤12 minutes): pull main; ' +
        "`pnpm install && pnpm dev` + `npx inngest-cli dev`; walk the spec's scenarios " +
        'interactively in the browser, spot-checking that the Inngest dev UI shows the same ' +
        'runs the dashboard does (the two surfaces should agree on every visible run).\n\n' +
        "**If any scenario fails:** fix in this Subtask if it's a Story-level regression; log " +
        'a finding if it points at a deeper service-layer issue (per mistake #27).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/e2e/jobs-flow.spec.ts` covers every bullet in the scenario list; each ' +
        'scenario is its own `test()` block.\n' +
        "- Forced-failure scenario uses a Playwright fixture flag to make `lib/email.ts`'s " +
        'dev-console provider throw deterministically; the flag scope is per-spec, not global.\n' +
        "- Replay scenario asserts the DLQ row's `replayed_at` changes from null to a " +
        'timestamp, AND a fresh `succeeded` job_run appears.\n' +
        '- Cross-workspace isolation scenario uses the existing two-workspace fixture from ' +
        "Story 1.2; asserts zero runs visible when active workspace doesn't match the run's " +
        'workspace.\n' +
        '- Role-gating scenario reuses the existing owner/member fixture pair; verifies the ' +
        'disabled state + tooltip.\n' +
        '- Vitest integration spec at `tests/jobs/integration.test.ts` covers: scheduled job ' +
        'firing; idempotency dedup across duplicate sends; DLQ replay vs idempotency-window ' +
        'interaction (with the documented workaround).\n' +
        '- Story-level verification recipe reproduces locally in ≤12 minutes (includes the ' +
        'Inngest dev-server startup time).\n' +
        '- All quality gates green; existing E2E suite (auth + workspace-flows + projects-flow ' +
        '+ work-items-isolation + shell-a11y + shell-keyboard + shell-flows + jobs-dashboard) ' +
        'stays green; the new spec runs alongside without flake.\n' +
        '- Any cross-Subtask issue surfaced during verification logged in PRODECT_FINDINGS.md.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/workspace-flows.spec.ts` + `jobs-dashboard.spec.ts` — existing patterns ' +
        'to mirror\n' +
        '- `tests/e2e/_helpers/db-reset.ts` + `email-capture.ts` — the reset + ' +
        'email-inspection helpers\n' +
        '- The full jobs stack (`lib/jobs/*`, the serve route, the dashboard page, the email ' +
        'job)\n' +
        '- The Story 1.2 two-workspace fixture pattern; the Story 1.5 a11y + keyboard specs ' +
        '(to extend, not duplicate)',
    },
    {
      id: '1.6.7',
      title:
        'Inngest cloud + Vercel wiring (MANUAL): resolve Deployment Protection, set ' +
        'signing/event keys, sync preview URL, trigger a preview run',
      status: 'done',
      type: 'manual',
      executor: 'human',
      dependsOn: ['1.6.2'],
      descriptionMd:
        'Operational wiring that **only a human with dashboard access can do** — it requires an ' +
        'Inngest account and the Vercel project settings, neither of which a coding agent can ' +
        "reach. Added because Subtask 1.6.1's spike, by probing the real deployed preview, " +
        'discovered that `/api/inngest` (and `/`) sit behind **Vercel Deployment Protection ' +
        "(SSO) and return 401**. Inngest's cloud control plane is an unauthenticated external " +
        'caller, so it hits the same 401 — meaning **the Inngest serve route does NOT work on ' +
        'Vercel preview/prod just by setting the signing/event keys**. The protection must be ' +
        'bypassed for the control plane first. See PRODECT_FINDINGS.md #30 (sharp edge #8).\n\n' +
        '**Why a manual/human Subtask, not folded into 1.6.2:** 1.6.2 is a coding Subtask that ' +
        'lands the SDK + serve route in `main`; it cannot click buttons in app.inngest.com or ' +
        'vercel.com. This wiring gates 1.6.x going *live* in preview/prod (in particular 1.6.3, ' +
        'which migrates real password-reset + invite sends to the job runtime — those would ' +
        "silently fail in prod if Inngest can't invoke the serve route). Tracking it as its own " +
        "dispatchable manual Subtask means it isn't lost when the 1.6.1 spike branch + its " +
        '`docs/findings/inngest-spike.md` runbook are deleted.\n\n' +
        '**Steps (runbook):**\n\n' +
        '- **Resolve Deployment Protection for the control plane.** Install the official ' +
        '**Inngest↔Vercel integration** (Vercel → Integrations). It configures Vercel ' +
        '"Protection Bypass for Automation" so Inngest can reach protected previews *and* ' +
        'auto-syncs the per-push preview URL — the recommended path. Manual alternative: ' +
        'generate a Protection Bypass secret (Vercel → Project → Settings → Deployment ' +
        'Protection → Protection Bypass for Automation) and configure Inngest with it. ' +
        '(Disabling protection entirely is NOT recommended — it weakens preview security.)\n' +
        '- **Get the keys.** Inngest dashboard (app.inngest.com) → create / confirm the ' +
        '`motir-core` app → copy `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` for each ' +
        'target environment.\n' +
        '- **Set the keys in Vercel.** Vercel → Project → Settings → Environment Variables → ' +
        'add both, scope **Preview** (and later **Production**). Do **NOT** set `INNGEST_DEV` ' +
        'in preview/prod. Redeploy so the env takes effect.\n' +
        "- **Verify.** Confirm Inngest synced the preview's `/api/inngest` (now reachable past " +
        "the bypass), then trigger the `example/ping` (or, post-1.6.3, a real job's event) " +
        'from the Inngest dashboard and confirm a run executed in the deployed environment.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Inngest control plane can reach the Vercel preview `/api/inngest` (no 401) — ' +
        'i.e., Deployment Protection is bypassed for that path/caller.\n' +
        "- `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` are set in Vercel's Preview scope (and " +
        'Production before the Story ships to prod); `INNGEST_DEV` is NOT set in either.\n' +
        '- A function (the 1.6.1 `example.ping` or a 1.6.3 real job) is triggered from the ' +
        'Inngest dashboard and observed running in the deployed preview/prod environment.\n' +
        '- The chosen approach (official integration vs. manual bypass secret) is recorded in ' +
        "`docs/jobs.md` when 1.6.2 writes it, so the runtime's prod dependency (the Inngest " +
        'SaaS account + Vercel bypass) is documented.\n\n' +
        '## Context refs\n\n' +
        '- This introduces a production SaaS dependency (an Inngest account). The open-source ' +
        'escape hatch — self-hosting the Inngest server — is documented in #30 if cost / ' +
        'lock-in / data-residency ever forces it.\n' +
        '- Per-push reality: each PR gets a new preview URL + an isolated Vercel-Neon branch ' +
        "DB. The DB doesn't affect Inngest discovery; the changing URL is exactly why the " +
        'auto-syncing official integration (step 1) beats manual URL re-pointing.',
    },
  ],
};
