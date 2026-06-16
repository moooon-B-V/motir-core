// DTOs for the ai→core read-back surface (boundary contract §6). motir-ai reads
// these (the cheap skeleton) and submits a delta; the rich graph-traversal
// retrieval supersedes the read in Story 7.5.

import type { WorkItemKindDto } from '@/lib/dto/workItems';

// One node of the plan-tree breadth projection: the cheap fields the planner
// needs to reason over the tree, keyed by work-item identifier.
export interface PlanTreeSkeletonItem {
  key: string; // e.g. "MOTIR-481"
  kind: WorkItemKindDto;
  title: string;
  status: string;
  parentKey: string | null;
}

export interface PlanTreeResponse {
  project: { projectId: string; projectKey: string };
  items: PlanTreeSkeletonItem[];
}

// One applied operation's result — the resolved key + id core assigned.
export interface PlanDeltaAppliedEntry {
  op: 'create' | 'update';
  ref?: string;
  key: string;
  id: string;
}

export interface CommitPlanDeltaResponse {
  applied: PlanDeltaAppliedEntry[];
}
