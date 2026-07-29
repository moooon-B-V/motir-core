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

/** A ready-set row (the `list_ready` `ReadyItemDto`, terminal-relevant fields).
 * Kept loose — the CLI renders, it does not re-validate the server. `key` is the
 * `PROD-<n>` identifier; the ready row carries no `type`/`estimate` column (the
 * /ready row is kind · key · title · priority · assignee). */
export interface ReadyItemSummary {
  key: string;
  kind: string;
  title: string;
  priority: string;
  assignee?: { id: string; name: string } | null;
}

export interface ReadyPage {
  items: ReadyItemSummary[];
  nextCursor: string | null;
}

/** A sprint row (the `list_sprints` `SprintDto`, the fields `motir status`
 * renders). */
export interface SprintSummary {
  id: string;
  name: string;
  state: 'planned' | 'active' | 'complete';
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  issueCount: number;
}

export interface SprintList {
  sprints: SprintSummary[];
}

/** A `search_work_items` result row (the `WorkItemListItemDto` subset the CLI
 * renders); `status` is the raw workflow status key. */
export interface SearchItemSummary {
  identifier: string;
  kind: string;
  title: string;
  status: string;
  priority: string;
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

/** The `get_work_item` slice `motir run` gates on: the current status and the
 * server's own readiness verdict (dependency-only — see the readiness rule). */
export interface WorkItemDetail {
  item: { id: string; identifier: string; title: string; status: string };
  readiness: {
    ready: boolean;
    openBlockers: { identifier: string; title: string; status: string }[];
    blockedByAncestor: { identifier: string } | null;
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
   */
  dispatchPrompt(key: string): Promise<DispatchPrompt> {
    return this.callStructured<DispatchPrompt>('dispatch_prompt', { key });
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
