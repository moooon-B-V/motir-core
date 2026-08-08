import { normalizeServerUrl } from './config/userConfig.js';
import { V1Transport } from './transport.js';
import { encodeFilterParam } from './adapters/filterParam.js';
import {
  toActivityAllPage,
  toDispatchItem,
  toPlanOutcome,
  toPlanSession,
  toPlanWithItems,
  toSearchPage,
  toWorkItemCount,
  toCompleteSessionResult,
  toDispatchPrompt,
  toExpandSubmitResult,
  toActivityHistoryPage,
  toCommentsPage,
  toProjectList,
  toReadyPage,
  toSprintList,
  toWhoami,
  toWorkItemDetail,
  UNASSIGNED,
} from './adapters/reads.js';

// The client core — the ONE place the CLI talks to a Motir server. Every command
// speaks to the tenant over the documented public API at `/api/v1` with a PAT
// bearer: a URL and a token are the whole client, there is no session to open,
// and auth failures all funnel into a single `AuthError`.
//
// It used to be an MCP client (story 7.9) and is not one any more — story 11.5
// moved every method onto `/api/v1` and 11.5.6 removed the tool protocol,
// `@modelcontextprotocol/sdk` and the handshake with it. The MCP surface at
// `/api/mcp` is untouched and still serves AGENTS; the CLI is simply no longer
// one of its clients. A test in `test/noSdk.test.ts` keeps it that way.
//
// Each method below names an OPERATION on the generated `/api/v1` document and
// hands the validated body to an adapter in `src/adapters/` — the only place a
// wire type is allowed to be read (ADR Q4).

/** Who a token resolves to: the caller and the workspace it is bound to. */
export interface WhoamiResult {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string } | null;
}

/** The far end of ONE per-row dependency edge (`WorkItemEdgeSummaryDto`), as the
 * MCP reads project it: `key` is the `PROD-<n>` identifier, `status` the raw
 * workflow status key. */
export interface WorkItemEdgeSummary {
  key: string;
  title: string;
  status: string;
}

/** Both directions of the `is_blocked_by` graph around one row
 * (`WorkItemDependencyEdgesDto`). The server promises both arrays are always
 * present — empty, never missing — so nothing branches on ARRAY presence; only
 * the BLOCK itself can be missing, from a server that predates it (below). */
export interface WorkItemDependencyEdges {
  blockedBy: WorkItemEdgeSummary[];
  blocks: WorkItemEdgeSummary[];
}

/**
 * Why every `dependencies` field in this mirror is OPTIONAL — the one place a
 * missing field is a shape the server really can produce.
 *
 * The CLI is versioned and PUBLISHED TO NPM independently of the server it talks
 * to, so a newer CLI routinely meets an OLDER Motir whose reads predate the edge
 * projection. Absent therefore means "this server cannot tell me the graph", and
 * every renderer degrades to the columns it can substantiate rather than drawing
 * a dependency claim it never got or crashing on a field it cannot read.
 */

/** A ready-set row (the `list_ready` `ReadyItemDto`, terminal-relevant fields).
 * Kept loose — the CLI renders, it does not re-validate the server. `key` is the
 * `PROD-<n>` identifier; the ready row carries no `type`/`estimate` column (the
 * /ready row is kind · key · title · priority · assignee).
 *
 * `dependencies` is the per-row edge block 7.9.0f / MOTIR-1842 attaches, which
 * `motir ready` renders as its `BLOCKS` column (MOTIR-1845). Optional per the
 * note above. */
export interface ReadyItemSummary {
  key: string;
  kind: string;
  title: string;
  priority: string;
  assignee?: { id: string; name: string } | null;
  dependencies?: WorkItemDependencyEdges;
}

export interface ReadyPage {
  items: ReadyItemSummary[];
  nextCursor: string | null;
}

/** A sprint row (the `list_sprints` `SprintDto`, the fields `motir status` and
 * `motir sprints` render). `sequence` is the sprint's authored order — the
 * table's sort key. `committedPoints` / `committedIssueCount` are the
 * scope-lock baseline stamped at activation (Story 4.4.2), so both are `null`
 * on a sprint that was never started, and `committedPoints` is `null` on a
 * started-but-wholly-unestimated one. */
export interface SprintSummary {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'complete';
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  sequence: number;
  issueCount: number;
  committedPoints: number | null;
  committedIssueCount: number | null;
}

export interface SprintList {
  sprints: SprintSummary[];
}

/** One project as `list_projects` reports it (lib/mcp/tools/listProjects.ts,
 * `McpProjectRow`). `key` is exactly what every other tool's `projectKey`
 * argument takes, so a resolved project passes straight on with no field-name
 * translation. */
export interface ProjectSummary {
  key: string;
  name: string;
  accessLevel: string;
}

export interface ProjectList {
  projects: ProjectSummary[];
}

/** A `search_work_items` result row (the `WorkItemListItemDto` subset the CLI
 * renders); `status` is the raw workflow status key.
 *
 * `dependencies` is the SAME block `list_ready` attaches — one seam, two tools
 * (lib/mcp/dependencyEdges.ts) — which `motir sprint` renders as its `BLOCKED BY`
 * / `BLOCKS` columns (MOTIR-1845). Note the key names do NOT follow this row's
 * own vocabulary: an edge's far end is `key` (the `PROD-<n>` identifier) even
 * though the row identifies ITSELF as `identifier`. That is the producer's shape
 * (`WorkItemEdgeSummaryDto`), pinned deliberately — a renderer shared with
 * `list_ready`'s rows can only work if both carry the edge block identically. */
export interface SearchItemSummary {
  identifier: string;
  kind: string;
  title: string;
  status: string;
  priority: string;
  dependencies?: WorkItemDependencyEdges;
}

/**
 * One page of search results.
 *
 * ⚠️ NO `total`, and its absence is a DECISION (ADR Amendment 11 Q3 · Amendment
 * 12). A collection either promises a total or it does not; this one does not,
 * because computing one means a `COUNT` under an arbitrary filter on every page
 * of every list. A caller that wants the number asks {@link
 * MotirClient.countWorkItems} for it, which is one request and says what it is.
 */
export interface SearchPage {
  items: SearchItemSummary[];
  nextCursor: string | null;
}

/**
 * The one item a dispatch picks, projected from a ready-collection row.
 *
 * `key` is the `PROD-<n>` identifier — the only way the CLI addresses an item
 * (ADR §7), and what the exclusion list holds. `status.key` lets dispatch skip a
 * redundant `todo → in_progress` flip when the item is already in progress.
 */
export interface DispatchItem {
  key: string;
  kind: string;
  title: string;
  priority: string;
  status: { key: string; category: string };
  type: string | null;
  executor: string | null;
  /**
   * READY RELATIVE TO WHAT — the branch this item's dependencies are integrated
   * on, or `null` when it is ready from the trunk (ADR Amendment 17).
   *
   * `motir batch` refuses a non-null row: it opens ONE pull request per item off
   * `main`, and a lineage item's base has not merged.
   */
  inheritedSessionBranch: string | null;
}

/** WHICH `GIT WORKFLOW` variant the server-assembled prompt carries — chosen
 * server-side from the item's inherited lineage, never selectable by the CLI
 * (`DispatchWorkflowMode`, lib/dto/dispatch.ts). */
export type DispatchWorkflowMode = 'per_item_pr' | 'session_lineage';

/**
 * One PROSE-vs-GRAPH advisory (`WorkItemProseAdvisoryDto`) — a work item the
 * dispatched card's ACCEPTANCE CRITERIA name while carrying no `blocked_by` edge
 * to it. The server sends only the `likely-missing-edge` tier here.
 *
 * ⚠️ NEVER a reason to refuse a dispatch. It is printed, and the human decides —
 * the same disposition `notReadyError` documents for a real blocker, one notch
 * softer because this one is a hint rather than a fact.
 */
export interface DispatchReferenceAdvisory {
  /**
   * The union discriminant, mirroring the server's — absent on the wire for this
   * variant, so a payload from ANY server version narrows the same way.
   */
  kind?: 'reference';
  /** The dispatched card's key — the item whose body names the reference. */
  item: string;
  /** The referenced item's key. */
  referenced: string;
  /** The referenced item's raw workflow status key (e.g. `in_review`). */
  referencedStatus: string;
  severity: string;
}

/**
 * What EVERY SHAPE advisory carries (`WorkItemProseShapeAdvisoryDto`,
 * MOTIR-2175) — a defect in the dispatched card's OWN acceptance criteria, with
 * no referenced work item at all, which is why it is a separate variant rather
 * than a severity.
 *
 * ⚠️ Also never a reason to refuse. Same disposition as above: printed, and the
 * human decides.
 *
 * ⚠️ The members below are matched by `severity`, and an UNMATCHED severity
 * prints nothing. The CLI ships separately and is routinely pointed at a NEWER
 * Motir, so a severity this build has never heard of must be silent rather than
 * print some other member's fields as `undefined` —
 * `renderDispatchAdvisories` selects known severities and lets anything else
 * fall through. Adding a member to this union is therefore not enough: it has to
 * be rendered too, or it is invisible.
 */
interface DispatchShapeAdvisoryBase {
  kind: 'shape';
  /** The dispatched card's key. */
  item: string;
  /** 1-based index of the offending criterion — where the card should be cut. */
  criterionIndex: number;
}

/** The card's criteria ask for state that exists only after its own PR merged. */
export interface DispatchOrderingAdvisory extends DispatchShapeAdvisoryBase {
  severity: 'likely-ordering-violation';
  /** The matched post-merge phrase (e.g. `once it lands`). */
  phrase: string;
}

/**
 * A criterion names a path in a repo that is not the card's `targetRepo`
 * (MOTIR-2177) — one subtask, one repo, one pull request.
 */
export interface DispatchRepoStraddleAdvisory extends DispatchShapeAdvisoryBase {
  severity: 'likely-repo-straddle';
  /** The repo-qualified path the criterion names. */
  path: string;
  /** The repo that path belongs to — never the card's own. */
  repo: string;
  /** `contradiction`: the card pins a different repo. `unpinnable`: it pins none. */
  reason: 'contradiction' | 'unpinnable';
}

/** One SHAPE advisory — narrow by `severity` once `kind === 'shape'` has. */
export type DispatchShapeAdvisory = DispatchOrderingAdvisory | DispatchRepoStraddleAdvisory;

/**
 * One advisory, either family. Narrow with `a.kind === 'shape'`; anything else —
 * including a payload from a server that predates the union — is a reference.
 */
export type DispatchAdvisory = DispatchReferenceAdvisory | DispatchShapeAdvisory;

/**
 * Narrow to the ORDERING member. A predicate rather than an inline `filter`
 * comparison, because a boolean predicate does not narrow the resulting array
 * and the renderer would then read `phrase` off the whole union.
 */
export function isOrderingAdvisory(a: DispatchAdvisory): a is DispatchOrderingAdvisory {
  return a.kind === 'shape' && a.severity === 'likely-ordering-violation';
}

/** Narrow to the REPO-STRADDLE member (MOTIR-2177). */
export function isRepoStraddleAdvisory(a: DispatchAdvisory): a is DispatchRepoStraddleAdvisory {
  return a.kind === 'shape' && a.severity === 'likely-repo-straddle';
}

/** The `dispatch_prompt` payload (`DispatchPromptDto`) — the canonical prompt
 * text plus the facts the CLI routes on before it runs the agent. */
export interface DispatchPrompt {
  key: string;
  prompt: string;
  /**
   * The item's PARENT key, or `null` for a top-level item (MOTIR-2445).
   *
   * The prompt already names it in its CONTEXT prose; this is that fact as a
   * field, so `motir auto` can title its pull request after the shared parent of
   * the cards it carried (MOTIR-2422) without parsing text or paying a request
   * per card.
   */
  parentKey: string | null;
  targetRepo: string | null;
  workflowMode: DispatchWorkflowMode;
  sessionBranch: string | null;
  /**
   * OPTIONAL on the wire, deliberately: the CLI is published separately from the
   * server and is routinely pointed at a self-hosted Motir older than itself. A
   * server predating MOTIR-2079 sends no such key, which must read as "nothing to
   * warn about" rather than a crash — so every consumer treats absent as `[]`.
   */
  advisories?: DispatchAdvisory[];
}

/**
 * What an `expand_item` SUBMIT returns (MOTIR-1825's `structuredContent`).
 *
 * Both ids address the same expansion: `planId` is the review surface
 * (`/plans/<id>`), `jobId` is what `get_plan_status` also accepts. The tool
 * returns them the instant motir-ai accepts the job — it never waits for the
 * planner — which is the whole reason an unattended loop can fire one.
 *
 * NOTE the contract this type does NOT carry: a submitted expansion produces a
 * Plan of PROPOSALS, never work items. Approval is the only path from a proposal
 * to a `work_item` row, and it happens in Motir, not here.
 */
export interface ExpandSubmitResult {
  jobId: string;
  planId: string;
}

// ── the plan-change CONVERSATION (MOTIR-1832) + the plan read (MOTIR-1837) ──
// The wire shapes `motir plan` renders. Mirrors of the server DTOs
// (`lib/dto/planChange.ts`, `lib/dto/plans.ts`), kept loose in the same spirit as
// the read rows above: the CLI renders what the tenant returns, it does not
// re-validate the server.

/** One turn on the thread, in `seq` order. `jobId` is set only on a `system`
 *  submission marker; `body` is what was typed on a `user` turn. */
export interface PlanTurn {
  id: string;
  seq: number;
  /**
   * ⚠️ THREE roles, not two. `assistant` is a real turn the planner writes (the
   * Gate-2 clarifying question, MOTIR-2222); the view model claimed two until
   * MOTIR-2341 read the union off the wire. `renderTurn` still labels anything
   * that is not `system` as "you", which mislabels an assistant turn — a
   * pre-existing gap this port made VISIBLE rather than introduced, and one
   * whose fix is a new label, so it belongs to a card that may change output.
   */
  role: 'user' | 'system' | 'assistant';
  body: string;
  jobId: string | null;
  authorId: string | null;
  createdAt: string;
}

/**
 * A planning CONVERSATION — one per project per anchor set, addressed by SCOPE
 * and never by a client-held id, which is what makes the terminal and the web
 * panel the same thread rather than two. `turns` is the FULL ordered thread (the
 * resume payload). `targetKeys` is empty on the project-wide conversation.
 */
export interface PlanSession {
  id: string;
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: PlanTurn[];
}

/**
 * What a submit returns — the job it opened and the `generating` plan bound to
 * it. The SAME handle an expansion submit answers with, and for the same
 * reason: the job has been accepted, not run.
 *
 * It used to carry the thread as it then stood. Nothing read it — the command
 * prints the two ids and either detaches or watches the plan — and the v1
 * submit does not publish one, so it is gone rather than re-fetched.
 */
export interface PlanSubmitResult {
  jobId: string;
  planId: string;
}

/** The motir-ai job behind a still-`generating` plan. `reachable: false` means
 *  motir-ai could not be ASKED (and `failure` describes that outage); `true`
 *  with a failed status means the job itself died. */
export interface PlanJobState {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null;
  reachable: boolean;
  failure: { code: string; message: string } | null;
}

/**
 * What became of a submitted planning job. `status` is the PLAN's own status
 * verbatim — there is no synthetic "failed" plan state, because a failed job
 * leaves its plan at `generating` forever. That distinction lives in `job`,
 * which is populated ONLY while generating; a bounded watch must read it.
 */
export interface PlanOutcome {
  planId: string;
  status: 'generating' | 'planned' | 'approved' | 'declined';
  origin: string;
  jobId: string | null;
  itemCount: number;
  job: PlanJobState | null;
}

/** The proposed fields of an `add` — the new node's values, which live on the
 *  proposal because no work item exists yet. */
export interface PlanProposalFields {
  title?: string;
  kind?: string;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  descriptionMd?: string | null;
}

/**
 * ONE PROPOSAL — not a work item. `workItemKey` stays null on an `add` until
 * the plan is approved in Motir, which is the only path from a proposal to a
 * row. `parentRef` / `blockedByRefs` carry either a real work-item ref or an
 * intra-plan `planItem:<id>` temp-ref.
 */
export interface PlanProposal {
  id: string;
  op: 'add' | 'modify' | 'remove';
  workItemKey: string | null;
  proposedFields: PlanProposalFields | null;
  patch: Record<string, unknown> | null;
  parentRef: string | null;
  blockedByRefs: string[];
}

/** A plan WITH the proposals it bundles — what a planning pass proposed, not
 *  just how many items it produced. */
export interface PlanWithItems {
  id: string;
  status: 'generating' | 'planned' | 'approved' | 'declined';
  title: string | null;
  summary: string | null;
  sourceJobId: string | null;
  origin: string;
  itemCount: number;
  items: PlanProposal[];
}

/** One item's outcome in a `complete_session` bulk close-out. */
export interface CompleteSessionOutcome {
  key: string;
  outcome: 'completed' | 'already_done' | 'failed';
  reason?: string | null;
}

export interface CompleteSessionResult {
  sessionBranch: string;
  results: CompleteSessionOutcome[];
}

/** A related work item as the detail aggregate carries it (the server's
 * `WorkItemSummaryDto` — the fields a terminal row renders). Used for the parent
 * chain, the children, and every dependency edge. */
export interface WorkItemSummary {
  identifier: string;
  kind: string;
  title: string;
  status: string;
}

/** ONE dependency / relationship EDGE (`RelationshipLinkDto`): the linked item
 * plus the `work_item_link.id` of the edge itself. */
export interface WorkItemLink {
  item: WorkItemSummary;
}

/**
 * A CHILD row of the detail aggregate: a summary PLUS the sibling dependency
 * block `get_work_item` attaches (MOTIR-1848), which `motir show` folds into
 * build-order waves.
 *
 * `dependencies` is OPTIONAL for the reason given above {@link ReadyItemSummary}:
 * absent means "this server cannot tell me the graph", and `show` falls back to
 * the plain children table rather than drawing a wave order it cannot
 * substantiate.
 */
export interface WorkItemChild extends WorkItemSummary {
  dependencies?: WorkItemDependencyEdges;
}

/**
 * The `get_work_item` aggregate (`IssueDetailDto`) — the item, its lineage, its
 * dependency edges, and the server's own readiness verdict (dependency-only —
 * see the readiness rule).
 *
 * This mirrors only the fields the terminal renders. It began as the two-field
 * slice `motir run` gates on (status + readiness) and was widened for `motir
 * show` (7.9.13), which needed the rest of what the tool already returned — no
 * server change, just a wider mirror. The groups below are NOT optional: the
 * tool returns the whole aggregate on every call, so a renderer that defended
 * against a missing `children` would be defending against a shape the server
 * cannot produce. Heavier fields the CLI does not render (`workflow`, `labels`,
 * `components`, `customFields`, `duplicates`, `clones`) are deliberately left
 * out — `--json` prints the tool payload itself, so nothing is lost by omitting
 * them here.
 */
/** An ancestor, as the LINEAGE renders it. v1 sends the parent chain as KEYS,
 *  and `renderLineage` reads `.identifier` and nothing else — so this is the
 *  whole shape, rather than a summary with three invented fields. */
export interface AncestorRef {
  identifier: string;
}

export interface WorkItemDetail {
  item: {
    identifier: string;
    kind: string;
    title: string;
    status: string;
    priority: string;
    assigneeId: string | null;
    type: string | null;
    executor: string | null;
    storyPoints: number | null;
    estimateMinutes: number | null;
    targetRepo: string | null;
    sprintId: string | null;
    descriptionMd: string | null;
  };
  /** The full parent chain, ordered root→self and EXCLUDING the item itself. */
  ancestors: AncestorRef[];
  children: WorkItemChild[];
  blockedBy: WorkItemLink[];
  blocks: WorkItemLink[];
  relatesTo: WorkItemLink[];
  readiness: {
    ready: boolean;
    openBlockers: WorkItemSummary[];
    /** The nearest ancestor whose own blockers are still open — the CASCADE
     * cause. A cascade-blocked item must never read as a bare "blocked".
     * `renderReadinessLine` prints its key and its title, which is all v1
     * publishes and all this needs to be. */
    blockedByAncestor: { identifier: string; title: string } | null;
  };
}

// ── the ACTIVITY stream (MOTIR-1999's tool · MOTIR-2000's consumer) ──────────
//
// The mirror of `get_work_item_activity`'s three page shapes (`lib/dto/activity.ts`
// + `lib/dto/comments.ts`), narrowed to the fields the terminal renders.
//
// LOOSER than the server's discriminated unions ON PURPOSE, and for the reason
// the optional `dependencies` block above exists: the CLI is published to npm on
// its own release train, so it routinely meets a Motir NEWER than itself. The
// server's `ActivityEntryPartDto` is a closed union THERE and an open one HERE —
// a part kind (or a value type) this build has never heard of must render as its
// generic form, never crash the read. Typing `kind` as `string` with optional
// members is what makes the renderer's fallback branch reachable instead of
// unreachable-by-type.

/** One side of a change in its display form (`ActivityValueDto`) — the resolved
 *  label, with the stored id kept for the deleted-referent case. */
export interface ActivityValue {
  type: string;
  text?: string;
  key?: string;
  label?: string | null;
  userId?: string;
  name?: string | null;
  date?: string;
  sprintId?: string;
  workItemId?: string;
  identifier?: string | null;
}

/** One renderable piece of a history entry (`ActivityEntryPartDto`). `from` /
 *  `to` are `ActivityValue` on a `field` part and plain strings on a `generic`
 *  one — the producer's own shape, mirrored rather than harmonized. */
export interface ActivityPart {
  kind: string;
  field?: string;
  from?: ActivityValue | string | null;
  to?: ActivityValue | string | null;
  op?: string;
  linkKind?: string;
  target?: ActivityValue;
  items?: string[];
  author?: ActivityValue;
  replyCount?: number;
  key?: string;
}

/** One history entry — a displayable revision, its actor resolved. */
export interface ActivityEntry {
  id: string;
  changeKind: string;
  /** ISO-8601. */
  changedAt: string;
  actor: { userId: string; name: string | null };
  parts: ActivityPart[];
}

/** One comment (`CommentDTO`). `bodyMd` is the FULL Markdown — the tool never
 *  truncates it and neither does the renderer. */
export interface ActivityComment {
  id: string;
  author: { id: string; name: string };
  bodyMd: string;
  /** Set on a body edit; null when never edited. */
  editedAt: string | null;
  createdAt: string;
}

/** A root comment with its single-level replies riding along. */
export interface ActivityCommentThread extends ActivityComment {
  replies: ActivityComment[];
}

/** One entry of the merged stream: the two sources keep their native shapes
 *  under a discriminated `type` (`ActivityAllEntryDto`). */
export type ActivityStreamEntry =
  | { type: 'comment'; thread: ActivityCommentThread }
  | { type: 'history'; entry: ActivityEntry };

/** One page of the merged stream (`ActivityAllPageDto`). A page may come back
 *  SHORT with a non-null `nextCursor` — documented normal for this view. */
export interface ActivityAllPage {
  entries: ActivityStreamEntry[];
  nextCursor: string | null;
  totalComments: number;
  totalChanges: number;
}

/** One page of the comments view (`CommentsPageDTO`). `totalCount` counts every
 *  comment, replies included; `order` is the direction this window was read in. */
export interface CommentsPage {
  threads: ActivityCommentThread[];
  nextCursor: string | null;
  totalCount: number;
  order: 'asc' | 'desc';
}

/** One page of the history view (`ActivityHistoryPageDto`). No CLI flag selects
 *  it today (`show` exposes `--activity` / `--comments`), but the client mirrors
 *  the tool's whole argument surface rather than a subset of it. */
export interface ActivityHistoryPage {
  entries: ActivityEntry[];
  nextCursor: string | null;
  totalCount: number;
}

/** The three streams the tool serves, mirroring the Activity section's tabs. */
export type ActivityView = 'all' | 'comments' | 'history';

/** One page of whichever view was asked for. */
export type ActivityPage = ActivityAllPage | CommentsPage | ActivityHistoryPage;

/** One FilterAST condition in the tool's self-documenting expanded form. */
export interface SearchFilterCondition {
  field: string;
  operator: string;
  value: unknown;
}

/** The versioned FilterAST envelope `search_work_items` accepts — the SAME
 * grammar the /issues `?filter=` URL + saved filters carry (`version` is the
 * server's `FILTER_PARAM_VERSION`). */
export interface SearchFilterEnvelope {
  version: string;
  combinator: 'and' | 'or';
  conditions: SearchFilterCondition[];
}

export interface MotirClientOptions {
  serverUrl: string;
  token: string;
}

export class MotirClient {
  private readonly serverUrl: string;
  /**
   * The `/api/v1` transport EVERY method goes through.
   *
   * Built in the constructor and immediately usable: it holds no connection,
   * only a base URL and a bearer. There is nothing to open and nothing to
   * close — the client that had a `connect()` / `close()` bracket, an SDK
   * session and a tool protocol was retired with the MCP transport (11.5.6).
   */
  private readonly v1: V1Transport;

  constructor(opts: MotirClientOptions) {
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.v1 = new V1Transport({ serverUrl: this.serverUrl, token: opts.token });
  }

  /**
   * Walk a cursor-paged collection to exhaustion, returning every page.
   *
   * For the two reads whose VIEW MODEL is a whole list rather than a page —
   * `listProjects` and `listSprints`, both of which the MCP tool answered in one
   * shot. The cursor is echoed exactly as received and never inspected.
   */
  private async walkPages<P extends { nextCursor: string | null }>(
    fetchPage: (cursor: string | undefined) => Promise<P>,
  ): Promise<P[]> {
    const pages: P[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      pages.push(page);
      // ⚠️ Echoed, never inspected — the cursor is opaque and scoped to its own
      // collection (ADR §5).
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return pages;
  }

  // ── The typed methods ────────────────────────────────────────────────────
  // Each names one `/api/v1` operation (or a small fixed set of them) and hands
  // the validated body to an adapter. Listing/auth/link commands use `whoami`;
  // the read and dispatch commands use the rest.

  /**
   * Who this token is, and the workspace it is bound to.
   *
   * TWO reads: v1 splits identity from workspace description, and the adapter
   * matches them on `workspaceId` rather than assuming a position.
   */
  async whoami(): Promise<WhoamiResult> {
    const [me, workspaces] = await Promise.all([
      this.v1.request('getMe'),
      this.v1.request('listWorkspaces'),
    ]);
    return toWhoami(me, workspaces);
  }

  /** The token workspace's browsable projects (MOTIR-1879). Takes no arguments:
   * the workspace is the one the PAT is bound to. An empty workspace is an
   * EMPTY LIST, not an error. */
  async listProjects(): Promise<ProjectList> {
    // The view model has no cursor, so this walks the collection to exhaustion —
    // the same whole-list answer the MCP tool gave. Projects are bounded by the
    // workspace, and the alternative would be changing every caller's shape.
    return toProjectList(
      await this.walkPages((cursor) =>
        this.v1.request('listProjects', { query: { ...(cursor ? { cursor } : {}) } }),
      ),
    );
  }

  listReady(args: {
    projectKey: string;
    kinds?: string[];
    priority?: string[];
    assigneeId?: string | null;
    cursor?: string;
    limit?: number;
  }): Promise<ReadyPage> {
    // `assigneeId` is TRI-STATE on the wire: absent means any assignee, and the
    // literal `none` means the unassigned bucket. `null` here IS that bucket, so
    // it must become the literal rather than being dropped as "no value" — which
    // would silently widen the filter to every assignee.
    return this.v1
      .request('getProjectReadySet', {
        path: { projectKey: args.projectKey },
        query: {
          ...(args.kinds ? { kind: args.kinds } : {}),
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.assigneeId === undefined
            ? {}
            : { assigneeId: args.assigneeId === null ? UNASSIGNED : args.assigneeId }),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
      })
      .then(toReadyPage);
  }

  /**
   * The next item to dispatch — the highest-ranked ready row not held out.
   *
   * ⚠️ There is no `next_ready` OPERATION on `/api/v1`, and that is the right
   * shape rather than a gap. `lib/api/v1/ready/schema.ts` states the dispatch
   * rank as contract — `(type asc, priority desc, key asc)` — and says
   * `items[0]` is what an agent should take next. "Next" is therefore a pick
   * from a ranked page: the server ranks, the client skips what it has already
   * tried, and nothing here re-sorts.
   *
   * Held out by KEY. The row id the MCP tool addressed by is gone from this
   * client entirely — it was that tool's addressing scheme, and the persisted
   * exclusion list has been key-based since MOTIR-2338, which had to translate
   * keys back into ids on every ask. That round trip goes with it.
   *
   * FOLLOWS the cursor. A whole page of held-out rows is ordinary on a resumed
   * run, and stopping at page one would report "drained" to a loop that still
   * had work.
   */
  async nextReady(args: {
    projectKey: string;
    kinds?: string[];
    excludeKeys?: readonly string[];
  }): Promise<{ item: DispatchItem | null }> {
    const excluded = new Set((args.excludeKeys ?? []).map((key) => key.toUpperCase()));
    for await (const item of this.walkReady(args)) {
      if (!excluded.has(item.key.toUpperCase())) return { item };
    }
    return { item: null };
  }

  /**
   * EVERY ready row a run may take, in rank order — `motir batch`'s snapshot.
   *
   * The whole set rather than one item, because a snapshot is a frozen
   * BOUNDARY: what was ready when the run started. It used to be built by
   * asking `next_ready` once per item with a growing exclusion list — N
   * requests for N items — and is one page walk now.
   */
  async listReadyForDispatch(args: {
    projectKey: string;
    kinds?: string[];
  }): Promise<DispatchItem[]> {
    const items: DispatchItem[] = [];
    for await (const item of this.walkReady(args)) items.push(item);
    return items;
  }

  /**
   * The ready collection, page by page, in the server's rank — ADAPTED.
   *
   * ⚠️ It yields the VIEW MODEL, not the wire row, and that is the Q4 boundary
   * rather than a preference. Yielding `SuccessBody<'getProjectReadySet'>
   * ['items'][number]` would put a generated type on a signature in this file,
   * where the ADR allows one only inside `src/transport.ts` and `src/adapters/`
   * — and a derived type reads as innocuous precisely because it does not look
   * like an import. `test/architecture.test.ts` fails on either form.
   */
  private async *walkReady(args: {
    projectKey: string;
    kinds?: string[];
  }): AsyncGenerator<DispatchItem> {
    let cursor: string | undefined;
    do {
      const body = await this.v1.request('getProjectReadySet', {
        path: { projectKey: args.projectKey },
        query: {
          ...(args.kinds ? { kind: args.kinds } : {}),
          ...(cursor ? { cursor } : {}),
        },
      });
      for (const row of body.items) yield toDispatchItem(row);
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
  }

  async getWorkItem(key: string): Promise<WorkItemDetail> {
    return (await this.readWorkItem(key)).detail;
  }

  /**
   * The detail read, returning BOTH the view model and the payload it was
   * mapped from.
   *
   * `--json` emits the server's own resource rather than the CLI's narrowed
   * view of it (ADR Amendment 16): the view model deliberately omits fields
   * nothing renders, and `--json` is the escape hatch that makes that omission
   * safe. The payload is typed `unknown` on purpose — a command needs BYTES
   * here, not a shape, and typing it would put a generated wire type outside
   * the adapter boundary that Q4 draws.
   */
  async readWorkItem(key: string): Promise<{ detail: WorkItemDetail; payload: unknown }> {
    const body = await this.v1.request('getWorkItem', { path: { key } });
    return { detail: toWorkItemDetail(body), payload: body };
  }

  /**
   * ONE page of a work item's discussion + change trail (MOTIR-1999).
   *
   * A SECOND call, made only when `motir show` is asked for it: the default read
   * stays one round-trip, so a card with two hundred comments never slows down
   * `show` or the dispatch path that leans on it.
   *
   * `cursor` and `order` are pass-through in both directions — the `all` cursor
   * is an OPAQUE composite carrying both sources' positions, so the CLI must
   * never construct, parse or merge one. Omitting `order` leaves each view on
   * its own shipped default rather than the client inventing one.
   */
  async getWorkItemActivity(args: {
    key: string;
    view?: ActivityView;
    cursor?: string;
    order?: 'asc' | 'desc';
  }): Promise<ActivityPage> {
    return (await this.readWorkItemActivity(args)).page;
  }

  /** The activity read, returning both the page and its payload — see
   *  {@link readWorkItem} for why `--json` needs the second. */
  async readWorkItemActivity(args: {
    key: string;
    view?: ActivityView;
    cursor?: string;
    order?: 'asc' | 'desc';
  }): Promise<{ page: ActivityPage; payload: unknown }> {
    const view = args.view ?? 'all';
    // ONE operation serves all three views, so a cursor stays scoped to the view
    // that issued it and the two per-source totals arrive from the same place.
    const body = await this.v1.request('getWorkItemActivity', {
      path: { key: args.key },
      query: {
        view,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.order ? { order: args.order } : {}),
      },
    });
    const page =
      view === 'comments'
        ? toCommentsPage(body, args.order ?? 'asc')
        : view === 'history'
          ? toActivityHistoryPage(body)
          : toActivityAllPage(body);
    return { page, payload: body };
  }

  /**
   * Move one item to a status.
   *
   * Returns nothing, where the MCP wrapper returned `unknown`. The v1 operation
   * answers with the item at its new status, and no caller reads it — all four
   * call sites `await` the promise for its EFFECT. Handing back a body nothing
   * consumes would put a wire shape in reach of a renderer without a mapper
   * between them, which is the boundary this port exists to establish.
   *
   * An ILLEGAL transition is still fully diagnosable: it comes back as a 422
   * whose envelope carries the allowed targets, and the transport raises it
   * before this method returns.
   */
  async transitionStatus(args: { key: string; status: string }): Promise<void> {
    await this.v1.request('transitionWorkItem', {
      path: { key: args.key },
      body: { status: args.status },
    });
  }

  /**
   * The CANONICAL, server-generated prompt for one item (MOTIR-1802). A pure
   * READ — it never claims the item or moves its status, so re-printing an
   * in-progress item's prompt is safe. The CLI prints this text verbatim; it
   * never assembles a prompt grammar of its own.
   *
   * `sessionBranch` is the unattended-run SEED (`motir auto`, MOTIR-882): the
   * branch to use when the item carries no lineage of its own. The server treats
   * it as a fallback only — an item already on a lineage keeps that one — so the
   * CLI can start a run's first item on the run's branch without ever being able
   * to redirect an existing chain.
   */
  async dispatchPrompt(
    key: string,
    opts: { sessionBranch?: string | null } = {},
  ): Promise<DispatchPrompt> {
    // A GET, which is what a pure read should have looked like all along: the
    // MCP tool took a POST-shaped call because that is the only shape MCP has.
    const body = await this.v1.request('getWorkItemDispatchPrompt', {
      path: { key },
      query: { ...(opts.sessionBranch ? { sessionBranch: opts.sessionBranch } : {}) },
    });
    return toDispatchPrompt(body);
  }

  /** Record an item's work as integrated on a session branch (7.8.11): moves it
   * to `in_review` AND stamps `session_branch` in one transaction. */
  async markIntegrated(args: {
    key: string;
    sessionBranch: string;
    implementationHarness?: string;
    /** The model the agent SELF-REPORTED (MOTIR-2419). Omitted when it reported
     *  none — the field is left null rather than filled with a guess. */
    implementationModel?: string | null;
  }): Promise<void> {
    await this.v1.request('recordWorkItemIntegration', {
      path: { key: args.key },
      body: {
        sessionBranch: args.sessionBranch,
        ...(args.implementationHarness === undefined
          ? {}
          : { implementationHarness: args.implementationHarness }),
        ...(args.implementationModel === undefined || args.implementationModel === null
          ? {}
          : { implementationModel: args.implementationModel }),
      },
    });
  }

  /** Bulk close-out for a merged session PR (7.8.11): every item recorded on
   * the branch → done, `session_branch` cleared, with per-item outcomes. */
  async completeSession(args: {
    sessionBranch: string;
    implementationHarness?: string;
    /** The one axis the close-out actually knows (MOTIR-2447). Sent alone, it
     *  stamps a lane that never reported provenance without disturbing the
     *  harness and model an integration already recorded. */
    implementationSource?: 'byok' | 'manual';
  }): Promise<CompleteSessionResult> {
    const body = await this.v1.request('completeSession', {
      body: {
        sessionBranch: args.sessionBranch,
        ...(args.implementationHarness === undefined
          ? {}
          : { implementationHarness: args.implementationHarness }),
        ...(args.implementationSource === undefined
          ? {}
          : { implementationSource: args.implementationSource }),
      },
    });
    return toCompleteSessionResult(body);
  }

  /**
   * Submit an AI expansion of one CONTAINER item (MOTIR-1825) and return the
   * moment the job is accepted — `{ jobId, planId }`, no streaming, no poll.
   *
   * The one operation on this client that answers 202 rather than 200, and the
   * distinction is load-bearing: the body describes a job that has been QUEUED,
   * not work that has been done. Nothing here waits for the planner.
   *
   * Firing this does NOT grow the tree. `motir auto --include-planning` calls it
   * for an unexpanded epic/story and moves on; what comes back is a plan awaiting
   * a human's approval in Motir. And because a submit SPENDS the token owner's
   * AI credits, it is never retried blindly — a timeout here is not a licence to
   * send it twice.
   */
  async expandItem(key: string): Promise<ExpandSubmitResult> {
    const body = await this.v1.request('submitWorkItemExpansion', { path: { key } });
    return toExpandSubmitResult(body);
  }

  /**
   * Open — or RESUME — the planning conversation for a scope, and read its
   * thread (MOTIR-1832).
   *
   * Addressed by SCOPE (`projectKey` + optional `targetKeys`), never by a
   * session id: re-opening the same anchor set returns the SAME row the web
   * panel is looking at, so the CLI cannot fork a second conversation about the
   * same items. Opening submits nothing and costs nothing.
   */
  async openPlanSession(args: { projectKey: string; targetKeys?: string[] }): Promise<PlanSession> {
    return toPlanSession(
      await this.v1.request('openPlanSession', {
        path: { projectKey: args.projectKey },
        body: { ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}) },
      }),
    );
  }

  /**
   * Add ONE turn to the conversation. APPENDING IS NOT SUBMITTING — the turn is
   * server-side the moment this returns (so quitting can never lose it) and no
   * job starts, no credits are spent, and no work item changes.
   */
  async appendPlanTurn(args: {
    projectKey: string;
    targetKeys?: string[];
    body: string;
  }): Promise<PlanSession> {
    return toPlanSession(
      await this.v1.request('appendPlanTurn', {
        path: { projectKey: args.projectKey },
        body: { body: args.body, ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}) },
      }),
    );
  }

  /**
   * Send the thread's ACCUMULATED intent — every turn, in order — as ONE change,
   * returning `{ jobId, planId }` the moment the job is accepted.
   *
   * This does NOT create work items: the job produces a plan of PROPOSALS, and
   * approving that plan in Motir is the only thing that turns one into a work
   * item. A thread with no turns is refused by the server; a failed submit
   * leaves the thread intact.
   */
  async submitPlanSession(args: {
    projectKey: string;
    targetKeys?: string[];
  }): Promise<PlanSubmitResult> {
    // A 202. The handle comes back the moment the job is ACCEPTED; nothing here
    // waits for the planner, which is what keeps `--detach` honest and the
    // watched path a poll the command owns rather than a hang inside the client.
    const handle = await this.v1.request('submitPlanSession', {
      path: { projectKey: args.projectKey },
      body: { ...(args.targetKeys ? { targetKeys: args.targetKeys } : {}) },
    });
    return { jobId: handle.jobId, planId: handle.planId };
  }

  /** What became of a submitted planning job (MOTIR-1825) — the plan's status
   *  AND, while it is still generating, whether the job is alive or already
   *  dead (a failed job leaves the plan generating forever). */
  async getPlanStatus(args: { planId: string }): Promise<PlanOutcome> {
    return toPlanOutcome(await this.v1.request('getPlanStatus', { path: { planId: args.planId } }));
  }

  /** Read a plan WITH its proposals (MOTIR-1837) — what was proposed, not just
   *  how many. Still PROPOSALS: nothing here exists in the tree. */
  async getPlan(args: { planId: string }): Promise<PlanWithItems> {
    return toPlanWithItems(await this.v1.request('getPlan', { path: { planId: args.planId } }));
  }

  async listSprints(args: { projectKey: string }): Promise<SprintList> {
    // Walked to exhaustion for the reason `listProjects` gives: the view model
    // is a whole list, and a sprint set is bounded by its project.
    return toSprintList(
      await this.walkPages((cursor) =>
        this.v1.request('listProjectSprints', {
          path: { projectKey: args.projectKey },
          query: { ...(cursor ? { cursor } : {}) },
        }),
      ),
    );
  }

  /**
   * One page of a project's work items, narrowed by a filter.
   *
   * The filter rides as `?filter=`, the SAME carrier the product's own list
   * views and saved filters use, so `motir sprint` and the web app cannot
   * disagree about what is in a sprint — they run the same expression through
   * the same registry.
   */
  async searchWorkItems(args: {
    projectKey: string;
    filter?: SearchFilterEnvelope;
    cursor?: string;
    limit?: number;
  }): Promise<SearchPage> {
    return toSearchPage(
      await this.v1.request('listProjectWorkItems', {
        path: { projectKey: args.projectKey },
        query: {
          ...(args.filter ? { filter: encodeFilterParam(args.filter) } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
      }),
    );
  }

  /**
   * How many work items match — the ONLY way this client learns a count.
   *
   * It replaces a pattern that had accumulated rather than been designed: three
   * call sites ran a `limit: 1` SEARCH, threw the row away, and read the total,
   * because the MCP tool's offset paging made a count free. None of them was a
   * search. Each is one request now, and a project with ten thousand items
   * costs the same as one with ten.
   */
  async countWorkItems(args: {
    projectKey: string;
    filter?: SearchFilterEnvelope;
  }): Promise<number> {
    return toWorkItemCount(
      await this.v1.request('countProjectWorkItems', {
        path: { projectKey: args.projectKey },
        query: { ...(args.filter ? { filter: encodeFilterParam(args.filter) } : {}) },
      }),
    );
  }
}
