// ─────────────────────────────────────────────────────────────────────────
// Subtask 1.6.1 — Inngest runtime-validation SPIKE. THROWAWAY CODE.
//
// This file is NOT production code and is NOT meant to merge to `main`. It is
// the smallest unit that proves the Inngest runtime works on the three
// surfaces Story 1.6's real jobs (1.6.2–1.6.6) will run on:
//   1. local dev      — `inngest-cli dev` discovers this via /api/inngest
//   2. Vercel preview  — Inngest's prod control plane discovers the preview URL
//   3. CI test harness — `@inngest/test` runs `ping` in-process inside Vitest
//
// Per the Subtask card we do NOT add a `lib/jobs/` wrapper or a `defineJob()`
// abstraction — that is 1.6.2's job. The spike imports `inngest` directly;
// production code never will. There is no DB access and no business logic here.
// ─────────────────────────────────────────────────────────────────────────

import { Inngest } from 'inngest';

// Single Inngest client instance. `id` is the app identifier the Inngest
// control plane uses to group functions; in production 1.6.2 will likely
// promote this to a shared `lib/inngest/client.ts`. For the spike it lives
// inline to keep the diff to two files.
export const inngest = new Inngest({ id: 'prodect-core' });

// example.ping — a no-op function. Event name is `example/ping` (Inngest's
// convention is `domain/action`); the function id is `example-ping`. It takes
// the event payload and returns a small JSON object. No `step.run`, no DB,
// nothing durable — this is purely a "does the runtime invoke my function and
// hand me back the return value" probe.
//
// SPIKE FINDING: inngest@4.5.0 uses the TWO-arg `createFunction(options,
// handler)` form, with the trigger nested under `options.triggers`. Most of
// the public docs (and the SDK's own older examples) still show the legacy
// THREE-arg form `createFunction({ id }, { event }, handler)`, which throws at
// import time on v4: "Triggers belong in the first argument". 1.6.2 must use
// the form below.
export const ping = inngest.createFunction(
  { id: 'example-ping', triggers: [{ event: 'example/ping' }] },
  async ({ event }) => {
    return {
      ok: true,
      receivedAt: Date.now(),
      echo: event.data ?? null,
    };
  },
);
