import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/dispatch-runs/[id] (Story MOTIR-1789 · MOTIR-1793) — the run WITH its
// set, for the browser.
//
// ⚠️ THE APP'S OWN `/api` SURFACE, NOT `/api/v1`, AND THAT IS A DECISION. The
// INGEST is PAT-authenticated writes from a headless process and belongs in the
// public contract; this is a COOKIE-SESSION read from a logged-in browser whose
// shape will move as the run surfaces evolve. The v1 document is a promise of
// stability to PAT-holding clients, and a browser read does not belong in it —
// the shipped job streams settled that convention and this follows it.
//
// The ORDER is the run's own stored `position`, straight from the service. A
// client must never re-sort it: the order came from an intra-scope topological
// sort at claim time, over edges that may since have changed.
//
// ⚠️ 404 FOR A RUN IN ANOTHER WORKSPACE, never 403 — the shipped convention, and
// here it falls out of RLS rather than being re-implemented: the read simply
// returns nothing.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  try {
    return NextResponse.json(await dispatchRunService.getRunDetail(id, gate.ctx));
  } catch (err) {
    if (err instanceof DispatchRunNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
