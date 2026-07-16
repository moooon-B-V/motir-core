import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';

// GET /api/onboarding/migrate/[id]/index-status — the Index step's live per-repo
// progress (Story 7.15 · MOTIR-934). The wizard polls this to render the
// per-repo rows + the aggregate meter + the all-indexed gate. Browse-gated;
// returns the connected repo set mapped to indexed/pending + an aggregate
// hasRunning flag. `no-store` so a resume never reads a stale index cache.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const status = await migrateOnboardingService.getIndexStatus(id, ctx);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
