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

/** A ready-set row (the `list_ready` / `next_ready` DTO, terminal-relevant
 * fields). Kept loose — the CLI renders, it does not re-validate the server. */
export interface ReadyItemSummary {
  key: string;
  kind: string;
  type: string | null;
  title: string;
  priority: string;
  assignee?: { name: string } | null;
}

export interface ReadyPage {
  items: ReadyItemSummary[];
  nextCursor: string | null;
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
  }): Promise<{ item: unknown | null }> {
    return this.callStructured('next_ready', { ...args });
  }

  getWorkItem(key: string): Promise<unknown> {
    return this.callStructured('get_work_item', { key });
  }

  transitionStatus(args: { key: string; status: string }): Promise<unknown> {
    return this.callStructured('transition_status', { ...args });
  }

  listSprints(args: { projectKey: string }): Promise<unknown> {
    return this.callStructured('list_sprints', { ...args });
  }

  searchWorkItems(args: Record<string, unknown>): Promise<unknown> {
    return this.callStructured('search_work_items', { ...args });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
