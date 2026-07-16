import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueDetailDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';

// `get_work_item` (Story 7.8 · Subtask 7.8.4) — read ONE work item by its
// `PROD-<n>` identifier, returned as the issue-detail aggregate (the same
// `getIssueDetail` shape the detail page reads: the item + parent + children +
// dependency links + readiness verdict). One service call, no business logic —
// the 6.4 browse gate + the 404-not-403 cross-tenant contract live in the
// service unchanged.

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
  return toolOk(summarize(detail), detail as unknown as Record<string, unknown>);
}

export function registerGetWorkItem(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_WORK_ITEM_TOOL_NAME,
    {
      title: 'Get work item',
      description:
        'Read a single work item by its identifier (e.g. "PROD-7"): full detail including ' +
        'description, status, priority, assignee, parent/children, dependency links, and a ' +
        'readiness verdict. Honors the same access checks as the UI.',
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
