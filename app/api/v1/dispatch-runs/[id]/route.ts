import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/v1/dispatch-runs/{id} (Story MOTIR-683 · MOTIR-6558) — one run WITH
// ITS SET, the same DTO the ingest operations answer with.
//
// ── Why the work loop needs it now ─────────────────────────────────────────
// A hosted run is OPENED BY THE SERVER, with every card it owns, and the `motir`
// CLI in its container ADOPTS it rather than opening a second
// (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §3). Adopting means
// learning the set — which cards, in which order — and the set lives on the run.
// Re-deriving it from a fresh scope claim would be a second answer to "what did
// this run set out to do?", and the cards the server already claimed are no
// longer in the ready set a claim is built from.
//
// ⚠️ `acceptsRunToken` — a hosted run's own credential may read its own run and
// no other: `dispatchRunService.getRun` refuses any other `{id}` with
// `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` (403) before reading it.
export const GET = withV1Route<{ id: string }>(
  { permission: 'project:browse', acceptsRunToken: true },
  async (ctx) => {
    const run = await dispatchRunService.getRun(ctx.params.id, ctx.service);
    return NextResponse.json(run);
  },
);
