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

// GET /api/internal/ai/org-context (Subtask 7.3.45) — the calling org's
// existing footprint, the read-back the discovery interview weighs when it
// classifies a new project (an org already running several projects with a
// multi-person team skews startup/enterprise). The wire shape the planner reads;
// derived from the org domain's OrgFootprintDTO but owns its own contract (only
// the org id + name cross — no slug). Scoped to the job token's org, read AS the
// token's user.
export interface OrgContextResponse {
  organization: { id: string; name: string };
  workspaceCount: number;
  projectCount: number;
  projectNames: string[];
  memberCount: number;
}
