import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { onboardingSubstrateService } from '@/lib/services/onboardingSubstrateService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// GET /api/planning/substrate (Story MOTIR-4753 · MOTIR-4829) — what the active
// project HAS, read live, so the plan window can tell when a repository it is
// waiting on has finished indexing.
//
// ⚠️ IT EXISTS BECAUSE THE WINDOW IS A CLIENT ISLAND. The overlay is seeded from
// server props in a `useState` initializer, so `router.refresh()` cannot reach it
// (`CLAUDE.md` § page state after a mutation, case 3): re-rendered server props
// are silently ignored. Something the island can ASK is the only instrument that
// works, and the alternative — re-dispatching the routing run on a timer — spends
// a model call per poll to learn a fact a database read already holds.
//
// ⚠️ IT RENDERS NO VERDICT AND CHOOSES NO DESTINATION. It answers *what does this
// project have?* and stops there, exactly as `readOnboardingSubstrate` does; what
// an unindexed repository MEANS is the planner's (MOTIR-4828). The window asks
// the routing run again once this says the graph has landed.
//
// Thin HTTP layer over one service method (`CLAUDE.md` 4-layer). `no-store`,
// because a cached answer here is a window that never notices the wait ended.
export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // ⚠️ GATED EXPLICITLY, NOT BY THE SHAPE OF THE READ. `getActiveProject` already
  // resolves inside the caller's own workspace, so this route was reachable-only-
  // by-a-member before the assertion — and `noUngovernedOperation` is right to
  // refuse that: an operation reaching the database owes a stated policy, and
  // "the resolver happens to scope it" is a property of another function that a
  // reader of THIS one cannot see. `project:browse` is the same key every other
  // read of a project's own facts asserts.
  try {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'project:browse',
    );
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    throw err;
  }

  const substrate = await onboardingSubstrateService.readOnboardingSubstrate(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return NextResponse.json(substrate, { headers: { 'Cache-Control': 'private, no-store' } });
}
