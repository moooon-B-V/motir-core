import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `change_kind` (Story 7.8 · Subtask 7.8 MOTIR-1020) — RECLASSIFY a work item:
// change its KIND (story ⇄ task ⇄ bug ⇄ subtask). This closes the other
// structural change the agent surface lacked: `create_work_item` sets `kind`
// only AT CREATE, and `update_work_item` deliberately omits it ("a structural
// move, not a field edit"), so an agent that mis-typed an item had no way to
// fix it short of delete-and-recreate (which loses the identifier, history,
// comments, and links). Reclassifying is its OWN verb here for the same reason
// re-parenting (`move_to_parent`) and status (`transition_status`) are.
//
// NOTE: the WORK TYPE (`type`: code/design/test/…) is a DIFFERENT axis and is
// already editable via `update_work_item` (`type` + `executor`) — this tool is
// strictly the hierarchy KIND, not the work type.
//
// A THIN adapter over `workItemsService.updateWorkItem({ kind })` — the same
// service path the UI edit form uses. The kind change is re-validated against
// BOTH sides of the kind-parent matrix (the new kind must be legal under the
// CURRENT parent, and must legally parent EVERY existing child — else
// `IllegalParentTypeError`), and the leaf-only `type`/`executor` are reconciled
// against the new kind (converting a typed leaf into a container kind without
// first clearing its type is rejected with `TypeNotAllowedOnKindError`); the DB
// trigger backstops kind/depth/cycle and the 6.4 edit gate + revision row all
// run in the service UNCHANGED. This tool only resolves the `PROD-<n>` key.
//
// `epic` is NOT an offered target — epics are structural plan scaffolding the
// planner/seed owns, exactly as `create_work_item` excludes it.

export const CHANGE_KIND_TOOL_NAME = 'change_kind';

const inputSchema = {
  key: workItemKeyField,
  kind: z
    .enum(['story', 'task', 'bug', 'subtask'])
    .describe(
      'The new work item kind. Must keep the kind-parent matrix legal for both the ' +
        "item's current parent AND all of its children. (This is the hierarchy KIND, " +
        'NOT the work type — use update_work_item to change type/executor.)',
    ),
};

interface ChangeKindArgs {
  key: string;
  kind: 'story' | 'task' | 'bug' | 'subtask';
}

/** Compact human-readable summary of a reclassify. */
function summarize(dto: WorkItemDto): string {
  return `Reclassified ${dto.identifier} → [${dto.kind}${dto.type ? `/${dto.type}` : ''}] ${dto.title}`;
}

/** The adapter: resolve the item by key, then patch its kind. */
export async function runChangeKind(
  args: ChangeKindArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    const dto = await workItemsService.updateWorkItem(
      item.id,
      { kind: args.kind as WorkItemKindDto },
      ctx,
    );
    return toolOk(summarize(dto), dto as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerChangeKind(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CHANGE_KIND_TOOL_NAME,
    {
      title: 'Change work item kind',
      description:
        'Reclassify a work item (by identifier, e.g. "PROD-7"): change its KIND between story, ' +
        'task, bug, and subtask. The item keeps its identifier, history, comments, and links. ' +
        'The new kind must stay legal under the current parent and over all existing children, ' +
        'and a container kind cannot keep a leaf-only work type — same rules and access checks ' +
        'as the UI. This changes the hierarchy KIND, not the work type (use update_work_item for ' +
        'type/executor). Epic is not an available target.',
      inputSchema,
    },
    async (args, extra) => runChangeKind(args, resolveContext(extra)),
  );
}
