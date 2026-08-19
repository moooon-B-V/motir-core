// DTOs for the ai→core read-back surface (boundary contract §6). motir-ai reads
// these (the cheap skeleton) and submits a delta; the rich graph-traversal
// retrieval supersedes the read in Story 7.5.

import type {
  WorkItemDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemRevisionDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { CommentsPageDTO } from '@/lib/dto/comments';

// One node of the plan-tree breadth projection: the cheap fields the planner
// needs to reason over the tree, keyed by work-item identifier.
export interface PlanTreeSkeletonItem {
  key: string; // e.g. "MOTIR-481"
  // The real work-item cuid — the resolvable `workItemId` a generator emits on a
  // modify/remove PlanItem (materialize locks the target by cuid, not key). Folded
  // onto the breadth read (MOTIR-1531) so the generator no longer needs a
  // per-target `get-item` round-trip to recover it.
  id: string;
  kind: WorkItemKindDto;
  title: string;
  status: string;
  parentKey: string | null;
  // The id of the item's LATEST `work_item_revision` (null when it has none) — the
  // optimistic-concurrency `baseRevision` a modify/remove PlanItem stores (7.21.3
  // base-revision drift compares it to the target's current latest). Populated by
  // ONE batched `findLatestIdsByWorkItemIds` on the read (MOTIR-1531), never N+1.
  revision: string | null;
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

// One matching row of the FilterAST search (Subtask 7.5.2) — the cheap
// projection the planner triages on. Deliberately flatter than the tree
// skeleton (`PlanTreeSkeletonItem`): a search hit-set is a flat filtered page,
// not a neighbourhood, so there is no meaningful `parentKey` to resolve (a
// filtered page rarely contains a hit's parent). It carries `type` + `priority`
// — the extra signal the shipped List row already surfaces — so the planner can
// rank hits before spending a `get_item` DEPTH read on the ones it cares about.
export interface SearchResultRow {
  key: string; // e.g. "MOTIR-852"
  // The real work-item cuid + its latest `work_item_revision` id (null when none)
  // — the modify/remove anchor a generator needs, carried consistently with the
  // tree skeleton so a hit can be reconciled without a follow-up `get-item`
  // (MOTIR-1531; `revision` from the SAME batched lookup, never N+1).
  id: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  revision: string | null;
}

// POST /api/internal/ai/search-work-items (Subtask 7.5.2) — the on-demand SEARCH
// the planner runs to find the work items related to X without transmitting the
// whole tree. Rides the SHIPPED 6.1.1 versioned FilterAST + the `/items` List
// read (`getProjectIssuesList`), so it pages IDENTICALLY to the surface humans
// see: `nextCursor` is null on the last page (an opaque page cursor, never a
// "return all"). `total` is the full matching count across pages.
export interface SearchWorkItemsResponse {
  items: SearchResultRow[];
  total: number;
  nextCursor: string | null;
}

// POST /api/internal/ai/similar-work-items (Story MOTIR-2694 · Subtask
// MOTIR-2697) — one SEMANTIC candidate.
//
// ⚠️ THREE FIELDS, AND THE LIST IS THE CONTRACT, not a current selection
// (`docs/decisions/plan-tree-embeddings.md` §2): `key`, `title`, `score` — no
// `descriptionMd`, no `explanationMd`, no comment, no acceptance criterion, no
// excerpt, no snippet. **Adding a fourth content field is a change to that ADR,
// not a change to this type.**
//
// The reason is the whole shape of the feature. Semantic search PROPOSES; the
// existing keyed reads (`get-item` / `get-subtree` / `search-work-items`) DISPOSE
// — so no text ever enters a planning prompt because a cosine distance happened
// to be small, and every claim that reaches a plan traces to a keyed read of the
// real record. That is what makes this an EXTENSION of the product's no-RAG
// stance rather than an abandonment of it.
//
// `title` is in the contract and is not a violation of it: a title is the item's
// IDENTITY (the string the key resolves to, and the one every keyed read returns
// first), not its content. Returning a bare key would force a second read per
// candidate purely to render a name.
export interface SimilarWorkItemRow {
  key: string; // e.g. "MOTIR-2694"
  title: string;
  /** Cosine SIMILARITY in [-1, 1] — `1 - distance`, higher is closer. The
   *  repository ranks by `<=>` DISTANCE; the conversion happens exactly once,
   *  here at the DTO boundary (ADR §6.1). */
  score: number;
}

// The semantic candidate-finder's response (ADR §6.1). `model` echoes the model
// the ranking actually ran IN — a HARD filter, not a label, since two vectors
// from different models are not comparable.
//
// `coverage` is two integers and no prose. It exists so a caller can tell "I
// searched a fully-indexed project and there is genuinely nothing" apart from "I
// searched a project that is 3% indexed" — reporting the first when the second is
// true is the exact false "nothing matches" this whole story was written to
// remove, and a candidate-finder that cannot distinguish them reintroduces it one
// layer up. `embedded` counts the project's RANKABLE rows (this model, not
// archived); `total` counts the same population before the embedding join.
//
// `{ embedded: 0, total: 0 }` is the DEGRADED reading — the embedding store could
// not be read at all — and is deliberately distinguishable from `{ embedded: 0,
// total: 419 }`, which is a real project that nothing has indexed yet.
export interface SimilarWorkItemsResponse {
  results: SimilarWorkItemRow[];
  model: string;
  coverage: { embedded: number; total: number };
}

// The MCP semantic-search response (Story MOTIR-3098 · Subtask MOTIR-3101, per
// `docs/decisions/plan-tree-embeddings.md` Amendment 2) — the SAME ranking as
// `SimilarWorkItemsResponse`, reached from TEXT instead of a vector, plus the
// one field that keeps its failure modes apart.
//
// ⚠️ `outcome` EXISTS BECAUSE AN EMPTY ARRAY MEANS THREE DIFFERENT THINGS, and
// an agent that reads the wrong one re-creates the very defect this story was
// written to remove (MOTIR-3079: a capability rebuilt because the search that
// should have found it could not). `coverage` already separates two of them and
// requires arithmetic; embedding the query from text adds a third that coverage
// cannot express at all, because when the query cannot be embedded the search
// never ran. So the discriminator is COMPUTED SERVER-SIDE and travels beside the
// raw numbers rather than instead of them:
//
//   'ranked'          — candidates found.
//   'nothing-similar' — the project IS indexed and nothing is close. An answer.
//   'not-indexed'     — the project has no vectors for this model. NOT evidence
//                       that nothing exists.
//   'unavailable'     — the query could not be embedded (no AI backend, or it is
//                       unreachable). The search DID NOT HAPPEN.
//
// `coverage` is null on `unavailable` for the same reason: nothing was counted,
// and reporting `{ embedded: 0, total: 0 }` there would be indistinguishable from
// a degraded read of a real project.
export type SemanticSearchOutcome = 'ranked' | 'nothing-similar' | 'not-indexed' | 'unavailable';

export interface SemanticSearchResponse {
  outcome: SemanticSearchOutcome;
  results: SimilarWorkItemRow[];
  /** The model the ranking ran in; null when nothing was embedded or ranked. */
  model: string | null;
  coverage: { embedded: number; total: number } | null;
  /** A readable sentence for the human half of the dual content — what state this
   *  is and, on the two non-answers, what to do instead. */
  message: string;
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
