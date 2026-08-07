import { z } from 'zod/v4';
import {
  commentSchema,
  dependencyEdgesSchema,
  presentComment,
  workItemChildSchema,
  workItemKeySchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';
import { readyItemSchema } from '@/lib/api/v1/ready/schema';
import type {
  WorkItemDependencyEdgesDto,
  WorkItemDto,
  WorkItemListItemDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { ReadyItemDispatchDto, ReadyItemDto } from '@/lib/dto/ready';
import type { CommentDTO } from '@/lib/dto/comments';
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

// ─────────────────────────────────────────────────────────────────────────────
// The WORK-ITEM family (Story 11.6 · Subtask 11.6.3 — MOTIR-2229)
// ─────────────────────────────────────────────────────────────────────────────
//
// Three shapes cover fifteen tools, each a DECLARED derivation of a v1 schema:
//
//   mcpWorkItemSchema  every WRITE that returns the item it touched — a
//                      NARROWING (`.omit({ dependencies })`, since a write does
//                      not read the graph) widened with the aggregate columns.
//   mcpWorkItemRowSchema  the SEARCH row — a narrowing of the collection row
//                      (`.omit({ createdAt })`, which the MCP list projection
//                      does not read) plus the transport attachments.
//   mcpReadyRowSchema  the READY row and its dispatch superset.
//
// ⚠️ The narrowings are the subtle half. A `.omit` off the shared schema breaks
// LOUDLY when the base changes; a hand-built object that resembles the schema
// goes on compiling and quietly means something else. Those two look identical
// in a diff and are opposite in kind — which is the whole subject of this story.
//
// ⚠️ On the enum-valued MCP-ONLY extras (`executor`, `planningSource`, …) the
// schemas below are permissive strings. That is deliberate, not laziness: the
// SHARED half carries v1's exact enums through the base schema, and it is the
// only half with a second consumer. A runtime enum check on a field no other
// surface reads buys nothing the TypeScript type does not already give, and a
// second copy of a vocabulary is what this story exists to remove.

/** The columns every write-returning tool's `WorkItemDto` adds on top of the
 *  shared collection row. Declared once — fourteen tools return this shape. */
const workItemDtoExtras = {
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  /** The numeric key. Was `key` before MOTIR-2228; renamed, never dropped. */
  numericKey: z.number().int(),
  identifier: workItemKeySchema,
  descriptionMd: z.string().nullable(),
  explanationMd: z.string().nullable(),
  explanationSource: z.string(),
  executor: z.string().nullable(),
  position: z.string(),
  sprintId: z.string().nullable(),
  backlogRank: z.string().nullable(),
  publicChildrenHidden: z.boolean(),
  sessionBranch: z.string().nullable(),
  targetRepo: z.string().nullable(),
  planningSource: z.string().nullable(),
  planningHarness: z.string().nullable(),
  planningModel: z.string().nullable(),
  implementationSource: z.string().nullable(),
  implementationHarness: z.string().nullable(),
  implementationModel: z.string().nullable(),
  archivedAt: z.string().nullable(),
};

/**
 * A whole work item, as every WRITE tool returns it.
 *
 * `.omit({ dependencies })` is the declared NARROWING: a write reports the row
 * it changed and does not read the dependency graph, so shipping two empty
 * arrays would be a claim the tool never checked.
 */
export const mcpWorkItemSchema = workItemSummarySchema
  .omit({ dependencies: true })
  .extend(workItemDtoExtras);
export type McpWorkItem = z.infer<typeof mcpWorkItemSchema>;

/** Map a `WorkItemDto` to the write-confirmation shape — field by field. */
export function presentMcpWorkItem(dto: WorkItemDto): McpWorkItem {
  return {
    // the shared half
    key: dto.identifier,
    kind: dto.kind,
    type: dto.type,
    title: dto.title,
    status: dto.status,
    priority: dto.priority,
    assigneeId: dto.assigneeId,
    reporterId: dto.reporterId,
    dueDate: dto.dueDate,
    estimateMinutes: dto.estimateMinutes,
    storyPoints: dto.storyPoints,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    // the MCP widening
    id: dto.id,
    projectId: dto.projectId,
    parentId: dto.parentId,
    numericKey: dto.key,
    identifier: dto.identifier,
    descriptionMd: dto.descriptionMd,
    explanationMd: dto.explanationMd,
    explanationSource: dto.explanationSource,
    executor: dto.executor,
    position: dto.position,
    sprintId: dto.sprintId,
    backlogRank: dto.backlogRank,
    publicChildrenHidden: dto.publicChildrenHidden,
    sessionBranch: dto.sessionBranch,
    targetRepo: dto.targetRepo,
    planningSource: dto.planningSource,
    planningHarness: dto.planningHarness,
    planningModel: dto.planningModel,
    implementationSource: dto.implementationSource,
    implementationHarness: dto.implementationHarness,
    implementationModel: dto.implementationModel,
    archivedAt: dto.archivedAt,
  };
}

/** The bare write-confirmation payload — fourteen tools share it. */
export const workItemWritePayload = definePayload({
  schema: mcpWorkItemSchema as unknown as z.ZodType<McpWorkItem & Record<string, unknown>>,
  // No probe: this is a NARROWING (no `dependencies`), so it cannot satisfy
  // `WorkItemSummary` and must not claim to. The derivation is proven at the
  // TYPE level instead — `.omit` off the base breaks when the base does.
  probes: [],
});

/**
 * A SEARCH row.
 *
 * `.omit({ createdAt })` is the declared narrowing: the flat List projection
 * `search_work_items` reads does not carry it (v1's collection route sources it
 * from the keyset read's cursor position, which this tool has no equivalent of).
 * Everything else is the shared row, `dependencies` included — the block whose
 * absence on `get_work_item` started this story.
 */
export const mcpWorkItemRowSchema = workItemSummarySchema.omit({ createdAt: true }).extend({
  id: z.string(),
  numericKey: z.number().int(),
  identifier: workItemKeySchema,
  hasDescription: z.boolean(),
  commentCount: z.number().int(),
});
export type McpWorkItemRow = z.infer<typeof mcpWorkItemRowSchema>;

/** Map one list row + its transport attachments to the search row. */
export function presentMcpWorkItemRow(
  item: WorkItemListItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpWorkItemRow {
  return {
    key: item.identifier,
    kind: item.kind,
    type: item.type,
    title: item.title,
    status: item.status,
    priority: item.priority,
    assigneeId: item.assigneeId,
    reporterId: item.reporterId,
    dueDate: item.dueDate,
    estimateMinutes: item.estimateMinutes,
    storyPoints: item.storyPoints,
    updatedAt: item.updatedAt,
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    id: item.id,
    numericKey: item.key,
    identifier: item.identifier,
    hasDescription: item.hasDescription,
    commentCount,
  };
}

/** The `search_work_items` page. */
export const searchWorkItemsPayload = definePayload({
  schema: z
    .object({
      items: z.array(mcpWorkItemRowSchema),
      total: z.number().int(),
      nextCursor: z.string().nullable(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { items: McpWorkItemRow[]; total: number; nextCursor: string | null } & Record<string, unknown>
  >,
  // No probe for the same reason as the write shape: the row is a narrowing
  // (no `createdAt`). Its `dependencies` block still comes from the shared
  // schema, which is the property this card was written for.
  probes: [],
});

/**
 * A READY row.
 *
 * A pure WIDENING — every field `readyItemSchema` declares is present with the
 * same value, so a ready row VALIDATES against the v1 schema and the drift guard
 * has something real to compare. `assigneeId` is the one field the MCP row did
 * not carry (it had the fuller `assignee` object); it arrives ALONGSIDE, never
 * instead of, so nothing a caller reads today moves.
 */
export const mcpReadyRowSchema = readyItemSchema.extend({
  id: z.string(),
  assignee: z
    .object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() })
    .nullable(),
  descriptionMd: z.string().nullable(),
  commentCount: z.number().int(),
});
export type McpReadyRow = z.infer<typeof mcpReadyRowSchema>;

/** The dispatch superset `next_ready` / `claim_next_ready` return. */
export const mcpReadyDispatchSchema = mcpReadyRowSchema.extend({
  contextRefs: z.array(z.string()),
  blockerKeys: z.array(z.string()),
  parentKey: z.string().nullable(),
  runCommand: z.string(),
  sessionBranch: z.string().nullable(),
  targetRepo: z.string().nullable(),
  targetRepoCloneUrl: z.string().nullable(),
  targetRepoDefaultBranch: z.string().nullable(),
});
export type McpReadyDispatch = z.infer<typeof mcpReadyDispatchSchema>;

/** The shared half of a ready row — reused by the dispatch mapper below. */
function readyRowFields(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpReadyRow {
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    priority: item.priority,
    status: { key: item.status.key, category: item.status.category },
    type: item.type,
    executor: item.executor,
    // The v1 field, derived from the object MCP already carried. Additive.
    assigneeId: item.assignee?.id ?? null,
    descriptionExcerpt: item.descriptionExcerpt,
    // Amendment 15's readiness qualifier, arriving here because this payload
    // DERIVES from the v1 row (Amendment 7). The dispatch superset below still
    // carries `sessionBranch` — the same value addressed as an instruction —
    // and the two coexist for the reason the ready schema records: one is a fact
    // about the item's dependencies, the other is what to do about it.
    inheritedSessionBranch: item.inheritedSessionBranch,
    dependencies: edges ?? { blockedBy: [], blocks: [] },
    id: item.id,
    assignee: item.assignee,
    descriptionMd: item.descriptionMd,
    commentCount,
  };
}

/** Map one ready row + its transport attachments. */
export function presentMcpReadyRow(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number,
): McpReadyRow {
  return readyRowFields(item, edges, commentCount);
}

/** Map one DISPATCH row — the ready row plus what a runner needs to start. */
export function presentMcpReadyDispatch(
  item: ReadyItemDispatchDto,
  commentCount: number,
): McpReadyDispatch {
  return {
    ...readyRowFields(item, undefined, commentCount),
    contextRefs: item.contextRefs,
    blockerKeys: item.blockerKeys,
    parentKey: item.parentKey,
    runCommand: item.runCommand,
    sessionBranch: item.sessionBranch,
    targetRepo: item.targetRepo,
    targetRepoCloneUrl: item.targetRepoCloneUrl,
    targetRepoDefaultBranch: item.targetRepoDefaultBranch,
  };
}

/** The `list_ready` page. Its rows are a WIDENING, so they carry a real probe. */
export const listReadyPayload = definePayload({
  schema: z
    .object({ items: z.array(mcpReadyRowSchema), nextCursor: z.string().nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { items: McpReadyRow[]; nextCursor: string | null } & Record<string, unknown>
  >,
  probes: [{ resource: 'ReadyItem', select: (p) => p.items }],
});

/** The `next_ready` dispatch peek — `item` is null when nothing is ready. */
export const nextReadyPayload = definePayload({
  schema: z
    .object({ item: mcpReadyDispatchSchema.nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { item: McpReadyDispatch | null } & Record<string, unknown>
  >,
  probes: [{ resource: 'ReadyItem', select: (p) => (p.item ? [p.item] : []) }],
});

/** The `claim_next_ready` result — the same item plus the advisories block. */
export const claimNextReadyPayload = definePayload({
  schema: z
    .object({ item: mcpReadyDispatchSchema.nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { item: McpReadyDispatch | null } & Record<string, unknown>
  >,
  probes: [{ resource: 'ReadyItem', select: (p) => (p.item ? [p.item] : []) }],
});

/**
 * A COMMENT, as `add_comment` returns it — a pure WIDENING of v1's comment
 * shape, so the row validates against it unchanged.
 *
 * `authorId` is the field the MCP payload did not carry (it had the richer
 * `author` object, which the web app renders). It arrives ALONGSIDE, never
 * instead of — the additive rule of ADR Amendment 7 Q6.
 */
export const mcpCommentSchema = commentSchema.extend({
  workItemId: z.string(),
  author: z.object({ id: z.string(), name: z.string(), image: z.string().nullable() }),
});
export type McpComment = z.infer<typeof mcpCommentSchema>;

/** Map one `CommentDTO` — the shared half through v1's own presenter. */
export function presentMcpComment(dto: CommentDTO): McpComment {
  return {
    ...presentComment(dto),
    workItemId: dto.workItemId,
    author: dto.author,
  };
}

/** The `add_comment` confirmation. */
export const addCommentPayload = definePayload({
  schema: mcpCommentSchema as unknown as z.ZodType<McpComment & Record<string, unknown>>,
  // No probe: `CommentThread` is the registered component and requires
  // `replies`, which a just-created comment has none of. The derivation is the
  // `.extend` off `commentSchema` plus `presentComment` — v1's own mapper.
  probes: [],
});
