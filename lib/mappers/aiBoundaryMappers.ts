import type { WorkItemKindDto, WorkItemListItemDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type {
  PlanTreeSkeletonItem,
  BlockingEdge,
  OrgContextResponse,
  SearchResultRow,
} from '@/lib/dto/ai';
import type { OrgFootprintDTO } from '@/lib/dto/organizations';

// The structural minimum every skeleton projection needs — the fields shared by
// WorkItemSummaryDto (the flat breadth read), WorkItemSubtreeDto (the depth-
// bounded subtree walk), and the blocking-closure nodes. Keeping the mapper keyed
// to this shape lets the whole 7.5 read family reuse ONE projection.
export interface SkeletonSourceRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  identifier: string;
  title: string;
  status: string;
}

// Map a set of work-item rows to the plan-tree skeleton (contract §6).
// `parentKey` is resolved from `parentId` via an in-batch id→identifier map — a
// parent outside the batch (a subtree root's own parent, an unrelated blocker's
// container) resolves to null rather than a dangling id. `revisionByItemId` is
// the batched latest-revision lookup the service computed once for the whole read
// (MOTIR-1531); a row with no revision entry projects `revision: null`.
export function toSkeletonRows(
  rows: SkeletonSourceRow[],
  revisionByItemId: Map<string, string>,
): PlanTreeSkeletonItem[] {
  const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));
  return rows.map((r) => ({
    key: r.identifier,
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    parentKey: r.parentId ? (idToKey.get(r.parentId) ?? null) : null,
    revision: revisionByItemId.get(r.id) ?? null,
  }));
}

// Map the flat work-item summaries (the breadth read) to the plan-tree skeleton.
// The whole-project read returns every parent, so `parentKey` always resolves.
export function toPlanTreeSkeleton(
  items: WorkItemSummaryDto[],
  revisionByItemId: Map<string, string>,
): PlanTreeSkeletonItem[] {
  return toSkeletonRows(items, revisionByItemId);
}

// Map the transitive is_blocked_by closure's edges (item ids) to identifier
// keys via the id→key map the caller built from the root + closure nodes. An
// id absent from the map falls back to the raw id (never happens for a
// well-formed closure — every edge endpoint is the root or a returned node).
export function toBlockingEdges(
  edges: Array<{ blockedId: string; blockerId: string }>,
  idToKey: Map<string, string>,
): BlockingEdge[] {
  return edges.map((e) => ({
    blockedKey: idToKey.get(e.blockedId) ?? e.blockedId,
    blockerKey: idToKey.get(e.blockerId) ?? e.blockerId,
  }));
}

// Map the shipped List rows (the `/items` breadth read `getProjectIssuesList`
// returns, Subtask 7.5.2) to the flat search projection. `WorkItemListItemDto`
// carries no `parentId`, so — unlike `toSkeletonRows` — there is no parent to
// resolve; a filtered hit-set is a flat page, not a neighbourhood. The `type` +
// `priority` the List row already surfaces pass through so the planner can rank
// hits before spending a DEPTH read. `id` + `revision` (the latter from the
// service's one batched lookup, MOTIR-1531) carry the modify/remove anchor so a
// hit can be reconciled without a follow-up `get-item`.
export function toSearchResultRows(
  items: WorkItemListItemDto[],
  revisionByItemId: Map<string, string>,
): SearchResultRow[] {
  return items.map((i) => ({
    key: i.identifier,
    id: i.id,
    kind: i.kind,
    type: i.type,
    title: i.title,
    status: i.status,
    priority: i.priority,
    revision: revisionByItemId.get(i.id) ?? null,
  }));
}

// Map the org-domain footprint summary to the AI boundary's wire shape (contract
// §6, Subtask 7.3.45). Only the org id + name cross — the boundary doesn't expose
// the slug; the counts + the capped name sample pass through unchanged.
export function toOrgContextResponse(footprint: OrgFootprintDTO): OrgContextResponse {
  return {
    organization: { id: footprint.organization.id, name: footprint.organization.name },
    workspaceCount: footprint.workspaceCount,
    projectCount: footprint.projectCount,
    projectNames: footprint.projectNames,
    memberCount: footprint.memberCount,
  };
}
