import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { completeSprintBodySchema, presentSprint } from '@/lib/api/v1/sprints/schema';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { sprintsService } from '@/lib/services/sprintsService';

// POST /api/v1/sprints/{sprintId}/complete (Story 11.3 · Subtask 11.3.6 —
// MOTIR-2063) — close an active sprint and route its unfinished work.
//
// ── The same shipped lock, the same hands-off route ─────────────────────────
// `completeSprint` locks the project's active sprint `FOR UPDATE` inside its
// transaction and refuses if that row is no longer THIS sprint (a concurrent
// complete won) — so a lost race becomes `SprintNotCompletableError`, a typed
// 422, rather than a raw driver error. The whole carry-over + close is ONE
// transaction: a mid-batch failure rolls back everything, never a half-moved set.
// The route adds no guard of its own.
//
// ── What `carryOverTo` does, and what it deliberately does NOT ──────────────
// Default `'backlog'`: each unfinished issue's sprint association is cleared and
// it keeps its `backlogRank`, so it re-appears in the backlog in order.
// `{ sprintId }`: the unfinished issues are appended to that PLANNED, same-project
// sprint's rank tail. A non-planned, cross-project or self target is the
// service's typed `InvalidCarryOverTargetError` → 422.
//
// DONE-category issues always STAY on the completed sprint — that is the
// sprint's historical record, and the response says so implicitly by reporting
// `issueCount` as what remains rather than as what the sprint once held.
export const POST = withV1Route<{ sprintId: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, completeSprintBodySchema);
  const completed = await sprintsService.completeSprint(
    ctx.params.sprintId,
    body.carryOverTo !== undefined ? { carryOverTo: body.carryOverTo } : {},
    ctx.service,
  );
  return NextResponse.json(presentSprint(completed));
});
