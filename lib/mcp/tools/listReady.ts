import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { commentsService } from '@/lib/services/commentsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyLane, ReadyListFilter } from '@/lib/workItems/readyFilter';
import type { ReadyContainerDto, ReadyItemDto } from '@/lib/dto/ready';
import type { WorkItemDependencyEdgesDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import {
  listReadyPayload,
  presentMcpReadyContainer,
  presentMcpReadyRow,
} from '../payloads/workItems';
import { edgeMarker, EDGE_BLOCK_DESCRIPTION } from '../dependencyEdges';
import { commentCountMarker, COMMENT_COUNT_DESCRIPTION } from '../commentCounts';
import {
  assigneeIdField,
  kindsField,
  laneField,
  normalizeAssigneeId,
  priorityField,
  projectKeyField,
} from './readyFilters';

// `list_ready` (Story 7.8 · Subtask 7.8.4) — BROWSE the ready set: a
// cursor-paginated page of ready-to-start work in a project. Since MOTIR-6833 it
// reads one ready LANE — `leaf` (default), `container` or `bug` — through the
// same service lanes `/ready` and the `/api/v1/…/ready/*` operations read, so the
// page and the agent never disagree on what is ready or what comes first.
// Paginated from day one — there is no load-everything path.

export const LIST_READY_TOOL_NAME = 'list_ready';

const inputSchema = {
  projectKey: projectKeyField,
  lane: laneField,
  kinds: kindsField,
  priority: priorityField,
  assigneeId: assigneeIdField,
  cursor: z.string().optional().describe('Opaque page cursor from a previous call’s nextCursor.'),
  limit: z.number().int().positive().max(200).optional().describe('Page size (1–200, default 50).'),
};

interface ListReadyArgs {
  projectKey: string;
  lane?: ReadyLane;
  kinds?: WorkItemKind[];
  priority?: WorkItemPriority[];
  assigneeId?: string | null;
  cursor?: string;
  limit?: number;
}

/** One ready row as a compact line, with its dependency edges and comment count appended. */
function line(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
  commentCount: number | undefined,
): string {
  const who = item.assignee ? item.assignee.name : 'unassigned';
  const under = item.container ? ` (in ${item.container.key})` : '';
  return `${item.key} [${item.kind}/${item.priority}] ${item.title}${under} — ${who}${edgeMarker(edges)}${commentCountMarker(commentCount)}`;
}

/** One runnable container as a compact line. */
function containerLine(row: ReadyContainerDto): string {
  const who = row.assignee ? row.assignee.name : 'unassigned';
  return `${row.key} [${row.kind}/${row.priority}] ${row.title} — ${row.readyLeafCount} of ${row.childCount} ready — ${who} — run: motir run ${row.key}`;
}

/** The containers lane — its facets apply to the container; `kinds` does not. */
async function runListReadyContainers(
  args: ListReadyArgs,
  projectId: string,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const page = await workItemsService.listReadyContainers(
    projectId,
    {
      priority: args.priority,
      assigneeId: normalizeAssigneeId(args.assigneeId),
      cursor: args.cursor,
      limit: args.limit,
    },
    ctx,
  );
  const header =
    page.items.length === 0
      ? 'No ready work in the container lane.'
      : `${page.items.length} runnable container${page.items.length === 1 ? '' : 's'}:`;
  const body = page.items.map(containerLine).join('\n');
  const footer = page.nextCursor ? `\n\nMore available — pass cursor: ${page.nextCursor}` : '';
  return toolOk(
    `${header}${body ? '\n' + body : ''}${footer}`,
    derived(listReadyPayload, {
      lane: 'container',
      items: page.items.map(presentMcpReadyContainer),
      nextCursor: page.nextCursor,
    }),
  );
}

export async function runListReady(
  args: ListReadyArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const filter: ReadyListFilter = {
    kinds: args.kinds,
    priority: args.priority,
    assigneeId: normalizeAssigneeId(args.assigneeId),
    cursor: args.cursor,
    limit: args.limit,
  };
  const lane = args.lane ?? 'leaf';
  const project = await projectsService.getByKey(args.projectKey, ctx);
  if (lane === 'container') return runListReadyContainers(args, project.id, ctx);
  const read = lane === 'bug' ? workItemsService.listReadyBugs : workItemsService.listReadyLeaves;
  const page = await read(project.id, filter, ctx);
  // The page's dependency edges in TWO batched queries (MOTIR-1842) — never one
  // read per row. A ready item's `blockedBy` is terminal by definition (that is
  // what makes it ready); its `blocks` is the list's real payload — what this
  // item unblocks, i.e. why it is worth doing first.
  // The page's DISCUSSION signal (MOTIR-2001) in ONE more query, whatever the
  // page size — the same batched-projection bar the edge block clears. A ready
  // row with a live argument on it is a row an agent should read before starting.
  const [edges, commentCounts] = await Promise.all([
    workItemsService.getDependencyEdgesForItems(
      page.items.map((i) => i.id),
      ctx,
    ),
    commentsService.getCommentCountsForItems(
      page.items.map((i) => i.id),
      ctx,
    ),
  ]);

  const header =
    page.items.length === 0
      ? `No ready work in the ${lane} lane.`
      : `${page.items.length} ready item${page.items.length === 1 ? '' : 's'} in the ${lane} lane:`;
  const body = page.items
    .map((item) => line(item, edges[item.id], commentCounts[item.id]))
    .join('\n');
  const footer = page.nextCursor ? `\n\nMore available — pass cursor: ${page.nextCursor}` : '';
  return toolOk(
    `${header}${body ? '\n' + body : ''}${footer}`,
    derived(listReadyPayload, {
      lane,
      items: page.items.map((item) =>
        presentMcpReadyRow(item, edges[item.id], commentCounts[item.id] ?? 0),
      ),
      nextCursor: page.nextCursor,
    }),
  );
}

export function registerListReady(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_READY_TOOL_NAME,
    {
      title: 'List ready work items',
      description:
        'List ready-to-start work in a project (every dependency satisfied), as a ' +
        'cursor-paginated page of ONE ready lane: "leaf" (default — ready leaves minus bug work, ' +
        'each naming its runnable container), "container" (runnable containers — what a parent ' +
        'run takes) or "bug" (ready bugs and bug subtasks). Rows come grouped by container, a ' +
        'group ranked by its best member; the lanes are the same ones the project’s Ready view ' +
        'shows. Optional filters: kinds (leaf/bug lanes), priority, assigneeId. ' +
        EDGE_BLOCK_DESCRIPTION +
        ' ' +
        COMMENT_COUNT_DESCRIPTION,
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runListReady(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
