import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { membershipMoveBodySchema, presentMembershipMove } from '@/lib/api/v1/sprints/membership';
import { backlogService, MAX_BULK_BATCH_SIZE } from '@/lib/services/backlogService';
import { BulkBatchTooLargeError } from '@/lib/sprints/errors';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/projects/{projectKey}/backlog/work-items (Story 11.3 · Subtask
// 11.3.7 — MOTIR-2064) — move a batch of work items OUT of whatever sprint they
// are in, back to the project backlog.
//
// The mirror of the sprint-membership move, and `sprints:write` for the same
// reason: the ADR §3 row is "move an item into or out of a sprint", keyed on the
// sprint relationship rather than on the path the request happens to take.
//
// ── The item KEEPS its backlogRank ──────────────────────────────────────────
// `bulkMoveToBacklog` clears the sprint association and leaves the rank alone,
// so an item returns to the backlog in the position it had rather than at the
// bottom. An item ALREADY in the backlog is a per-item no-op: no write, and no
// revision recorded — so a client that re-sends a batch does not pollute the
// history.
//
// Atomicity and key resolution are the sibling route's, for the same reasons.
export const POST = withV1Route<{ projectKey: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, membershipMoveBodySchema);
  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);

  const keys = body.workItemKeys.map((key) => key.toUpperCase());
  // ⚠️ The cap is the SERVICE's, imported rather than re-stated, and applied
  // HERE only so an over-cap request does not first pay for a 100-key
  // resolution it was always going to be refused for. Same constant, same typed
  // error, same message — this is an ordering choice, not a second rule.
  if (keys.length > MAX_BULK_BATCH_SIZE) {
    throw new BulkBatchTooLargeError(keys.length, MAX_BULK_BATCH_SIZE);
  }

  const itemIds = await workItemsService.resolveIdentifiersToIds(project.id, keys, ctx.service);

  const moved = await backlogService.bulkMoveToBacklog(itemIds, ctx.service);
  return NextResponse.json(presentMembershipMove(moved));
});
