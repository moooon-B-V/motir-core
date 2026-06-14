import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemKind, WorkItemPriority } from '@prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyListFilter } from '@/lib/workItems/readyFilter';
import type { ReadyItemDispatchDto } from '@/lib/dto/ready';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  assigneeIdField,
  kindsField,
  normalizeAssigneeId,
  priorityField,
  projectKeyField,
} from './readyFilters';

// `next_ready` (Story 7.8 · Subtask 7.8.4) — DISPATCH one item: the first ready
// work item under the deterministic ready ordering that is NOT in `excludeIds`,
// returned as the full dispatch payload (`ReadyItemDispatchDto`: the Markdown
// body + context refs + resolved blocker keys + the run command). Wraps
// `workItemsService.getNextReady` 1:1 (the `POST /api/ready/next` contract). The
// agent loop appends each dispatched key to `excludeIds` to walk the set.

export const NEXT_READY_TOOL_NAME = 'next_ready';

const inputSchema = {
  projectKey: projectKeyField,
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
  kinds?: WorkItemKind[];
  priority?: WorkItemPriority[];
  assigneeId?: string | null;
  excludeIds?: string[];
}

/** Compact summary of the dispatched item. */
function summarize(item: ReadyItemDispatchDto): string {
  const lines = [
    `Next: ${item.key} [${item.kind}/${item.priority}] ${item.title}`,
    `Run: ${item.runCommand}`,
  ];
  if (item.parentKey) lines.push(`Parent: ${item.parentKey}`);
  if (item.contextRefs.length > 0) lines.push(`Context refs: ${item.contextRefs.join(', ')}`);
  if (item.descriptionMd) {
    const excerpt = item.descriptionMd.slice(0, 800);
    lines.push('', excerpt + (item.descriptionMd.length > 800 ? '…' : ''));
  }
  return lines.join('\n');
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
  const project = await projectsService.getByKey(args.projectKey, ctx);
  const dispatch = await workItemsService.getNextReady(project.id, filter, ctx);

  if (!dispatch) {
    return toolOk('No ready work items match.', { item: null });
  }
  return toolOk(summarize(dispatch), { item: dispatch as unknown as Record<string, unknown> });
}

export function registerNextReady(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    NEXT_READY_TOOL_NAME,
    {
      title: 'Next ready work item',
      description:
        'Return ONE ready work item to start next — the highest-ranked ready item not in ' +
        'excludeIds — as a full dispatch payload (description, context refs, blocker keys, run ' +
        'command), or an empty result when nothing is ready. Pass already-handled ids in ' +
        'excludeIds to walk the set.',
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
