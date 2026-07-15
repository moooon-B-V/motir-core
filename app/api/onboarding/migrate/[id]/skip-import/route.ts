import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';

// POST /api/onboarding/migrate/[id]/skip-import — skip the OPTIONAL import step
// (Story 7.15 · MOTIR-1643). Transitions `import → audit_convention` with
// `importSkipped = true`. Idempotent — a run that already skipped or advanced
// past import returns the current row as-is.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id } = await params;
  try {
    const run = await migrateOnboardingService.skipImport(id, ctx);
    return NextResponse.json(run, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
