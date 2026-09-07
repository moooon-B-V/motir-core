import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import {
  isMigrateOnboardingStep,
  type MigrateOnboardingStepDto,
} from '@/lib/dto/migrateOnboarding';
import { MigrateOnboardingExistsError } from '@/lib/migrateOnboarding/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// POST /api/onboarding/migrate — START a migrate-existing-codebase onboarding run
// for the actor's active project (Story 7.15 · MOTIR-931). At most one run per
// project; a second start 409s. Returns the run at its `connect` step.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors. The service owns the transaction.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
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
  // THE PLANNER'S KEPT SET (MOTIR-4759), when the routing verdict sent this user
  // here — it rides the address the hand-off wrote and the wizard forwards it on
  // the START call, because the set describes the verdict that OPENED this run.
  //
  // ⚠️ VALIDATED AGAINST THE MACHINE'S OWN ENUM, never accepted as free text. A
  // set naming a step this product does not have was already refused upstream
  // (motir-ai refuses the verdict; the navigation sibling routes it to
  // new-project onboarding) — this is the same rule at the last door, so a
  // hand-typed address cannot put a run into a shape the rail cannot draw.
  let keptSteps: MigrateOnboardingStepDto[] = [];
  try {
    const body = (await req.json()) as { connectedRepoRef?: unknown; keptSteps?: unknown } | null;
    if (body && typeof body.connectedRepoRef === 'string') connectedRepoRef = body.connectedRepoRef;
    if (Array.isArray(body?.keptSteps)) {
      keptSteps = body.keptSteps.filter(isMigrateOnboardingStep);
    }
  } catch {
    // no / empty body — start with no repo ref and no verdict
  }

  try {
    const run = await migrateOnboardingService.startMigration(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      { connectedRepoRef, keptSteps },
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
