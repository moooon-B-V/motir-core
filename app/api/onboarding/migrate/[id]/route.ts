import { NextResponse } from 'next/server';

import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../_errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

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
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

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
