import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueDetailDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { attachEdges, CHILD_EDGE_BLOCK_DESCRIPTION } from '../dependencyEdges';

// `get_work_item` (Story 7.8 · Subtask 7.8.4) — read ONE work item by its
// `PROD-<n>` identifier, returned as the issue-detail aggregate (the same
// `getIssueDetail` shape the detail page reads: the item + parent + children +
// dependency links + readiness verdict). One service call, no business logic —
// the 6.4 browse gate + the 404-not-403 cross-tenant contract live in the
// service unchanged.
//
// PLUS the per-CHILD dependency block (7.9.16b / MOTIR-1848). The aggregate's
// `children` are `WorkItemSummaryDto[]` and carry no edges, so a client could not
// order them without an N+1 fan-out; `motir show`'s build-order WAVE view needs
// exactly that sibling sub-graph. It rides ONE extra batched call (two queries,
// any child count) and is attached at the TRANSPORT, following 7.9.0f's precedent
// — `IssueDetailDto` stays as-is for the web detail page.

export const GET_WORK_ITEM_TOOL_NAME = 'get_work_item';

const inputSchema = {
  key: z.string().min(1).describe('The work item identifier, e.g. "PROD-7" (case-insensitive).'),
};

/** Derive the owning project key from a `PROD-7`-style identifier. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** Compact human-readable summary of an issue-detail aggregate. */
function summarize(detail: IssueDetailDto): string {
  const it = detail.item;
  const lines = [
    `${it.identifier} [${it.kind}${it.type ? `/${it.type}` : ''}] ${it.title}`,
    `Status: ${it.status} · Priority: ${it.priority} · Assignee: ${it.assigneeId ?? 'unassigned'}`,
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

/** The adapter: resolve the project from the key, read the detail aggregate. */
export async function runGetWorkItem(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
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
  const structured = { ...detail, children: attachEdges(detail.children, edges) };
  return toolOk(summarize(detail), structured as unknown as Record<string, unknown>);
}

export function registerGetWorkItem(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_WORK_ITEM_TOOL_NAME,
    {
      title: 'Get work item',
      description:
        'Read a single work item by its identifier (e.g. "PROD-7"): full detail including ' +
        'description, status, priority, assignee, parent/children, dependency links, and a ' +
        'readiness verdict. Honors the same access checks as the UI. ' +
        CHILD_EDGE_BLOCK_DESCRIPTION,
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
