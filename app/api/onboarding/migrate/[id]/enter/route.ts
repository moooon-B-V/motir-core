import { NextResponse } from 'next/server';

import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/onboarding/migrate/[id]/enter — Enter Motir (MOTIR-8770). Finishes
// the run from `index` or `import` while the index and any import keep running;
// starts nothing. No body. Answers the completed run. Idempotent — a run already
// `done` returns as-is.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  try {
    const run = await migrateOnboardingService.enter(id, ctx);
    return NextResponse.json(run, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
