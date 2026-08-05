import { serve } from 'inngest/next';
import { inngest } from '@/lib/jobs/client';
import { jobFunctions } from '@/lib/jobs/registry';

// The Inngest serve route (Story 1.6 · Subtask 1.6.2) — the single endpoint
// the Inngest control plane (or the local `inngest-cli dev` server) syncs and
// invokes functions through. App Router exports the three verbs:
//   - GET  → registration / introspection probe
//   - PUT  → registration (the dev server / cloud syncs functions here)
//   - POST → function invocation
//
// This is the ONLY file in the app permitted to import from `inngest` /
// `inngest/*` outside `lib/jobs/**` (enforced by the eslint no-restricted-
// imports rule). Everything else goes through `sendEvent` / `defineJob`.
//
// The signing key (which verifies requests from the cloud control plane) is
// read automatically by the SDK from INNGEST_SIGNING_KEY — it's not a settable
// option. In cloud mode a missing key raises Inngest's own clear error at
// request time (finding #30 sharp edge #2); local dev (INNGEST_DEV=1) needs no
// key.
//
// ⚠️ FUNCTION DURATION (MOTIR-1974). Every job in the app is invoked through
// THIS route, so the platform's function timeout is the ceiling on ONE
// invocation — i.e. on one `step.run`, not on a whole run (Inngest checkpoints
// between steps and re-invokes). Left implicit, the route inherited Vercel's
// low default, and `system.code-graph-index` — a repo tarball fetch plus a
// motir-ai upload, against a scale-to-zero machine whose cold start alone
// measured ~23s — was killed mid-flight every time: five runs, five attempts
// each, all dead-lettered with `FUNCTION_INVOCATION_TIMEOUT` and no step output
// (so Inngest saw a platform 504 rather than a typed error). Declaring it makes
// the budget an explicit, reviewable number sized to the real work.
//
// 300s is the Pro plan's serverless maximum (Fluid compute allows more; we do
// not rely on it). It must stay ABOVE the boundary deadlines the slowest step
// can spend, so a hung dependency surfaces as a typed, retryable error INSIDE
// the budget instead of as an invocation kill. Change one, check the others.
// Neither code-graph job spends the old 180s upload deadline here any more —
// both dispatch containers (MOTIR-2027 / MOTIR-2057), the upload client itself
// is deleted (MOTIR-2138), and their longest in-function step is a URL resolve
// bounded by `REPO_TARBALL_TIMEOUT_MS` (60s).
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: jobFunctions,
});
