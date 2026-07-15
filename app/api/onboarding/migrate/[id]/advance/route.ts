import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';

// POST /api/onboarding/migrate/[id]/advance — attempt the NEXT transition from
// wherever the run sits (Story 7.15 · MOTIR-931). The service kicks the current
// step's action + polls its real exit signal; a transition whose exit condition
// is unmet is REJECTED (409 — the generic guard). Idempotent-safe: a run already
// past a step lands on the wrong-step guard (409).
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors (incl. a metered motir-ai kick → 402/502).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const run = await migrateOnboardingService.advanceNext(id, ctx);
    return NextResponse.json(run, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
