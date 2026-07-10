import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { MigrateOnboardingExistsError } from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/onboarding/migrate — START a migrate-existing-codebase onboarding run
// for the actor's active project (Story 7.15 · MOTIR-931). At most one run per
// project; a second start 409s. Returns the run at its `connect` step.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors. The service owns the transaction.
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // The connect-step repo ref may be supplied up front or set as connect
  // completes; the body is optional.
  let connectedRepoRef: string | null = null;
  try {
    const body = (await req.json()) as { connectedRepoRef?: unknown } | null;
    if (body && typeof body.connectedRepoRef === 'string') connectedRepoRef = body.connectedRepoRef;
  } catch {
    // no / empty body — start with no repo ref
  }

  try {
    const run = await migrateOnboardingService.startMigration(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { connectedRepoRef },
    );
    return NextResponse.json(run, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof MigrateOnboardingExistsError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
