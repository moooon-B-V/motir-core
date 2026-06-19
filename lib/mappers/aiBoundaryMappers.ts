import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { PlanTreeSkeletonItem, OrgContextResponse } from '@/lib/dto/ai';
import type { OrgFootprintDTO } from '@/lib/dto/organizations';

// Map the flat work-item summaries (the breadth read) to the plan-tree skeleton
// (contract §6). `parentKey` is resolved from `parentId` via an in-batch
// id→identifier map — the read returns the WHOLE project, so every parent is
// present. A parent outside the batch (shouldn't happen for a whole-project
// read) resolves to null rather than a dangling id.
export function toPlanTreeSkeleton(items: WorkItemSummaryDto[]): PlanTreeSkeletonItem[] {
  const idToKey = new Map(items.map((i) => [i.id, i.identifier]));
  return items.map((i) => ({
    key: i.identifier,
    kind: i.kind,
    title: i.title,
    status: i.status,
    parentKey: i.parentId ? (idToKey.get(i.parentId) ?? null) : null,
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
