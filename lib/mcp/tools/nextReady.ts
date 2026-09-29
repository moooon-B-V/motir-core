import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { commentsService } from '@/lib/services/commentsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyLane, ReadyListFilter } from '@/lib/workItems/readyFilter';
import type { ReadyContainerDto, ReadyItemDispatchDto } from '@/lib/dto/ready';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import {
  nextReadyPayload,
  presentMcpReadyContainer,
  presentMcpReadyDispatch,
} from '../payloads/workItems';
import {
  attachCommentCounts,
  commentCountMarker,
  COMMENT_COUNT_DESCRIPTION,
} from '../commentCounts';
import {
  assigneeIdField,
  kindsField,
  laneField,
  normalizeAssigneeId,
  priorityField,
  projectKeyField,
} from './readyFilters';

// `next_ready` (Story 7.8 · Subtask 7.8.4) — DISPATCH one item: the first ready
// work item under the deterministic ready ordering that is NOT in `excludeIds`,
// returned as the full dispatch payload (`ReadyItemDispatchDto`: the Markdown
// body + context refs + resolved blocker keys + the run command). Since
// MOTIR-6833 it reads one ready LANE: `leaf` (default — never a bug) and `bug`
// through `workItemsService.getNextReadyInLane`, `container` through
// `getNextReadyContainer`. The agent loop appends each dispatched id to
// `excludeIds` to walk the lane.

export const NEXT_READY_TOOL_NAME = 'next_ready';

const inputSchema = {
  projectKey: projectKeyField,
  lane: laneField,
  kinds: kindsField,
  priority: priorityField,
  assigneeId: assigneeIdField,
  excludeIds: z
    .array(z.string())
    .optional()
    .describe('Work item ids already dispatched this loop — skip them.'),
};

interface NextReadyArgs {
  projectKey: string;
  lane?: ReadyLane;
  kinds?: WorkItemKind[];
  priority?: WorkItemPriority[];
  assigneeId?: string | null;
  excludeIds?: string[];
}

/** Compact summary of the dispatched item. */
function summarize(item: ReadyItemDispatchDto, commentCount: number): string {
  const lines = [
    `Next: ${item.key} [${item.kind}/${item.priority}] ${item.title}${commentCountMarker(commentCount)}`,
    `Run: ${item.runCommand}`,
  ];
  if (item.parentKey) lines.push(`Parent: ${item.parentKey}`);
  if (item.container) lines.push(`In: ${item.container.key} (${item.container.kind})`);
  if (item.contextRefs.length > 0) lines.push(`Context refs: ${item.contextRefs.join(', ')}`);
  if (item.descriptionMd) {
    const excerpt = item.descriptionMd.slice(0, 800);
    lines.push('', excerpt + (item.descriptionMd.length > 800 ? '…' : ''));
  }
  return lines.join('\n');
}

/** Compact summary of the next runnable container. */
function summarizeContainer(row: ReadyContainerDto): string {
  return [
    `Next container: ${row.key} [${row.kind}/${row.priority}] ${row.title}`,
    `${row.readyLeafCount} of ${row.childCount} children ready`,
    `Run: motir run ${row.key}`,
  ].join('\n');
}

export async function runNextReady(
  args: NextReadyArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const filter: Omit<ReadyListFilter, 'limit' | 'cursor'> & { excludeIds?: string[] } = {
    kinds: args.kinds,
    priority: args.priority,
    assigneeId: normalizeAssigneeId(args.assigneeId),
    excludeIds: args.excludeIds,
  };
  const lane = args.lane ?? 'leaf';
  const project = await projectsService.getByKey(args.projectKey, ctx);
  if (lane === 'container') {
    const container = await workItemsService.getNextReadyContainer(
      project.id,
      {
        priority: args.priority,
        assigneeId: normalizeAssigneeId(args.assigneeId),
        excludeIds: args.excludeIds,
      },
      ctx,
    );
    return toolOk(
      container ? summarizeContainer(container) : 'No ready work in the container lane.',
      derived(nextReadyPayload, {
        lane,
        item: null,
        container: container ? presentMcpReadyContainer(container) : null,
      }),
    );
  }
  const dispatch = await workItemsService.getNextReadyInLane(project.id, lane, filter, ctx);

  if (!dispatch) {
    return toolOk(
      `No ready work in the ${lane} lane.`,
      derived(nextReadyPayload, { lane, item: null, container: null }),
    );
  }
  // The DISCUSSION signal on the dispatch payload (MOTIR-2001). This is the read
  // an agent picks a card UP with, so it is the one place the count changes what
  // happens next: a non-zero count means read `get_work_item_activity` before
  // starting, because the card's prose is not the whole brief.
  const counts = await commentsService.getCommentCountsForItems([dispatch.id], ctx);
  const item = attachCommentCounts([dispatch], counts)[0]!;
  return toolOk(
    summarize(dispatch, item.commentCount),
    derived(nextReadyPayload, {
      lane,
      item: presentMcpReadyDispatch(dispatch, item.commentCount),
      container: null,
    }),
  );
}

export function registerNextReady(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    NEXT_READY_TOOL_NAME,
    {
      title: 'Next ready work item',
      description:
        'Return the NEXT item of one ready lane not in excludeIds: lane "leaf" (default — never ' +
        'a bug) or "bug" as a full dispatch payload (description, context refs, blocker keys, ' +
        'run command, its container), or lane "container" as the next runnable container with ' +
        'its ready-leaf count and parent-run command. Empty when that lane is exhausted. Pass ' +
        'already-handled ids in excludeIds to walk the lane. ' +
        COMMENT_COUNT_DESCRIPTION,
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runNextReady(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
