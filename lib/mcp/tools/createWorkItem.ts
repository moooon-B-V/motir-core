import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemPriority } from '@prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CreateWorkItemInput, WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier } from './workItemRef';

// `create_work_item` (Story 7.8 · Subtask 7.8.5) — create a work item (story /
// task / bug / subtask) under a project, optionally parented. A THIN adapter
// over `workItemsService.createWorkItem`: the kind-parent matrix (finding #41),
// the per-project key allocation, the initial-status seed, the revision row,
// and the 6.4 edit gate all run in the service UNCHANGED — this tool adds no
// business logic, it only resolves the project + parent KEYS to ids and pins
// the reporter to the token's owning user (`ctx.userId`).
//
// `kind: bug` under a story/epic IS the findings bug-logging protocol — the
// description below says so, so an agent told to "log this bug in Motir" finds
// THIS tool. (Epic is deliberately NOT an offered kind: epics are structural
// plan scaffolding created by the planner/seed; the agent surface creates the
// executable tree — stories, tasks, subtasks — and bugs.)

export const CREATE_WORK_ITEM_TOOL_NAME = 'create_work_item';

const inputSchema = {
  projectKey: z.string().min(1).describe('The project key the item is created in, e.g. "PROD".'),
  kind: z
    .enum(['story', 'task', 'bug', 'subtask'])
    .describe(
      'The work item kind. Use "bug" under a story/epic to log a defect (the bug-logging protocol).',
    ),
  title: z.string().min(1).describe('The work item title (one line).'),
  parentKey: z
    .string()
    .optional()
    .describe(
      'Optional parent work item identifier (e.g. "PROD-3") — must be a kind-legal, same-project parent.',
    ),
  descriptionMd: z.string().optional().describe('Optional Markdown description body.'),
  priority: z
    .nativeEnum(WorkItemPriority)
    .optional()
    .describe('Optional priority (lowest…highest); omit for the project default.'),
};

interface CreateWorkItemArgs {
  projectKey: string;
  kind: 'story' | 'task' | 'bug' | 'subtask';
  title: string;
  parentKey?: string;
  descriptionMd?: string;
  priority?: WorkItemPriority;
}

/** Compact human-readable summary of a freshly-created work item. */
function summarize(dto: WorkItemDto): string {
  return [
    `Created ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${dto.title}`,
    `Status: ${dto.status} · Priority: ${dto.priority} · Reporter: ${dto.reporterId}` +
      (dto.parentId ? ` · Parent: ${dto.parentId}` : ''),
  ].join('\n');
}

/** The adapter: resolve project (+ optional parent) by key, then create. */
export async function runCreateWorkItem(
  args: CreateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);

    let parentId: string | null = null;
    if (args.parentKey != null && args.parentKey.trim() !== '') {
      // A parent must be in the SAME project (the create service re-checks
      // same-project + kind-legality). Resolve it within the new item's project;
      // a foreign/unknown parent identifier 404s here as WorkItemNotFoundError
      // (no existence leak), and the kind-legal check is the service's job.
      const parent = await workItemsService.getWorkItemByIdentifier(
        project.id,
        normalizeIdentifier(args.parentKey),
        ctx,
      );
      parentId = parent.id;
    }

    const input: CreateWorkItemInput = {
      projectId: project.id,
      kind: args.kind as WorkItemKindDto,
      title: args.title,
      parentId,
      descriptionMd: args.descriptionMd ?? null,
      ...(args.priority ? { priority: args.priority } : {}),
    };
    const dto = await workItemsService.createWorkItem(input, ctx);
    return toolOk(summarize(dto), dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CREATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Create work item',
      description:
        'Create a work item (story, task, bug, or subtask) in a project, optionally under a ' +
        'parent. The reporter is the token owner. Use kind "bug" under a story/epic to LOG A ' +
        'BUG. Honors the same kind-parent rules and access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runCreateWorkItem(args, resolveContext(extra)),
  );
}
