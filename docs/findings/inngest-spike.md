# Inngest runtime validation — spike proof (Subtask 1.6.1)

> **Throwaway spike.** This branch (`subtask/PROD-1.6.1-inngest-spike`) is a
> runtime-validation gate, not production code. It does **not** merge to `main`.
> Subtask 1.6.2 starts from `main` and builds the real `lib/jobs/` layer using
> this page as its runbook. Much of this doc will be replaced by `docs/jobs.md`.

**Date:** 2026-06-01 · **Stack:** Next.js 16.2.6 (App Router, Turbopack), Node 22, pnpm 11.2.2, Vitest 4.1.7

## What this spike proves

The Story 1.6 background-job runtime (Inngest, per ADR-004 / `prodect_plan`) is
validated on the three surfaces real jobs (1.6.2–1.6.6) will run on. The spike
is a 2-file runtime (`app/api/inngest/route.ts` serve route + `spike.ts` client
& one `example.ping` no-op function), exercised three ways.

| #   | Surface                                               | Result                       | How proven                                                                                                                  |
| --- | ----------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Local dev** (`inngest-cli dev` + `next dev`)        | ✅ PASS                      | CLI discovered the function via `/api/inngest`; event triggered; run reached `COMPLETED` with full step history             |
| 2   | **Vercel preview** (prod control plane → preview URL) | ⚠️ **NOT EXECUTED in spike** | Requires Vercel + Inngest **dashboard** access the automated spike env doesn't have. Manual runbook below; **human-gated**. |
| 3   | **CI harness** (`@inngest/test` in Vitest)            | ✅ PASS                      | In-process run, no live server; asserts exact return shape. `pnpm test` green.                                              |

**Honest scope note:** the spike ran in a headless sandbox with **no `vercel`
CLI and no Inngest cloud account**. Surfaces 1 and 3 — which carry the real
_code-feasibility_ risk (does the SDK work here, does the API shape hold, does
the test harness compose with Vitest 4) — were executed and pass. Surface 2 is
an _operational / credentials_ task (set keys in two dashboards, click deploy);
it is documented, not executed. See [§Validation 2](#validation-2--vercel-preview).

## Package versions installed (pin these in 1.6.2)

| Package         | Version    | Dep type                                                                                  |
| --------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `inngest`       | **4.5.0**  | dependency                                                                                |
| `@inngest/test` | **1.0.0**  | devDependency                                                                             |
| `inngest-cli`   | **1.23.0** | devDependency (local-dev only; `1.24.0` available but pnpm resolved `1.23.0` as `latest`) |

## The two-file runtime shape (what 1.6.2 copies)

`app/api/inngest/spike.ts` — client + function (1.6.2 splits client → `lib/inngest/client.ts`, functions → `lib/jobs/`):

```ts
import { Inngest } from 'inngest';
export const inngest = new Inngest({ id: 'prodect-core' });

// ⚠️ inngest@4.5.0 = TWO-arg form; trigger nested in options.triggers.
export const ping = inngest.createFunction(
  { id: 'example-ping', triggers: [{ event: 'example/ping' }] },
  async ({ event }) => ({ ok: true, receivedAt: Date.now(), echo: event.data ?? null }),
);
```

`app/api/inngest/route.ts` — App Router serve route:

```ts
import { serve } from 'inngest/next';
import { inngest, ping } from './spike';
export const { GET, POST, PUT } = serve({ client: inngest, functions: [ping] });
```

## Env-var matrix

| Var                   | local-dev         | CI (Vitest) | Vercel preview                        | Vercel prod         | Notes                                                                                                                                  |
| --------------------- | ----------------- | ----------- | ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `INNGEST_DEV`         | **`=1` REQUIRED** | not needed  | **must NOT be set**                   | **must NOT be set** | Without it the serve route 500s "cloud mode, no signing key" locally. In preview/prod its presence would force dev mode — leave unset. |
| `INNGEST_SIGNING_KEY` | not needed        | not needed  | **REQUIRED**                          | **REQUIRED**        | Control-plane ↔ serve-route auth. From Inngest dashboard → Keys.                                                                       |
| `INNGEST_EVENT_KEY`   | not needed        | not needed  | **REQUIRED** (once code sends events) | **REQUIRED**        | Auth for `inngest.send()`. The no-op `ping` doesn't send, but 1.6.2's real jobs will.                                                  |

These stubs were added to `.env.example` but **deliberately NOT wired into any
`requiredEnv` boot check** — that is 1.6.2's job. (Card said "don't touch
`lib/env.ts`"; note there is **no `lib/env.ts`** — the `requiredEnv` helper
lives in `lib/auth/index.ts`. Left untouched either way.)

## Sharp edges discovered

1. **`inngest@4.5.0` API change — `createFunction` is now 2-arg.** The trigger
   moved into the first arg (`{ id, triggers: [{ event }] }`); the handler is
   the 2nd arg. The legacy 3-arg form `createFunction({id}, {event}, handler)`
   shown in most public docs **throws at import time**: _"Triggers belong in the
   first argument."_ 1.6.2 must use the 2-arg form (above).
2. **Serve route defaults to CLOUD mode locally → 500.** Without a signing key
   and without `INNGEST_DEV=1`, `GET /api/inngest` returns
   `500 {"code":"internal_server_error"}` and logs _"In cloud mode but no
   signing key found. For local dev, set the INNGEST_DEV=1 env var."_ Setting
   `INNGEST_DEV=1` flips it to dev mode (`GET` → `200 {"mode":"dev","function_count":1}`).
3. **pnpm 11 blocks the `inngest-cli` postinstall build.** `pnpm add` records it
   in `pnpm-workspace.yaml` `allowBuilds:` as a placeholder string
   (`inngest-cli: set this to true or false`) — an **invalid value that makes
   `pnpm install` exit non-zero**, which in turn makes `pnpm test`/`pnpm <script>`
   fail (pnpm 11 runs a deps-status `install` check before scripts). Fix: set
   `inngest-cli: true` (downloads the Go dev-server binary) and resolve
   `protobufjs` to a boolean too (`false` is fine — basic function execution
   doesn't need its native build).
4. **The pnpm `.bin/inngest-cli` shim mis-execs the ELF binary** (tries to parse
   it as JS → `SyntaxError`). Run the platform binary directly
   (`node_modules/.pnpm/inngest-cli@1.23.0/node_modules/inngest-cli/bin/inngest dev -u …`)
   or use `npx inngest-cli@latest dev`.
5. **Port collision (the doooo/3001 lesson).** `next dev` silently fell back to
   `:3001` when a stale dev server held `:3000`; pin the port (`next dev -p 3010`)
   and pass the matching `-u http://localhost:3010/api/inngest`. `inngest-cli dev`
   uses `:8288` (UI/API) + `:8289` (connect gateway) + gRPC `:50052/50053` — all
   free here, but worth knowing if other local services crowd those.
6. **Dev-server run-level `output` renders empty for direct-return functions.**
   A function that `return`s a plain object (no `step.run`) completes fine but
   the dev server (v1.23.0) shows `output: ""` at the run level. Execution is
   real (full history + `POST …?fnId=…&stepId=step 206`). If 1.6.2 wants visible
   per-step outputs in the dev UI, wrap work in `step.run(...)`. The exact return
   _shape_ is asserted in the `@inngest/test` harness instead (reliable there).
7. **`@inngest/test@1.0.0` pins `vitest@^3` in its own devDeps** but is
   framework-agnostic (Jest-compatible, doesn't import vitest) — it composes
   with this repo's **Vitest 4.1.7** with no shim. The flagged "doesn't compose
   with Vitest 4" risk did **not** materialize.
8. **`@inngest/test` default event has `data: {}` (not `undefined`).** With no
   `events:` mock, the harness injects a synthetic `inngest/function.invoked`
   event whose `data` is an empty object. Tests asserting on a default-event run
   must expect `{}`; pass an explicit `events:` mock when the function branches
   on payload.

## Validation 1 — local dev (executed ✅)

```
# terminal A — pin the port to dodge the :3000→:3001 fallback
INNGEST_DEV=1 pnpm exec next dev -p 3010
# terminal B — point the dev server at the serve route
node_modules/.pnpm/inngest-cli@1.23.0/node_modules/inngest-cli/bin/inngest \
  dev -u http://localhost:3010/api/inngest --no-discovery
```

Evidence captured:

- `GET http://localhost:3010/api/inngest` →
  `200 {"has_signing_key":false,"function_count":1,"mode":"dev",…}`
- Dev server synced (recurring `PUT /api/inngest 200` in the next log). GraphQL
  `{ apps }` →
  `{"name":"prodect-core","connected":true,"functionCount":1,"functions":[{"slug":"prodect-core-example-ping"}]}`
- Trigger: `POST http://localhost:8288/e/dev-key`
  `{"name":"example/ping","data":{…}}` → `{"ids":["01KT2GBM…"],"status":200}`
- Run: `functionRun` → `status:"COMPLETED"`, history
  `FunctionScheduled → FunctionStarted → StepStarted(step) → StepCompleted(step) → FunctionCompleted`;
  next log shows `POST /api/inngest?fnId=prodect-core-example-ping&stepId=step 206`.

## Validation 2 — Vercel preview (NOT executed — human runbook)

The spike could not execute this: no `vercel` CLI and no Inngest cloud account
in the sandbox. **Yue must run these steps** (they gate 1.6.x going live in
preview/prod, but do **not** block 1.6.2 _code_ work):

1. Push the branch → confirm Vercel (team `zhuyue11s-projects`) auto-builds a
   preview deployment for `prodect-core` and that **boot succeeds** (the preview
   opens a Prisma connection against its Vercel-Neon per-PR branch DB; `ping`
   itself doesn't touch the DB, so this only proves boot isn't broken by the
   Inngest additions — confirmed locally, expected fine).
2. Inngest dashboard (`app.inngest.com`) → create/confirm an Inngest **app** and
   grab `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` for the target environment.
3. Vercel dashboard → **Settings → Environment Variables** → add both keys with
   scope = **Preview** (and later **Production**). Do **not** set `INNGEST_DEV`.
   Redeploy the preview so the new env takes effect.
4. In the Inngest dashboard, register/sync the preview's `/api/inngest` URL
   (Inngest's prod control plane discovers it once the signing key matches), then
   trigger `example/ping` from the dashboard and confirm a run executed **in the
   preview deployment**.
5. Note the interaction: Vercel mints a **new preview URL per push**, and each
   PR gets an **isolated Neon branch DB** — neither affects Inngest discovery
   (Inngest keys off the signing key + the synced URL, not the DB), but the
   per-push URL means the Inngest app's synced URL must be re-pointed (or use
   Inngest's Vercel integration, which auto-syncs preview URLs). **Recommend
   1.6.2 install the official Inngest↔Vercel integration** so preview URLs sync
   automatically rather than by hand.

## Validation 3 — CI harness (executed ✅)

`tests/spike/inngest-runtime.test.ts` runs `example.ping` in-process via
`InngestTestEngine`, asserts the return shape, no live server. `tests/**/*.test.ts`
is already in the Vitest `include` glob → **no CI config change needed**.

```
$ pnpm test tests/spike/inngest-runtime.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

## Recommendation for 1.6.2

**Green-light the code work.** The runtime SDK, the App-Router serve-route shape,
the (changed) `createFunction` API, and the `@inngest/test`-on-Vitest-4 harness
are all validated. 1.6.2 should: pin the versions above; use the 2-arg
`createFunction`; promote client → `lib/inngest/client.ts` and functions →
`lib/jobs/` behind the planned `defineJob()`; set `INNGEST_DEV=1` in the local
dev script; wire `INNGEST_SIGNING_KEY` (and `INNGEST_EVENT_KEY` once jobs send
events) into `requiredEnv` **for preview/prod only**; and install the official
Inngest↔Vercel integration. **One human-gated item carries over:** the
Vercel-preview + Inngest-cloud wiring (Validation 2) must be completed by Yue in
the two dashboards before any 1.6.x job runs in preview/production.
