import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Executor, WorkItemPriority, WorkItemType } from '@prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  ExecutorDto,
  UpdateWorkItemInput,
  WorkItemDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `update_work_item` (Story 7.8 · Subtask 7.8.14) — EDIT a work item's fields,
// the partial-patch counterpart of `create_work_item`. `create_work_item` can
// only set kind/title/parentKey/descriptionMd/priority; this tool patches the
// REST of the UI-editable fields (`type`, `executor`, `estimateMinutes`,
// `assigneeId`, `dueDate`) plus the ones create also sets — so an agent can FIX
// a card after creating it instead of the old cancel-and-recreate hack.
//
// A THIN adapter over `workItemsService.updateWorkItem`: the leaf-only `type`/
// `executor` rule, the type→executor seed, the assignee-membership check, the
// 6.4 edit gate, and the revision row all run in the service UNCHANGED. Workflow
// STATUS is deliberately NOT here — it stays on `transition_status` (the legal-
// transition validation lives there); `kind`/`parentId` re-parenting also stays
// out (a structural move, not a field edit). Only fields the service's
// `UpdateWorkItemInput` actually accepts are exposed — `storyPoints` is not one
// of them, so it is intentionally absent (set via the UI estimation surface).

export const UPDATE_WORK_ITEM_TOOL_NAME = 'update_work_item';

const inputSchema = {
  key: workItemKeyField,
  title: z.string().min(1).optional().describe('New title (one line).'),
  descriptionMd: z
    .string()
    .nullable()
    .optional()
    .describe('New Markdown description body; null clears it.'),
  explanationMd: z
    .string()
    .nullable()
    .optional()
    .describe('New Markdown explanation body (the "why"); null clears it.'),
  priority: z.nativeEnum(WorkItemPriority).optional().describe('New priority (lowest…highest).'),
  type: z
    .nativeEnum(WorkItemType)
    .nullable()
    .optional()
    .describe(
      'New work type (code, design, test, …) — leaf items only; null clears it. ' +
        'Setting a type the first time seeds the executor from the type default.',
    ),
  executor: z
    .nativeEnum(Executor)
    .nullable()
    .optional()
    .describe(
      'Who executes the work ("coding_agent" or "human") — leaf items only; null clears it.',
    ),
  estimateMinutes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Estimated minutes of work; null clears it.'),
  assigneeId: z
    .string()
    .nullable()
    .optional()
    .describe('New assignee user id (must be a workspace member); null unassigns.'),
  dueDate: z
    .string()
    .nullable()
    .optional()
    .describe('Due date as an ISO-8601 string; null clears it.'),
};

interface UpdateWorkItemArgs {
  key: string;
  title?: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  priority?: WorkItemPriority;
  type?: WorkItemType | null;
  executor?: Executor | null;
  estimateMinutes?: number | null;
  assigneeId?: string | null;
  dueDate?: string | null;
}

/** Build the partial patch from only the args the caller actually supplied. */
function toPatch(args: UpdateWorkItemArgs): UpdateWorkItemInput {
  const patch: UpdateWorkItemInput = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.descriptionMd !== undefined) patch.descriptionMd = args.descriptionMd;
  if (args.explanationMd !== undefined) patch.explanationMd = args.explanationMd;
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.type !== undefined) patch.type = args.type as WorkItemTypeDto | null;
  if (args.executor !== undefined) patch.executor = args.executor as ExecutorDto | null;
  if (args.estimateMinutes !== undefined) patch.estimateMinutes = args.estimateMinutes;
  if (args.assigneeId !== undefined) patch.assigneeId = args.assigneeId;
  if (args.dueDate !== undefined) patch.dueDate = args.dueDate;
  return patch;
}

/** Compact human-readable summary of the patched fields. */
function summarize(dto: WorkItemDto, patchedKeys: string[]): string {
  const fields = patchedKeys.length > 0 ? patchedKeys.join(', ') : 'nothing';
  return [
    `Updated ${dto.identifier} [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${dto.title}`,
    `Patched: ${fields}`,
  ].join('\n');
}

/** The adapter: resolve the project + item by key, then apply the patch. */
export async function runUpdateWorkItem(
  args: UpdateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const patch = toPatch(args);
    const dto = await workItemsService.updateWorkItem(item.id, patch, ctx);
    return toolOk(summarize(dto, Object.keys(patch)), dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerUpdateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    UPDATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Update work item',
      description:
        'Edit a work item (by identifier, e.g. "PROD-7"): patch any subset of title, ' +
        'description, explanation, priority, type, executor, estimate, assignee, or due date. ' +
        'Use transition_status for the workflow status. Honors the same leaf-only type rules, ' +
        'assignee-membership check, and access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runUpdateWorkItem(args, resolveContext(extra)),
  );
}
