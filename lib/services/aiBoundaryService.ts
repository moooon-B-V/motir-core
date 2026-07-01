import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import {
  toPlanTreeSkeleton,
  toSkeletonRows,
  toSearchResultRows,
  toBlockingEdges,
  toOrgContextResponse,
} from '@/lib/mappers/aiBoundaryMappers';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { decodeSearchCursor, encodeSearchCursor } from '@/lib/mcp/searchCursor';
import type { FilterAst } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  PlanTreeResponse,
  OrgContextResponse,
  GetItemResponse,
  SubtreeResponse,
  BlockingClosureResponse,
  SearchWorkItemsResponse,
} from '@/lib/dto/ai';

// The ai→core boundary service (Subtask 7.1.6). The READ-back side of the
// boundary: the project's work-item skeleton (plan-tree) + the calling org's
// footprint (org-context), each orchestrated through the SAME permission-scoped
// services the UI/MCP use — never raw Prisma — so the AI reads only what the
// token's user could. Deliberately minimal: the rich graph-traversal retrieval is
// Story 7.5; this is the skeleton it grows from.
//
// The former WRITE side — `commitPlanDelta` / `POST /api/internal/ai/plan-delta`,
// the whole-delta buffered persist — was REMOVED by 7.4.4 (MOTIR-846). Generation
// no longer buffers a delta: it EMITS incremental `add` PlanItem proposals into a
// 7.21 `Plan` via `POST /api/internal/ai/plan-proposals` (aiGenerationService),
// and a real work-item tree appears only on APPROVE/materialize. There is no
// buffered atomic-persist path.

export const aiBoundaryService = {
  // GET /api/internal/ai/plan-tree — the project's work-item skeleton. The
  // listWorkItems gate raises ProjectNotFoundError (404, never 403) for a
  // project the token's user can't browse — the cross-tenant posture (finding
  // #26). `projectKey` comes from the gated project row.
  async readPlanTree(projectId: string, ctx: ServiceContext): Promise<PlanTreeResponse> {
    const items = await workItemsService.listWorkItems(projectId, {}, ctx);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    return {
      project: { projectId, projectKey: project.identifier },
      items: toPlanTreeSkeleton(items),
    };
  },

  // GET /api/internal/ai/org-context (Subtask 7.3.45) — the calling org's
  // existing footprint, the read-back the discovery interview weighs when it
  // classifies a new project. The token scopes to a WORKSPACE; the org is that
  // workspace's parent. resolveWorkspaceAccess gates the workspace AS the token's
  // user AND yields its organizationId in one call (returns null when the user
  // can't reach the workspace → 404-not-403, the no-leak posture); the org
  // footprint is then summarised through organizationsService (also AS the user).
  async readOrgContext(ctx: ServiceContext): Promise<OrgContextResponse> {
    const access = await organizationsService.resolveWorkspaceAccess(ctx.userId, ctx.workspaceId);
    if (!access) {
      // The token's user can't reach this workspace — surface as not-found, never
      // leak that the org exists (OrganizationNotFoundError → 404, like plan-tree).
      throw new OrganizationNotFoundError(ctx.workspaceId);
    }
    const footprint = await organizationsService.summarizeOrgFootprint({
      userId: ctx.userId,
      organizationId: access.organizationId,
    });
    return toOrgContextResponse(footprint);
  },

  // ── Story 7.5 — the plan-tree GRAPH-TRAVERSAL read family ────────────────
  // The DEPTH reads a planner walks over the SAME job-scoped-token auth + tenant
  // gate as the skeleton. Each resolves its target by KEY within the token's
  // project (a cross-project / cross-tenant key → WorkItemNotFoundError → 404,
  // the no-leak posture) through the permission-scoped `workItemsService`, then
  // maps to the AI wire shape. `readPlanTree` above IS the `skeleton` tool.

  // GET /api/internal/ai/get-item — one work item by key, plus (on request) the
  // depth context 7.1.6 deferred: the cursor-paginated comment thread and the
  // cursor-paginated change log. `getWorkItemByIdentifier` is the gate (browse +
  // tenant, AS the token's user); comments/history are read only when asked.
  async getItem(
    projectId: string,
    key: string,
    ctx: ServiceContext,
    opts: {
      withComments?: boolean;
      withHistory?: boolean;
      commentsCursor?: string;
      historyCursor?: string;
    } = {},
  ): Promise<GetItemResponse> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, key, ctx);
    const response: GetItemResponse = { item };
    if (opts.withComments) {
      response.comments = await commentsService.listComments(
        item.id,
        opts.commentsCursor ? { cursor: opts.commentsCursor } : {},
        ctx,
      );
    }
    if (opts.withHistory) {
      response.history = await workItemsService.listRevisionsPage(
        item.id,
        ctx,
        opts.historyCursor ? { cursor: opts.historyCursor } : {},
      );
    }
    return response;
  },

  // GET /api/internal/ai/get-subtree — a root (by key) + its descendants bounded
  // by `depth` (depth-bounded, never a whole-tree read). Each node is the same
  // skeleton row the planner folds into context; the response echoes the CLAMPED
  // depth the read applied.
  async getSubtree(
    projectId: string,
    rootKey: string,
    depth: number | undefined,
    ctx: ServiceContext,
  ): Promise<SubtreeResponse> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, rootKey, ctx);
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const { nodes, depth: effectiveDepth } = await workItemsService.getBoundedSubtree(
      root.id,
      ctx,
      depth,
    );
    return {
      project: { projectId, projectKey: project.identifier },
      root: root.identifier,
      depth: effectiveDepth,
      nodes: toSkeletonRows(nodes),
    };
  },

  // GET /api/internal/ai/walk-blocking — the transitive is_blocked_by closure of
  // a root (by key): "what must land before this". Cycle-safe + node/-depth
  // capped in the service; here we map node ids + edge endpoints to identifier
  // keys (the map spans the root + every closure node — every edge endpoint is
  // one of these).
  async walkBlocking(
    projectId: string,
    key: string,
    ctx: ServiceContext,
    opts: { maxDepth?: number; maxNodes?: number } = {},
  ): Promise<BlockingClosureResponse> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, key, ctx);
    const closure = await workItemsService.getBlockingClosure(root.id, ctx, opts);
    const idToKey = new Map<string, string>([[root.id, root.identifier]]);
    for (const n of closure.nodes) idToKey.set(n.id, n.identifier);
    return {
      root: root.identifier,
      nodes: toSkeletonRows(closure.nodes),
      edges: toBlockingEdges(closure.edges, idToKey),
      truncated: closure.truncated,
    };
  },

  // POST /api/internal/ai/search-work-items (Subtask 7.5.2) — the on-demand
  // SEARCH tool for unbounded augment ("find the work items related to X"). It
  // rides the SHIPPED 6.1.1 FilterAST + the EXACT `/items` List read
  // (`getProjectIssuesList`) — no parallel query language, no raw Prisma — so
  // the planner and the page can never disagree on a result set, and the same
  // registry validation (unknown field/operator/bad value → FilterValidationError
  // → 422) and tenant gate (cross-tenant project → ProjectNotFoundError → 404)
  // apply unbypassed. The `ast` is already decoded by the route's shared 6.1.1
  // codec; an undefined `ast` pages the whole project.
  //
  // Pagination mirrors the `search_work_items` MCP tool (7.8.6): the opaque page
  // cursor wraps the List read's 1-based LIMIT/OFFSET page, so the surface is
  // paginated from day one (never a "return all"). A cursor that overshot the
  // tail reads as an empty terminal page (parity with the ready cursor), NOT a
  // re-fetch of the clamped last page that would loop. Returns the cheap
  // skeleton projection — the planner pulls DEPTH via `get_item` only for hits
  // it cares about.
  async searchWorkItems(
    projectId: string,
    opts: { ast?: FilterAst; cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<SearchWorkItemsResponse> {
    // The opaque cursor carries the next 1-based page; absent → page 1. A
    // malformed token throws InvalidSearchCursorError (→ 400 at the route).
    const requestedPage = opts.cursor ? decodeSearchCursor(opts.cursor).page : 1;

    const result = await workItemsService.getProjectIssuesList(
      projectId,
      {
        sort: DEFAULT_SORT,
        ...(opts.ast ? { filter: { ast: opts.ast } } : {}),
        page: requestedPage,
        ...(opts.limit !== undefined ? { pageSize: opts.limit } : {}),
      },
      ctx,
    );

    // The read CLAMPS an over-the-end page to the last page. A cursor that
    // overshot the tail must read as an empty terminal page, NOT a re-fetch of
    // the clamped last page (which would loop).
    const overshot = result.page < requestedPage;
    const items = overshot ? [] : result.items;
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const nextCursor =
      !overshot && result.page < totalPages ? encodeSearchCursor({ page: result.page + 1 }) : null;

    return { items: toSearchResultRows(items), total: result.total, nextCursor };
  },
};
