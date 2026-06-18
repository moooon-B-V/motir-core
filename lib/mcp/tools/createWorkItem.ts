import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Executor, WorkItemPriority, WorkItemType } from '@prisma/client';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CreateWorkItemInput,
  ExecutorDto,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
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
//
// Leaf-authoring fields (MOTIR-1081): besides `storyPoints`, this tool also
// accepts `estimateMinutes`, `type`, and `executor` — the same leaf fields
// `update_work_item` patches — so a subtask can be created FULLY-SPECIFIED in
// one call (the MOTIR.md estimation gate satisfiable at create time, no
// mandatory create-then-update round-trip). They map straight onto the
// `CreateWorkItemInput` fields the service already validates: the leaf-only
// `type`/`executor` rule (`TypeNotAllowedOnKindError` on an epic/story kind),
// the type→executor seed (a `type` set without an explicit `executor` seeds it
// from `defaultExecutorForType`), and the shared estimate validation all run in
// the service UNCHANGED — this tool only widens the input surface.

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
  storyPoints: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Optional story-point estimate (the agile sizing number, distinct from a ' +
        'time estimate). A non-negative number ≤ 9999.99 with at most two decimal ' +
        'places; omit (or null) to leave it unestimated.',
    ),
  estimateMinutes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'Optional estimated minutes of work (the TIME estimate, distinct from ' +
        'story points); omit (or null) to leave it unestimated.',
    ),
  type: z
    .nativeEnum(WorkItemType)
    .nullable()
    .optional()
    .describe(
      'Optional work type (code, design, test, …) — leaf items (task / bug / ' +
        'subtask) only; rejected on a story. Setting a type seeds the executor ' +
        'from the type default unless an explicit executor is also given. ' +
        'Omit (or null) to leave it untyped.',
    ),
  executor: z
    .nativeEnum(Executor)
    .nullable()
    .optional()
    .describe(
      'Optional executor ("coding_agent" or "human") — leaf items only; ' +
        'overrides the type default when supplied. Omit (or null) to take the ' +
        'type default (or leave it unset when no type is given).',
    ),
};

interface CreateWorkItemArgs {
  projectKey: string;
  kind: 'story' | 'task' | 'bug' | 'subtask';
  title: string;
  parentKey?: string;
  descriptionMd?: string;
  priority?: WorkItemPriority;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  type?: WorkItemType | null;
  executor?: Executor | null;
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
      // Story points (7.8.21): forward only when supplied — both a number and an
      // explicit null pass through (the service validates + treats null as
      // unestimated); omitted leaves the column default.
      ...(args.storyPoints !== undefined ? { storyPoints: args.storyPoints } : {}),
      // Leaf-authoring fields (MOTIR-1081): forward only when supplied so an
      // omitted field still leaves the column default. The service owns the
      // leaf-only `type`/`executor` rule + the type→executor seed + the
      // estimate validation — this is a thin pass-through.
      ...(args.estimateMinutes !== undefined ? { estimateMinutes: args.estimateMinutes } : {}),
      ...(args.type !== undefined ? { type: args.type as WorkItemTypeDto | null } : {}),
      ...(args.executor !== undefined ? { executor: args.executor as ExecutorDto | null } : {}),
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
        'BUG. Optionally set the leaf-authoring fields up front — story points, estimate ' +
        '(minutes), work type, and executor — so a subtask can be created fully-specified in ' +
        'one call. Honors the same kind-parent rules, leaf-only type/executor rule, and access ' +
        'checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runCreateWorkItem(args, resolveContext(extra)),
  );
}
