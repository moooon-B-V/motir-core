import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { presentMcpSkeletonRow, skeletonPayload } from '../payloads/workItems';
import { projectKeyField } from './sprintRef';

// `skeleton` (Story MOTIR-3098 · Subtask MOTIR-3100) — the whole project's tree
// SHAPE in one read, and the answer to the question a planning agent asks before
// it proposes anything: what is already here?
//
// No new query. `aiBoundaryService.readPlanTree` is the breadth projection
// `GET /api/internal/ai/plan-tree` (7.1.6) serves and `GET /api/internal/ai/skeleton`
// (7.5.1) re-exposes as a named tool "so the planner has one coherent tool
// surface (get_item / get_subtree / walk_blocking / skeleton)". This is a THIRD
// consumer of that read, not a refactor of it — neither internal route changes.
//
// ── The NAME is deliberately motir-ai's ─────────────────────────────────────
// `skeleton`, not `get_plan_tree` or `list_tree`. An agent that has read
// motir-ai's plan-tree tool surface and then reads the MCP's should find the same
// concept called the same thing; inventing a second name for one read is how two
// surfaces start describing the same capability differently.
//
// ── Two differences from the internal route, both deliberate ────────────────
// 1. THE PROJECT IS A PARAMETER. The internal route takes none — "the project is
//    the TOKEN's project" — because a job token is scoped to exactly one. A PAT
//    is not: it reaches every project its holder can browse. So this takes a
//    `projectKey` like every other MCP tool and resolves it through
//    `projectsService.getByKey`, which is bound to `ctx.workspaceId` and
//    browse-gated — another tenant's key reads as a plain not-found, the same
//    404-not-403 answer the whole surface gives, and never a partial tree.
// 2. THE BOUND IS THE MCP'S TO STATE. `SKELETON_RENDER_CAP = 300` in motir-ai is
//    a client-side RENDER cap, not the route's; `readPlanTree` itself is
//    unbounded. See {@link SKELETON_ITEM_CAP}.
//
// ── Why the bound announces itself ─────────────────────────────────────────
// A skeleton that silently stops at N reads as "this is the whole project", and
// an agent that believes it has seen everything proposes work that already
// exists two levels down — the MOTIR-3079 failure, arrived at from the other
// side. So `total` / `returned` / `truncated` / `limit` are on EVERY response,
// not only a truncated one: a caller must never have to infer completeness from
// a row count it has nothing to compare against (the no-silent-caps rule).

export const SKELETON_TOOL_NAME = 'skeleton';

/**
 * The response bound, and the default `limit`.
 *
 * Chosen to be well ABOVE a real project rather than tidily round: MOTIR itself
 * holds ~2 840 live items at the time of writing, and a cap that truncated the
 * very project this tool was built to orient over would make the truncation flag
 * the normal case instead of the exceptional one. The cost is a large single
 * result, which is the trade the card asks for — one call instead of a
 * fifty-row paging loop the agent then has to re-parent client-side.
 */
export const SKELETON_ITEM_CAP = 5000;

const inputSchema = {
  projectKey: projectKeyField,
  limit: z
    .number()
    .int()
    .min(1)
    .max(SKELETON_ITEM_CAP)
    .optional()
    .describe(
      `Maximum rows to return; default (and maximum) ${SKELETON_ITEM_CAP} — the whole tree. ` +
        'Pass a smaller number for a cheap peek. The response always reports `total`, ' +
        '`returned` and `truncated`, so a bounded answer is never mistaken for a whole one.',
    ),
};

/** Compact human summary — the shape of the answer, and whether it is complete. */
export function summarizeSkeleton(input: {
  projectKey: string;
  total: number;
  returned: number;
  truncated: boolean;
  limit: number;
}): string {
  const head = `${input.projectKey} — ${input.total} live work item(s)`;
  return input.truncated
    ? `${head}; TRUNCATED at limit ${input.limit} — ${input.returned} returned. ` +
        'This is NOT the whole project: raise `limit` before concluding anything is absent.'
    : `${head}, all ${input.returned} returned — the whole tree.`;
}

/** The adapter: resolve the project by key, then read its breadth projection. */
export async function runSkeleton(
  args: { projectKey: string; limit?: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const tree = await aiBoundaryService.readPlanTree(project.id, ctx);
    const limit = args.limit ?? SKELETON_ITEM_CAP;
    const total = tree.items.length;
    const rows = tree.items.slice(0, limit).map(presentMcpSkeletonRow);
    const payload = {
      project: tree.project,
      items: rows,
      total,
      returned: rows.length,
      truncated: rows.length < total,
      limit,
    };
    return toolOk(
      summarizeSkeleton({ projectKey: project.identifier, ...payload }),
      derived(skeletonPayload, payload),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerSkeleton(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    SKELETON_TOOL_NAME,
    {
      title: 'Project skeleton',
      description:
        'ORIENT before proposing: the whole project’s tree SHAPE in ONE read — every live ' +
        'work item’s key, kind, title, status and parent, plus the `id` and `revision` a ' +
        'plan proposal anchors on. This is what to call FIRST when you need to know what a ' +
        'project already contains; it REPLACES paging `search_work_items` fifty flat rows at a ' +
        'time and re-parenting them client-side, and it is not a second way to list items — it ' +
        'carries no descriptions, no assignees and no filters. `total`, `returned` and ' +
        '`truncated` are always reported, so a bounded answer can never be mistaken for a ' +
        'complete one. Read-only. Honors the same access checks as the UI; the project key ' +
        'resolves inside the token’s own workspace, and a project you cannot browse is a ' +
        'plain not-found rather than a partial tree.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runSkeleton(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
