import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../_errors';

// GET /api/onboarding/migrate/[id] — the RESUMABLE head read (Story 7.15 ·
// MOTIR-931). Returns the run's saved step + status so re-opening the wizard
// resumes exactly there, never restarting from `connect`.
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
    const run = await migrateOnboardingService.getById(id, ctx);
    return NextResponse.json(run, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
