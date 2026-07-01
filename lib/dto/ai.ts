// DTOs for the ai→core read-back surface (boundary contract §6). motir-ai reads
// these (the cheap skeleton) and submits a delta; the rich graph-traversal
// retrieval supersedes the read in Story 7.5.

import type { WorkItemDto, WorkItemKindDto, WorkItemRevisionDto } from '@/lib/dto/workItems';
import type { CommentsPageDTO } from '@/lib/dto/comments';

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

// ── Story 7.5 — the plan-tree GRAPH-TRAVERSAL read family ──────────────────
// The DEPTH reads the planning agent walks (get_item / get_subtree /
// walk_blocking), layered over the SAME job-scoped-token auth + tenant gate as
// the 7.1.6 skeleton (`skeleton` re-exposes that breadth read as a named tool
// in the family). Every response is bounded — comments are cursor-paginated,
// subtrees depth-bounded, the blocking closure node-capped (finding #57).

// One cursor-paged window of a work item's revision (status/field change) log —
// the "why is this item shaped this way" depth signal (mirrors CommentsPageDTO's
// take+1 next-page probe; newest-first, `nextCursor` null on the last page).
export interface WorkItemHistoryPage {
  revisions: WorkItemRevisionDto[];
  nextCursor: string | null;
}

// GET /api/internal/ai/get-item — one work item by key, plus (on request) the
// DEPTH context 7.1.6 deferred: the full comment thread and the change log, each
// bounded/paginated. `comments` / `history` are present ONLY when asked for.
export interface GetItemResponse {
  item: WorkItemDto;
  comments?: CommentsPageDTO;
  history?: WorkItemHistoryPage;
}

// GET /api/internal/ai/get-subtree — an epic/story + its descendants, bounded by
// `depth` (0 = the root alone; NO whole-tree read — Epic-7 Principle #2). Each
// node is the same cheap skeleton row the planner folds into context. `depth` is
// the EFFECTIVE (clamped) descendant-level bound the read applied.
export interface SubtreeResponse {
  project: { projectId: string; projectKey: string };
  root: string; // the root's key, e.g. "MOTIR-806"
  depth: number;
  nodes: PlanTreeSkeletonItem[];
}

// One edge of the transitive is_blocked_by closure (`blockedKey` is_blocked_by
// `blockerKey`), keyed by identifier so the planner reads the DAG directly.
export interface BlockingEdge {
  blockedKey: string;
  blockerKey: string;
}

// GET /api/internal/ai/walk-blocking — the transitive is_blocked_by closure for
// an item ("what must land before this"). `nodes` are the transitive blockers
// (skeleton rows, excluding the root); `edges` spell out the DAG. `truncated` is
// true when the walk hit the node/-depth cap before exhausting the graph — the
// cycle-safe, node-capped defense (a pathological graph can't exhaust the job).
export interface BlockingClosureResponse {
  root: string; // the root's key
  nodes: PlanTreeSkeletonItem[];
  edges: BlockingEdge[];
  truncated: boolean;
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
