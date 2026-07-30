import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AuthError, CliError } from './errors.js';
import { normalizeServerUrl } from './config/userConfig.js';
import { CLI_VERSION } from './version.js';

// The MCP client core — the ONE place the CLI talks to a Motir server. Every
// command speaks to the tenant through the streamable-HTTP `/api/mcp` endpoint
// with a PAT bearer (story-7.9 header: the CLI is an MCP client only, no
// parallel REST path, one auth path). Typed wrappers over the tools the CLI
// consumes live here; auth failures all funnel into a single `AuthError`.
//
// The dispatch/read tools the wrappers below call land across 7.8.5 / 7.8.6 /
// 7.8.10; this scaffold (7.9.1) defines the typed client surface that 7.9.2
// (read commands) and 7.9.3 (dispatch) consume. `list_ready` / `next_ready` /
// `get_work_item` / `whoami` exist today; the rest resolve once their 7.8 tool
// merges (the wrapper just names the tool — no client change needed then).

/** The shape `whoami` returns (lib/mcp/tools/whoami.ts structuredContent). */
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
  id: string;
  name: string;
  slug: string;
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

export interface SearchPage {
  items: SearchItemSummary[];
  total: number;
  nextCursor: string | null;
}

/**
 * The `next_ready` dispatch payload (`ReadyItemDispatchDto`, the fields the CLI
 * actually routes on). `id` is the row id `excludeIds` takes; `key` is the
 * `PROD-<n>` identifier every other tool takes. `status.key` lets dispatch skip
 * a redundant `todo → in_progress` flip when the item is already in progress.
 */
export interface DispatchItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  priority: string;
  status: { key: string; category: string };
  type: string | null;
  executor: string | null;
  targetRepo: string | null;
  sessionBranch: string | null;
}

/** WHICH `GIT WORKFLOW` variant the server-assembled prompt carries — chosen
 * server-side from the item's inherited lineage, never selectable by the CLI
 * (`DispatchWorkflowMode`, lib/dto/dispatch.ts). */
export type DispatchWorkflowMode = 'per_item_pr' | 'session_lineage';

/** The `dispatch_prompt` payload (`DispatchPromptDto`) — the canonical prompt
 * text plus the facts the CLI routes on before it runs the agent. */
export interface DispatchPrompt {
  key: string;
  prompt: string;
  targetRepo: string | null;
  workflowMode: DispatchWorkflowMode;
  sessionBranch: string | null;
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
  role: 'user' | 'system';
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
  projectId: string;
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: PlanTurn[];
}

/** What a submit returns — the job it opened, the `generating` plan bound to it,
 *  and the thread as it now stands (its new `system` marker turn included). */
export interface PlanSubmitResult {
  jobId: string;
  planId: string;
  session: PlanSession;
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
  projectId: string;
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
 * ONE PROPOSAL — not a work item. `workItemId` stays null on an `add` until the
 * plan is approved in Motir, which is the only path from a proposal to a row.
 * `parentRef` / `blockedByRefs` carry either a real work-item id or an
 * intra-plan `planItem:<id>` temp-ref.
 */
export interface PlanProposal {
  id: string;
  op: 'add' | 'modify' | 'remove';
  workItemId: string | null;
  proposedFields: PlanProposalFields | null;
  patch: Record<string, unknown> | null;
  parentRef: string | null;
  blockedByRefs: string[];
}

/** A plan WITH the proposals it bundles — what a planning pass proposed, not
 *  just how many items it produced. */
export interface PlanWithItems {
  id: string;
  projectId: string;
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
  linkId: string;
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
export interface WorkItemDetail {
  item: {
    id: string;
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
  ancestors: WorkItemSummary[];
  parent: WorkItemSummary | null;
  children: WorkItemChild[];
  blockedBy: WorkItemLink[];
  blocks: WorkItemLink[];
  relatesTo: WorkItemLink[];
  readiness: {
    ready: boolean;
    openBlockers: WorkItemSummary[];
    /** The nearest ancestor whose own blockers are still open — the CASCADE
     * cause. A cascade-blocked item must never read as a bare "blocked". */
    blockedByAncestor: WorkItemSummary | null;
  };
}

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

interface ToolTextPart {
  type: string;
  text?: string;
}

interface ToolCallOutcome {
  isError?: boolean;
  content?: ToolTextPart[];
  structuredContent?: unknown;
}

/** Join the text parts of a tool result into one string (the human block / the
 * `code: message` an error tool carries). */
function textOf(result: ToolCallOutcome): string {
  return (result.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 401;
  // The transport surfaces a 401 before the JSON-RPC layer; some paths wrap it
  // in a plain Error whose message carries the status — match defensively so a
  // revoked token always reads as an auth failure, never a generic crash.
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthorized/i.test(message);
}

/** The MCP `/api/mcp` URL for a server base. */
export function mcpEndpoint(serverUrl: string): URL {
  return new URL('/api/mcp', normalizeServerUrl(serverUrl) + '/');
}

export class MotirClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(opts: MotirClientOptions) {
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.token = opts.token;
  }

  /** Open the connection. A 401 (bad/revoked/expired PAT) → {@link AuthError}. */
  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StreamableHTTPClientTransport(mcpEndpoint(this.serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    const client = new Client({ name: 'motir-cli', version: CLI_VERSION });
    try {
      await client.connect(transport);
    } catch (err) {
      if (isUnauthorized(err)) throw new AuthError();
      throw new CliError(`Could not reach the Motir server at ${this.serverUrl}: ${errMsg(err)}`);
    }
    this.client = client;
    this.transport = transport;
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.transport?.close();
    this.client = null;
    this.transport = null;
  }

  private requireClient(): Client {
    if (!this.client) throw new CliError('MCP client used before connect().');
    return this.client;
  }

  /** The server's advertised tool names — the `auth login` validation probe. */
  async listToolNames(): Promise<string[]> {
    try {
      const { tools } = await this.requireClient().listTools();
      return tools.map((t) => t.name);
    } catch (err) {
      throw this.mapCallError(err);
    }
  }

  /**
   * Call a tool and return its `structuredContent` typed as `T`. A tool that
   * comes back `isError` throws a {@link CliError} carrying the tool's own
   * `code: message` text — never a swallowed JSON-RPC error. Unauthorized →
   * {@link AuthError}.
   */
  private async callStructured<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    let result: ToolCallOutcome;
    try {
      result = (await this.requireClient().callTool({
        name,
        arguments: args,
      })) as ToolCallOutcome;
    } catch (err) {
      throw this.mapCallError(err);
    }
    if (result.isError) {
      throw new CliError(textOf(result) || `Tool ${name} failed.`);
    }
    return result.structuredContent as T;
  }

  private mapCallError(err: unknown): CliError {
    if (err instanceof CliError) return err;
    if (isUnauthorized(err)) return new AuthError();
    return new CliError(errMsg(err));
  }

  // ── Typed tool wrappers ──────────────────────────────────────────────────
  // These name the MCP tools the CLI consumes. Listing/auth/link commands use
  // `whoami`; the read (7.9.2) and dispatch (7.9.3) commands use the rest.

  whoami(): Promise<WhoamiResult> {
    return this.callStructured<WhoamiResult>('whoami');
  }

  /** The token workspace's browsable projects (MOTIR-1879). Takes no arguments:
   * the workspace is the one the PAT is bound to. An empty workspace is an
   * EMPTY LIST, not an error. */
  listProjects(): Promise<ProjectList> {
    return this.callStructured<ProjectList>('list_projects');
  }

  listReady(args: {
    projectKey: string;
    kinds?: string[];
    priority?: string[];
    assigneeId?: string | null;
    cursor?: string;
    limit?: number;
  }): Promise<ReadyPage> {
    return this.callStructured<ReadyPage>('list_ready', { ...args });
  }

  nextReady(args: {
    projectKey: string;
    kinds?: string[];
    excludeIds?: string[];
  }): Promise<{ item: DispatchItem | null }> {
    return this.callStructured('next_ready', { ...args });
  }

  getWorkItem(key: string): Promise<WorkItemDetail> {
    return this.callStructured<WorkItemDetail>('get_work_item', { key });
  }

  transitionStatus(args: { key: string; status: string }): Promise<unknown> {
    return this.callStructured('transition_status', { ...args });
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
  dispatchPrompt(
    key: string,
    opts: { sessionBranch?: string | null } = {},
  ): Promise<DispatchPrompt> {
    return this.callStructured<DispatchPrompt>('dispatch_prompt', {
      key,
      ...(opts.sessionBranch ? { sessionBranch: opts.sessionBranch } : {}),
    });
  }

  /** Record an item's work as integrated on a session branch (7.8.11): moves it
   * to `in_review` AND stamps `session_branch` in one transaction. */
  markIntegrated(args: {
    key: string;
    sessionBranch: string;
    implementationHarness?: string;
  }): Promise<unknown> {
    return this.callStructured('mark_integrated', { ...args });
  }

  /** Bulk close-out for a merged session PR (7.8.11): every item recorded on
   * the branch → done, `session_branch` cleared, with per-item outcomes. */
  completeSession(args: {
    sessionBranch: string;
    implementationHarness?: string;
  }): Promise<CompleteSessionResult> {
    return this.callStructured<CompleteSessionResult>('complete_session', { ...args });
  }

  /**
   * Submit an AI expansion of one CONTAINER item (MOTIR-1825) and return the
   * moment the job is accepted — `{ jobId, planId }`, no streaming, no poll.
   *
   * There is deliberately no REST fallback here: expansion also has a
   * cookie-authed `POST /api/ai/expand`, but the CLI is an MCP client only (the
   * Story 7.9 header — one auth path), so the tool IS the mechanism.
   *
   * Firing this does NOT grow the tree. `motir auto --include-planning` calls it
   * for an unexpanded epic/story and moves on; what comes back is a plan awaiting
   * a human's approval in Motir.
   */
  expandItem(key: string): Promise<ExpandSubmitResult> {
    return this.callStructured<ExpandSubmitResult>('expand_item', { key });
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
  openPlanSession(args: { projectKey: string; targetKeys?: string[] }): Promise<PlanSession> {
    return this.callStructured<PlanSession>('open_plan_session', { ...args });
  }

  /**
   * Add ONE turn to the conversation. APPENDING IS NOT SUBMITTING — the turn is
   * server-side the moment this returns (so quitting can never lose it) and no
   * job starts, no credits are spent, and no work item changes.
   */
  appendPlanTurn(args: {
    projectKey: string;
    targetKeys?: string[];
    body: string;
  }): Promise<PlanSession> {
    return this.callStructured<PlanSession>('append_plan_turn', { ...args });
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
  submitPlanSession(args: {
    projectKey: string;
    targetKeys?: string[];
  }): Promise<PlanSubmitResult> {
    return this.callStructured<PlanSubmitResult>('submit_plan_session', { ...args });
  }

  /** What became of a submitted planning job (MOTIR-1825) — the plan's status
   *  AND, while it is still generating, whether the job is alive or already
   *  dead (a failed job leaves the plan generating forever). */
  getPlanStatus(args: { planId: string }): Promise<PlanOutcome> {
    return this.callStructured<PlanOutcome>('get_plan_status', { ...args });
  }

  /** Read a plan WITH its proposals (MOTIR-1837) — what was proposed, not just
   *  how many. Still PROPOSALS: nothing here exists in the tree. */
  getPlan(args: { planId: string }): Promise<PlanWithItems> {
    return this.callStructured<PlanWithItems>('get_plan', { ...args });
  }

  listSprints(args: { projectKey: string }): Promise<SprintList> {
    return this.callStructured<SprintList>('list_sprints', { ...args });
  }

  searchWorkItems(args: {
    projectKey: string;
    filter?: SearchFilterEnvelope;
    cursor?: string;
    limit?: number;
  }): Promise<SearchPage> {
    return this.callStructured<SearchPage>('search_work_items', { ...args });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
