import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemKind, WorkItemPriority } from '@prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyListFilter } from '@/lib/workItems/readyFilter';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  assigneeIdField,
  kindsField,
  normalizeAssigneeId,
  priorityField,
  projectKeyField,
} from './readyFilters';

// `list_ready` (Story 7.8 · Subtask 7.8.4) — BROWSE the ready set: a
// cursor-paginated page of ready-to-start work items in a project. Wraps
// `workItemsService.listReady` 1:1 (the same contract `GET /api/ready` serves),
// so the page and the agent never disagree on what "ready" means. Paginated
// from day one — there is no load-everything path.

export const LIST_READY_TOOL_NAME = 'list_ready';

const inputSchema = {
  projectKey: projectKeyField,
  kinds: kindsField,
  priority: priorityField,
  assigneeId: assigneeIdField,
  cursor: z.string().optional().describe('Opaque page cursor from a previous call’s nextCursor.'),
  limit: z.number().int().positive().max(200).optional().describe('Page size (1–200, default 50).'),
};

interface ListReadyArgs {
  projectKey: string;
  kinds?: WorkItemKind[];
  priority?: WorkItemPriority[];
  assigneeId?: string | null;
  cursor?: string;
  limit?: number;
}

/** One ready row as a compact line. */
function line(item: ReadyItemDto): string {
  const who = item.assignee ? item.assignee.name : 'unassigned';
  return `${item.key} [${item.kind}/${item.priority}] ${item.title} — ${who}`;
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
  const project = await projectsService.getByKey(args.projectKey, ctx);
  const page = await workItemsService.listReady(project.id, filter, ctx);

  const header =
    page.items.length === 0
      ? 'No ready work items match.'
      : `${page.items.length} ready item${page.items.length === 1 ? '' : 's'}:`;
  const body = page.items.map(line).join('\n');
  const footer = page.nextCursor ? `\n\nMore available — pass cursor: ${page.nextCursor}` : '';
  return toolOk(`${header}${body ? '\n' + body : ''}${footer}`, {
    items: page.items,
    nextCursor: page.nextCursor,
  });
}

export function registerListReady(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_READY_TOOL_NAME,
    {
      title: 'List ready work items',
      description:
        'List ready-to-start work items in a project (every dependency satisfied), as a ' +
        'cursor-paginated page. Optional filters: kinds, priority, assigneeId. Returns the same ' +
        'set the project’s Ready view shows.',
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
