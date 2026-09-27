import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentWorkItemContinueClaim } from '@/lib/api/v1/workLoop/schema';
import { workItemContinueService } from '@/lib/services/workItemContinueService';

// POST /api/v1/work-items/{key}/continue (Story MOTIR-6526 · MOTIR-6532) — the
// CONTINUE CLAIM `motir continue <key>` makes: one continuing agent at a time on a
// work item whose last run died, on the dead run's branch.
//
// ── The route decides NOTHING ───────────────────────────────────────────────
// The lock, the refusal order, the lapsed run it closes, the run it opens and the
// outcome vocabulary all live in `workItemContinueService.claimContinue`, which
// owns the one transaction. This file resolves a key and shapes a response.
//
// ── A refused continue is a 200 ─────────────────────────────────────────────
// `taken` and `not_continuable` are ordinary answers a person running the command
// meets. Real failures keep their statuses: 404 for an unknown or cross-workspace
// key, 422 for a malformed one.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const claim = await workItemContinueService.claimContinue(projectId, identifier, ctx.service);
  return NextResponse.json(presentWorkItemContinueClaim(claim));
});
