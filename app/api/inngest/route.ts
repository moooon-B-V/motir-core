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
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: jobFunctions,
});
