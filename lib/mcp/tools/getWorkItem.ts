import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { commentsService } from '@/lib/services/commentsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectedWorkItem } from '@/lib/services/planProjectionService';
import type { ProjectedDetailDto, ProjectedRowDto } from '@/lib/services/planProjectionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueDetailDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { CHILD_EDGE_BLOCK_DESCRIPTION } from '../dependencyEdges';
import { derived } from '../payloads/define';
import { getWorkItemPayload, presentMcpWorkItemChild } from '../payloads/workItems';
import { TEMP_REF_HELP, normalizeProjectedTarget, planIdField } from './planRef';
import {
  attachCommentCounts,
  commentCountMarker,
  COMMENT_COUNT_DESCRIPTION,
  ITEM_ONLY_COMMENT_COUNT_NOTE,
} from '../commentCounts';

// `get_work_item` (Story 7.8 · Subtask 7.8.4) — read ONE work item by its
// `<KEY>-<n>` identifier, returned as the issue-detail aggregate (the same
// `getIssueDetail` shape the detail page reads: the item + parent + children +
// dependency links + readiness verdict). One service call, no business logic —
// the 6.4 browse gate + the 404-not-403 cross-tenant contract live in the
// service unchanged.
//
// `planId` (MOTIR-3096) answers over the PROJECTION instead — the project's live
// tree ⊕ that plan's proposals — so an agent can ask *"what does the tree look
// like WITH what I just proposed"* in one call, rather than merging `get_plan`
// against this read by hand on every turn. The target may then be a
// `planItem:<id>` temp-ref for a card the plan proposes, which has no key yet.
//
// ⚠️ THE PROJECTED ANSWER IS A DIFFERENT ENVELOPE, deliberately. It is not the
// committed aggregate with proposals slipped into it: `children` keeps holding
// only COMMITTED rows (the shape the payload seam derives from v1), the plan's
// own children ride `proposedChildren`, and every row carries `proposal` and a
// null `key` when it is one. A caller cannot mistake the two even by flattening
// the arrays — `docs/decisions/agent-authored-plans.md` AMENDMENT 3 Q7.
//
// PLUS the per-CHILD dependency block (7.9.16b / MOTIR-1848). The aggregate's
// `children` are `WorkItemSummaryDto[]` and carry no edges, so a client could not
// order them without an N+1 fan-out; `motir show`'s build-order WAVE view needs
// exactly that sibling sub-graph. It rides ONE extra batched call (two queries,
// any child count) and is attached at the TRANSPORT, following 7.9.0f's precedent
// — `IssueDetailDto` stays as-is for the web detail page.

export const GET_WORK_ITEM_TOOL_NAME = 'get_work_item';

const inputSchema = {
  key: z
    .string()
    .min(1)
    .describe(
      'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"), ' +
        'case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref ' +
        'naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
    ),
  planId: planIdField,
};

/** Derive the owning project key from an `ACME-7`-style identifier. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** Compact human-readable summary of an issue-detail aggregate. */
function summarize(detail: IssueDetailDto, commentCount: number): string {
  const it = detail.item;
  const lines = [
    `${it.identifier} [${it.kind}${it.type ? `/${it.type}` : ''}] ${it.title}`,
    `Status: ${it.status} · Priority: ${it.priority} · Assignee: ${it.assigneeId ?? 'unassigned'}` +
      commentCountMarker(commentCount),
  ];
  if (detail.parent) lines.push(`Parent: ${detail.parent.identifier} ${detail.parent.title}`);
  lines.push(
    detail.readiness.ready
      ? 'Readiness: ready'
      : `Readiness: blocked by ${detail.readiness.openBlockers
          .map((b) => b.identifier)
          .join(', ')}`,
  );
  if (it.descriptionMd) {
    lines.push('', it.descriptionMd);
  }
  return lines.join('\n');
}

/** One projected row as a compact line for the human-readable text block. The
 *  `proposal` / `key` split is the payload's job; this is what a person watching
 *  the session reads, so it says which kind of thing each row is in words. */
function projectedLine(row: ProjectedRowDto): string {
  const id = row.proposal ? `${row.tempRef} (PROPOSED)` : row.key;
  // `title` is always set — required on an `add`, and non-null on a stored row —
  // so it takes no fallback. `kind` genuinely may be absent: `proposedFields.kind`
  // is optional and materialize defaults it, so a proposal can legitimately not
  // have said one yet.
  return `  ${id} [${row.kind ?? '?'}] ${row.title} — ${row.status}`;
}

/** Compact human-readable summary of a PROJECTED detail. */
function summarizeProjected(detail: ProjectedDetailDto): string {
  const t = detail.target;
  const lines = [
    t.proposal
      ? `${t.tempRef} [${t.kind ?? '?'}] ${t.title} — a PROPOSAL in plan ${detail.planId}, not a work item. It has no key until the plan is approved in Motir.`
      : `${t.key} [${t.kind ?? '?'}] ${t.title} — as it would stand once plan ${detail.planId} materializes.`,
  ];
  if (t.pendingPatch) {
    lines.push(`This plan MODIFIES it: ${JSON.stringify(t.pendingPatch)}`);
  }
  if (t.status === 'removed_by_plan') {
    lines.push('⚠️ This plan REMOVES this card — it is gone from the projection.');
  }
  if (detail.parent) lines.push(`Parent:${projectedLine(detail.parent).slice(1)}`);
  if (detail.committedChildren.length > 0) {
    lines.push('Children (committed):', ...detail.committedChildren.map(projectedLine));
  }
  if (detail.proposedChildren.length > 0) {
    lines.push('Children this plan PROPOSES:', ...detail.proposedChildren.map(projectedLine));
  }
  if (detail.blockedBy.length > 0) {
    lines.push('Blocked by (projected):', ...detail.blockedBy.map(projectedLine));
  }
  lines.push(
    'Nothing was created: approving the plan in Motir is the only path from a proposal to a work item.',
  );
  return lines.join('\n');
}

/** The adapter: resolve the project from the key, read the detail aggregate. */
export async function runGetWorkItem(
  args: { key: string; planId?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  if (args.planId !== undefined) {
    // PROJECTED. No project lookup: `buildProjection` resolves the project FROM
    // the plan and asserts browse on it, and a `planItem:<id>` target has no
    // project-key prefix to derive one from anyway.
    const projected = await projectedWorkItem(args.planId, normalizeProjectedTarget(args.key), ctx);
    // ⚠️ The whole projected answer rides ONE clearly-named key, and `children`
    // — the committed aggregate's array, which the payload seam derives from the
    // shared v1 child schema — is EMPTY. That is not a gap: a keyless proposal
    // cannot satisfy that schema, and quietly widening it would put rows with no
    // key in the array every existing consumer reads committed children from.
    // A caller branches on `projection` being present, exactly as it does on
    // `search_work_items`.
    return toolOk(
      summarizeProjected(projected),
      derived(getWorkItemPayload, {
        children: [],
        projection: projected,
      }),
    );
  }
  const identifier = args.key.trim().toUpperCase();
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  const detail = await workItemsService.getIssueDetail(project.id, identifier, ctx);
  // The children's dependency edges in TWO batched queries (MOTIR-1842's reader),
  // never one read per child — a 43-child story must stay a single round-trip.
  // `getIssueDetail` has already run the browse gate on the whole aggregate, so
  // the ids handed over are ones the caller may see.
  const edges = await workItemsService.getDependencyEdgesForItems(
    detail.children.map((c) => c.id),
    ctx,
  );
  // The DISCUSSION signal (MOTIR-2001), on the ITEM only — one extra query,
  // whatever the aggregate holds. The children deliberately do NOT carry it: a
  // child badge would tempt a client to render the whole subtree's discussion
  // state from a read whose job is this ONE card, and the list reads already
  // answer that question per row.
  const counts = await commentsService.getCommentCountsForItems([detail.item.id], ctx);
  const item = attachCommentCounts([detail.item], counts)[0]!;
  // Every row this read already resolved, so a child's `parentId` can be named
  // by its KEY — the same map `presentWorkItemDetail` builds, for the same
  // field. Built once and shared by every child.
  const keyById = new Map<string, string>([[detail.item.id, detail.item.identifier]]);
  for (const row of [...detail.ancestors, ...detail.children]) {
    keyById.set(row.id, row.identifier);
  }
  if (detail.parent) keyById.set(detail.parent.id, detail.parent.identifier);
  // The CHILD rows now DERIVE from v1's `workItemChildSchema` (MOTIR-2228) —
  // the sub-graph the founding defect lived in. The rest of the aggregate is the
  // envelope, which stays MCP's own (ADR Amendment 7 Q6).
  // The DELIVERY SET (Story MOTIR-3655 · MOTIR-3697) — every pull request that
  // delivers this card, with its CI verdict. An agent that has just opened a pull
  // request and called `link_pull_request` reads back HERE whether the card is
  // delivered by one branch or several, and whether the others are green. Empty
  // is the ordinary answer and means nothing is recorded, never that nothing has
  // landed. It rides the `catchall`-open envelope, so no payload schema widens.
  const deliveries = await workItemsService.listDeliverySet(detail.item.id, ctx);
  const structured = {
    ...detail,
    item,
    children: detail.children.map((child) =>
      presentMcpWorkItemChild(child, edges[child.id], (id) => keyById.get(id)),
    ),
    deliveries,
  };
  return toolOk(summarize(detail, item.commentCount), derived(getWorkItemPayload, structured));
}

export function registerGetWorkItem(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_WORK_ITEM_TOOL_NAME,
    {
      title: 'Get work item',
      description:
        'Read a single work item by its identifier (e.g. "ACME-7"): full detail including ' +
        'description, status, priority, assignee, parent/children, dependency links, and a ' +
        'readiness verdict. Honors the same access checks as the UI. ' +
        CHILD_EDGE_BLOCK_DESCRIPTION +
        ' ' +
        COMMENT_COUNT_DESCRIPTION +
        ' ' +
        ITEM_ONLY_COMMENT_COUNT_NOTE +
        ' Pass `planId` to read the card as it would stand once that plan materializes — the ' +
        'live tree ⊕ the plan’s proposals, so you can see what you proposed without merging ' +
        '`get_plan` against this call yourself. ' +
        TEMP_REF_HELP +
        ' The projected answer rides a `projection` key — `{ planId, target, parent, ' +
        'committedChildren, proposedChildren, blockedBy }` — and the ordinary `children` array ' +
        'is EMPTY, because a proposal has no key and cannot sit in the array committed children ' +
        'use. Every projected row carries `proposal` and a null `key` when it is one; no key is ' +
        'ever invented for a proposal. Read-only: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetWorkItem(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
