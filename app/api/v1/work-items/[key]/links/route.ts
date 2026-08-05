import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  parseV1Body,
  presentWorkItemLinkGroups,
  relationshipSchema,
  workItemKeySchema,
} from '@/lib/api/v1/workItems/schema';
import type { RelationshipKind, WorkItemLinkKindDto } from '@/lib/dto/workItemLinks';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { workItemsService } from '@/lib/services/workItemsService';

// GET + POST + DELETE /api/v1/work-items/{key}/links (Story 11.2 · Subtask
// 11.2.9 — MOTIR-2051) — the dependency and relationship edges.
//
// The edges are what make Motir's data a PLAN rather than a list: `blocked_by`
// is the edge the ready set reads, so an integration that cannot write one
// cannot express a dependency at all.
//
// ── One declaration for the group shape ─────────────────────────────────────
// The five groups are presented by the SAME function the detail resource nests
// (`presentWorkItemLinkGroups`), so "the links sub-resource" and "the links
// inside the item" are literally one declaration. Two shapes for one concept is
// how they drift.

const linkBodySchema = z
  .object({ toKey: workItemKeySchema, relationship: relationshipSchema })
  .strict();

export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  // ONE service call: the aggregate already resolves all five groups. Assembling
  // them from several reads would be both slower and a second place for the
  // shape to diverge.
  const detail = await workItemsService.getIssueDetail(projectId, identifier, ctx.service);
  return NextResponse.json(presentWorkItemLinkGroups(detail));
});

export const POST = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, linkBodySchema);
  const edge = await resolveEdge(ctx.params.key, body, ctx.service);

  await workItemsService.linkWorkItems(edge, ctx.service);

  return NextResponse.json({ toKey: body.toKey, relationship: body.relationship }, { status: 201 });
});

export const DELETE = withV1Route<{ key: string }>({ scope: 'work_items:write' }, async (ctx) => {
  // Addressed by ENDPOINTS, not by link id: no internal `linkId` appears on the
  // wire in either direction (ADR §7), so a client deletes the edge it can
  // NAME — the same pair it created.
  const params = new URL(ctx.req.url).searchParams;
  const parsed = linkBodySchema.safeParse({
    toKey: params.get('toKey') ?? undefined,
    relationship: params.get('relationship') ?? undefined,
  });
  if (!parsed.success) {
    throw new InvalidRequestError(
      'INVALID_BODY',
      'DELETE requires `toKey` and `relationship` query parameters.',
    );
  }
  const edge = await resolveEdge(ctx.params.key, parsed.data, ctx.service);

  // ⚠️ 204 WHETHER OR NOT an edge was there. `unlinkWorkItemsByEndpoints` is
  // idempotent and reports whether a row was actually removed; the correct HTTP
  // reading of an idempotent delete is that the post-condition ("this edge does
  // not exist") holds either way. It also means a retried teardown is safe.
  await workItemsService.unlinkWorkItemsByEndpoints(edge, ctx.service);

  return new NextResponse(null, { status: 204 });
});

/**
 * Resolve a `(path key, toKey, relationship)` triple to the DIRECTED storage
 * edge the service consumes.
 *
 * There are five user-facing relationships but only four storage kinds —
 * `blocked_by` and `blocks` are the two DIRECTIONS of one `is_blocked_by` edge —
 * and `relationshipToLink` is the shipped mapping, REUSED rather than re-derived
 * so the API and the web app write the same row for the same request.
 *
 * The two items may live in different projects of the same workspace (the link
 * model allows a cross-project edge); a target in ANOTHER workspace surfaces as
 * the service's own 404, because confirming that it exists is the existence
 * oracle ADR §4 forbids.
 */
async function resolveEdge(
  fromKey: string,
  body: { toKey: string; relationship: RelationshipKind },
  ctx: ServiceContext,
): Promise<{ fromId: string; toId: string; kind: WorkItemLinkKindDto }> {
  const from = await resolveWorkItemKey(fromKey, ctx);
  const fromItem = await workItemsService.getWorkItemByIdentifier(
    from.projectId,
    from.identifier,
    ctx,
  );
  const to = await resolveWorkItemKey(body.toKey, ctx);
  const toItem = await workItemsService.getWorkItemByIdentifier(to.projectId, to.identifier, ctx);

  return relationshipToLink(body.relationship, fromItem.id, toItem.id);
}
