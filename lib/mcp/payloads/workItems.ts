import { z } from 'zod/v4';
import {
  dependencyEdgesSchema,
  workItemChildSchema,
  workItemKeySchema,
} from '@/lib/api/v1/workItems/schema';
import type { WorkItemDependencyEdgesDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import { definePayload } from './define';

// The WORK-ITEM payload shapes (Story 11.6 · Subtask 11.6.2 — MOTIR-2228).
//
// `get_work_item` is the proving tool, and it is the right one: it is the tool at
// the centre of the founding defect (MOTIR-1849) — the one that LACKED the
// `dependencies` block its two siblings carried, invisibly, until a card had been
// planned on the assumption all three agreed.
//
// ── What derives, and what does not ─────────────────────────────────────────
// Per ADR Amendment 7 Q6 the ENVELOPE stays MCP's own: `get_work_item` returns
// the `IssueDetailDto` aggregate (`{ item, ancestors, parent, children, blockedBy,
// …, readiness, workflow, watcherCount, … }`) because that is the shape an agent
// reads a card from, and v1's flat `workItemDetailSchema` is shaped for a
// different caller. What derives is the aggregate's RESOURCE-VALUED parts — here
// the CHILD rows, which are exactly where the founding defect lived and exactly
// what `packages/cli/src/render.ts`'s `assignChildWaves` reads.

/**
 * A CHILD of the detail aggregate: v1's {@link workItemChildSchema} WIDENED with
 * the fields the MCP aggregate has always carried.
 *
 * A `.extend` rather than a look-alike, so a change to the v1 base breaks this
 * loudly instead of leaving two shapes that quietly mean different things — the
 * distinction ADR Amendment 7 Q6 turns on, and the one that is invisible in a
 * diff.
 *
 * ⚠️ **`key` changes meaning here, and it is the ONE non-additive change in
 * Story 11.6** (ADR Amendment 7 Q6 addendum). It was the NUMERIC key on this row
 * and the `PROD-<n>` identifier on `/api/v1` — and on MCP's own `list_ready`
 * rows. It is now the identifier everywhere, and the numeric key is preserved as
 * `numericKey`, so nothing is lost. `@motir/cli` never read the numeric one
 * (`grep -rn "key: number" packages/cli/src/` → no matches; its `WorkItemSummary`
 * declares `identifier`, `kind`, `title`, `status` and no `key` at all).
 */
export const mcpWorkItemChildSchema = workItemChildSchema.extend({
  /** The internal row id — what `excludeIds` and the edge reader are keyed by. */
  id: z.string(),
  /** The numeric key. Was `key` before MOTIR-2228; renamed, never dropped. */
  numericKey: z.number().int(),
  /** The `PROD-<n>` identifier. Retained beside v1's `key`, which now holds the
   *  same value — every existing reader of `identifier` keeps working. */
  identifier: workItemKeySchema,
  /** The parent's internal id (v1 publishes `parentKey` instead; both ride). */
  parentId: z.string().nullable(),
  /** The fractional rank, which v1 does not publish. */
  position: z.string(),
  /** The archive timestamp; v1 narrows this to the boolean `archived`. */
  archivedAt: z.string().nullable(),
});
export type McpWorkItemChild = z.infer<typeof mcpWorkItemChildSchema>;

/**
 * The `get_work_item` payload.
 *
 * The envelope is `catchall`-open on purpose: the aggregate carries `workflow`,
 * `labels`, `components`, `customFields`, `watcherCount`, `viewerIsWatching` and
 * the four other link groups, none of which v1 describes and none of which this
 * story is re-shaping. Declaring them here would fork a second description of
 * `IssueDetailDto` — the very thing being removed — so the schema pins the parts
 * that DERIVE and passes the rest through untouched.
 */
export const getWorkItemPayload = definePayload({
  schema: z
    .object({ children: z.array(mcpWorkItemChildSchema) })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { children: McpWorkItemChild[] } & Record<string, unknown>
  >,
  probes: [
    // The child rows, against v1's `WorkItemRef`. This is the comparison whose
    // absence started the story.
    { resource: 'WorkItemRef', select: (p) => p.children },
  ],
});

/**
 * Map one aggregate child + its edges to the MCP child row.
 *
 * Field by field, never a spread — the same discipline the v1 mappers use, and
 * for the same reason: a spread makes every future column of the DTO part of the
 * payload by accident.
 */
export function presentMcpWorkItemChild(
  child: WorkItemSummaryDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  keyOfId: (id: string) => string | undefined,
): McpWorkItemChild {
  return {
    // v1's `workItemChildSchema` half
    key: child.identifier,
    kind: child.kind,
    title: child.title,
    status: child.status,
    priority: child.priority,
    assigneeId: child.assigneeId,
    estimateMinutes: child.estimateMinutes,
    storyPoints: child.storyPoints,
    parentKey: child.parentId === null ? null : (keyOfId(child.parentId) ?? null),
    archived: child.archivedAt !== null,
    // TOTAL by construction, exactly as `lib/mcp/dependencyEdges.ts` promises:
    // a child the reader returned nothing for still gets two EMPTY arrays.
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    // the MCP widening
    id: child.id,
    numericKey: child.key,
    identifier: child.identifier,
    parentId: child.parentId,
    position: child.position,
    archivedAt: child.archivedAt,
  };
}

/** The edge block's own schema, re-exported so a family card can compose it
 *  without reaching across the seam into the v1 module. */
export { dependencyEdgesSchema };
