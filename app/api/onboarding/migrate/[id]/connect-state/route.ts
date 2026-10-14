import { NextResponse } from 'next/server';

import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/onboarding/migrate/[id]/connect-state — the Connect step's live read
// (Story MOTIR-8241 · MOTIR-8472): the organisation the connect flow targets,
// whether an installation is bound to it, the repositories the exit gate can use,
// and ONE outcome value the step renders. The optional `?before=` is the snapshot
// a previous read returned, echoed back when the person returns from GitHub.
// Side-effect free, so the step can re-read on every focus; `no-store` so a return
// from GitHub never reads a cached answer.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const before = new URL(req.url).searchParams.get('before');
  try {
    const state = await migrateOnboardingService.getConnectState(id, ctx, { before });
    return NextResponse.json(state, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
