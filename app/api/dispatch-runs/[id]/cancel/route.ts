import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import {
  HostedRunAlreadyEndedError,
  HostedRunCancelForbiddenError,
  HostedRunNotFoundError,
} from '@/lib/hostedRuns/errors';
import { hostedRunService } from '@/lib/services/hostedRunService';

// POST /api/dispatch-runs/[id]/cancel (Story MOTIR-683 · MOTIR-6450) — a person
// cancels a running HOSTED run from the run panel. `hostedRunService.cancel` is
// the whole behaviour: the run's key, credential and git tokens are revoked and
// the run closed `cancelled` now; its container is torn down by its supervisor at
// the next poll.
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate, ONE service
// call, the error → status map. A cookie-session route on the app's own `/api`
// surface, beside the run's GET — not `/api/v1`, for the reason that route gives.
//
// ⚠️ 404 FOR A RUN IN ANOTHER WORKSPACE, never 403 — the sibling route's
// convention; 403 is only for a member of the project who is neither the
// dispatcher nor an admin.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function problem(code: string, error: string, status: number): Response {
  return NextResponse.json({ code, error }, { status, headers: NO_STORE });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id } = await params;

  try {
    const cancelled = await hostedRunService.cancel(id, gate.ctx);
    return NextResponse.json(cancelled, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof HostedRunNotFoundError) return problem(err.code, err.message, 404);
    if (err instanceof HostedRunCancelForbiddenError) return problem(err.code, err.message, 403);
    if (err instanceof HostedRunAlreadyEndedError) return problem(err.code, err.message, 409);
    throw err;
  }
}
