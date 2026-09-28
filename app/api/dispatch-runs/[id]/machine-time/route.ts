import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { DispatchRunNotFoundError } from '@/lib/dispatchRuns/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/dispatch-runs/[id]/machine-time (Story MOTIR-683 · MOTIR-691) — a run's
// billable machine seconds, and whether every container that served it has
// settled, for the hosted run's cost block. Over the fleet meter's by-run read
// (MOTIR-6448).
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate, ONE service
// call, the error → status map. A cookie-session read beside the run's own GET,
// on the app's `/api` surface for the reason that route gives.
//
// ⚠️ 404 FOR A RUN IN ANOTHER WORKSPACE, never 403 — the run GET's convention.
// ⚠️ NO MONEY: the meter's `costUsd` is Motir's own fleet cost, never a price.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  try {
    return NextResponse.json(await dispatchRunService.getMachineTime(id, gate.ctx), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (err instanceof DispatchRunNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
