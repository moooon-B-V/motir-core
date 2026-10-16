import { NextResponse } from 'next/server';
import { z } from 'zod/v4';

import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { mapMigrateError } from '../../_errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/onboarding/migrate/[id]/index-retry — retry a connected repository's
// FAILED index from the onboarding run (MOTIR-8769). Body `{ repoRef }`. Answers
// the repository's state after the call: `queued` once a failed index is
// re-enqueued, or the current state, unchanged, when it was not failed.
// Edit-gated; a repo outside the run's connected set is 409, a repo the index
// refused for its size is 422.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors.
const bodySchema = z.object({ repoRef: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'VALIDATION_ERROR', error: 'A repository reference (repoRef) is required.' },
      { status: 400 },
    );
  }
  try {
    const result = await migrateOnboardingService.retryIndex(id, parsed.data.repoRef, ctx);
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapMigrateError(err);
    if (mapped) return mapped;
    throw err;
  }
}
