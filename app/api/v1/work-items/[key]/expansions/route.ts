import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentPlanJobHandle } from '@/lib/api/v1/workLoop/schema';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/expansions (Story 11.7 · Subtask 11.7.5 —
// MOTIR-2239) — submit an AI expansion of one CONTAINER work item.
//
// ── 202, and a body with no field a RESULT could arrive in ──────────────────
// ADR Amendment 6 Q3. This returns the moment motir-ai ACCEPTS the job: nothing
// has been planned, and what eventually appears is a Plan of PROPOSALS. The
// handle carries `{ jobId, planId, statusUrl }` and nothing else — no `items`,
// no `count`, no `status` — so a client cannot read an outcome out of it, only
// an address to come back to.
//
// ── NOTHING here creates a work item ────────────────────────────────────────
// `plansService.approvePlan` — a human decision made in Motir, not on this
// surface — is the only path from a proposal to a `work_item` row, and an
// `add`'s `workItemId` stays null until then. The suite asserts the work-item
// table is unchanged across a whole submit-and-read cycle.
//
// ── It SPENDS CREDITS, which is why the scope is a write ────────────────────
// `work_items:write` — mirrored from `lib/mcp/scopes.ts`, whose entry reasons it
// out as "the narrowest shipped scope that admits a plan-mutating, billable
// submit". A read-only token cannot fire one. It is also why the operation's
// description says so: a naive retry-on-timeout is a real cost, not a duplicate
// row.
//
// ── The ITEM is resolved BEFORE the submit, on purpose ─────────────────────
// `submitExpand` raises ONE error — `InvalidTargetError` — for two different
// things: a key naming no item in this project, and a key naming a LEAF. Those
// deserve different statuses (§4: a resource that does not exist, or is outside
// this token's workspace, is a 404; a leaf is a 422 the caller can fix), and a
// route cannot split one error class after the fact. So the read that answers
// "does this item exist FOR YOU" runs first and raises its own 404, leaving
// `INVALID_TARGET` to mean exactly one thing.
//
// Three service calls, all RESOLVE, then the submit — the bounded-call rule.

export const POST = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const project = await projectsService.getByKey(
    identifier.slice(0, identifier.lastIndexOf('-')),
    ctx.service,
  );
  // 404 for an item that does not exist or is not this token's to see.
  await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  const result = await aiPlanEditsService.submitExpand(identifier, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    project,
  });

  return NextResponse.json(presentPlanJobHandle(result), { status: 202 });
});
