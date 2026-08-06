import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  integrationBodySchema,
  presentIntegrationResult,
  toProvenanceInput,
} from '@/lib/api/v1/workLoop/schema';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/integration (Story 11.7 · Subtask 11.7.4 —
// MOTIR-2238) — record that a work item's work has been integrated onto a
// session branch.
//
// ── ONE service call, because it is ONE transaction ─────────────────────────
// `markIntegrated` moves the item to `in_review` AND stamps its `session_branch`
// inside a single `db.$transaction`. This route must never decompose that into a
// transition call plus a field update: a crash between them would leave an item
// in review with no lineage, and every dependent that inherits the branch would
// then inherit nothing. The atomicity is the service's and this route's job is
// to not take it apart.
//
// ── A POST on a sub-resource, not a PATCH on the item ───────────────────────
// ADR Amendment 6 Q1: it is a state transition WITH a body, not a field edit. A
// PATCH that also moved status would put a second status-writing path beside the
// shipped `POST …/transitions`, and the two could disagree about which
// transitions are legal.
//
// ── The `integration` scope exists for exactly this ─────────────────────────
// `lib/mcp/scopes.ts` defines it as "External-agent integration writes —
// mark-integrated / complete-session". A token holding `work_items:write` and
// not `integration` is refused here, and that refusal is asserted: a bleed would
// make the scope decorative.

export const POST = withV1Route<{ key: string }>({ scope: 'integration' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, integrationBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  // The provenance triple is a SELF-REPORT and is OMITTED entirely when the
  // caller sent none — passing a half-built object would stamp `byok` over a
  // hosted run's own record. `source` defaults to `byok` in the service.
  const provenance = toProvenanceInput(body);

  const dto = await workItemsService.markIntegrated(
    item.id,
    body.sessionBranch,
    ctx.service,
    provenance,
  );

  return NextResponse.json(presentIntegrationResult(dto));
});
