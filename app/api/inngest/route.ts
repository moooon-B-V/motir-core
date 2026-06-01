// ─────────────────────────────────────────────────────────────────────────
// Subtask 1.6.1 — Inngest serve route (App Router). THROWAWAY SPIKE CODE.
//
// Mounts the Inngest HTTP endpoint at `/api/inngest` per Inngest's Next.js
// App Router integration. This single route is:
//   - what `inngest-cli dev` polls locally to discover registered functions,
//   - what Inngest's prod control plane PUTs to (to sync) and POSTs to (to
//     invoke) on the deployed Vercel preview / production URL.
//
// `serve()` from `inngest/next` returns the App Router method handlers:
//   GET  — introspection / health (used by the dev server's discovery)
//   PUT  — registration / sync (control plane registers the functions)
//   POST — invocation (control plane calls a function to run it)
//
// Production (1.6.2) will keep this exact shape but import the client and the
// real function list from `lib/inngest/` instead of the inline spike file.
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'inngest/next';
import { inngest, ping } from './spike';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ping],
});
