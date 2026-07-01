import type { WorkItemKindDto, WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { PlanTreeSkeletonItem, BlockingEdge, OrgContextResponse } from '@/lib/dto/ai';
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
// container) resolves to null rather than a dangling id.
export function toSkeletonRows(rows: SkeletonSourceRow[]): PlanTreeSkeletonItem[] {
  const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));
  return rows.map((r) => ({
    key: r.identifier,
    kind: r.kind,
    title: r.title,
    status: r.status,
    parentKey: r.parentId ? (idToKey.get(r.parentId) ?? null) : null,
  }));
}

// Map the flat work-item summaries (the breadth read) to the plan-tree skeleton.
// The whole-project read returns every parent, so `parentKey` always resolves.
export function toPlanTreeSkeleton(items: WorkItemSummaryDto[]): PlanTreeSkeletonItem[] {
  return toSkeletonRows(items);
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
