import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { projectKeyOfWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { membershipMoveBodySchema, presentMembershipMove } from '@/lib/api/v1/sprints/membership';
import { backlogService, MAX_BULK_BATCH_SIZE } from '@/lib/services/backlogService';
import { BulkBatchTooLargeError } from '@/lib/sprints/errors';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/sprints/{sprintId}/work-items (Story 11.3 · Subtask 11.3.7 —
// MOTIR-2064) — move a batch of work items INTO a sprint.
//
// ── ATOMIC, because the SERVICE is ───────────────────────────────────────────
// `bulkAssignToSprint` loads and validates the WHOLE batch before any write, and
// every write plus its revision commits in one transaction: one unknown,
// cross-workspace or cross-project member rejects the entire move, with nothing
// landed. This route EXPOSES that; it must not loop a per-item call, which would
// convert an all-or-nothing move into a partial one at the transport.
//
// ── Key resolution is ONE call, not one per key ─────────────────────────────
// A batch takes up to 100 keys. `resolveIdentifiersToIds` resolves them all in a
// single round trip and throws on the first unresolved one — the bounded-call
// rule (ADR Amendment 3, Q4): a route may make a constant number of RESOLVE /
// PROJECT calls and never one per row.
//
// The sprint is read FIRST: it is what makes an unknown or cross-tenant sprint
// id a 404 before the request touches anything else.
export const POST = withV1Route<{ sprintId: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, membershipMoveBodySchema);
  const sprint = await sprintsService.getById(ctx.params.sprintId, ctx.service);

  // An empty batch is a 200 no-op (the service guards it as one) and has no key
  // to resolve a project from, so it short-circuits before the resolution below.
  const keys = body.workItemKeys.map((key) => key.toUpperCase());
  if (keys.length === 0) return NextResponse.json(presentMembershipMove([]));

  // ⚠️ The cap is the SERVICE's, imported rather than re-stated, and applied
  // HERE only so an over-cap request does not first pay for a 100-key
  // resolution it was always going to be refused for. Same constant, same typed
  // error, same message — this is an ordering choice, not a second rule.
  if (keys.length > MAX_BULK_BATCH_SIZE) {
    throw new BulkBatchTooLargeError(keys.length, MAX_BULK_BATCH_SIZE);
  }

  // ⚠️ The project comes from the KEY's own prefix, not from the sprint.
  // `SprintDto` deliberately carries no `projectId`, and widening a product DTO
  // to suit a v1 route is the direction §9's corollary forbids. A `MOTIR-<n>`
  // key names its project by construction, and `projectsService.getByKey` is
  // workspace-gated, so this resolution cannot reach another tenant. Whether the
  // items and the SPRINT agree is then the service's own
  // `CrossProjectSprintAssignmentError` — a check that already exists and
  // already rejects the whole batch before any write.
  const project = await projectsService.getByKey(
    projectKeyOfWorkItemKey(keys[0] as string),
    ctx.service,
  );
  const itemIds = await workItemsService.resolveIdentifiersToIds(project.id, keys, ctx.service);

  const moved = await backlogService.bulkAssignToSprint(itemIds, sprint.id, ctx.service);
  return NextResponse.json(presentMembershipMove(moved));
});
