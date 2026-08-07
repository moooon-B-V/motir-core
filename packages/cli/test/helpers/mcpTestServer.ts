import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ProjectSummary } from '../../src/mcpClient.js';

// A REAL MCP server for the package's own tests (Subtask 7.9.5 · MOTIR-883).
//
// `mcpClient.ts` is the CLI's client core — the one place it talks to a Motir
// server — and it is built on the official SDK's client + streamable-HTTP
// transport. Faking it out (a stubbed `callTool`) would test a stand-in for the
// exact layer that most needs proving: that a tool error becomes a `CliError`
// carrying the tool's own text, that a 401 anywhere becomes an `AuthError`, and
// that each typed wrapper names the tool the server actually exposes.
//
// So the tests speak the protocol to a genuine SDK `Server` over a genuine
// socket, with canned tool RESULTS standing in for Motir's business logic. The
// transport, the framing, the session handling and the error envelopes are all
// the real implementations; only the data is scripted. (The end-to-end article —
// this client against the real `/api/mcp` and real Postgres — is the story suite
// in `tests/cli/`, which runs the built binary as a child process.)

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/** What a scripted tool answers with. Exactly one of `structured` / `error`. */
export interface ToolReply {
  /** The `structuredContent` payload the typed wrappers read. */
  structured?: unknown;
  /** Human text block (the `content` array). */
  text?: string;
  /** Answer as a TOOL ERROR (`isError: true`) carrying `text` — the shape a
   *  Motir tool returns for a typed failure like an illegal transition. */
  error?: string;
  /** Replace the `content` array wholesale — for the shapes a text-only reply
   *  cannot express (no content block at all, a non-text part). */
  contentParts?: unknown[];
}

export type ToolScript = Record<string, ToolReply | ((args: Record<string, unknown>) => ToolReply)>;

/** What a scripted `/api/v1` route answers with. */
export interface V1Reply {
  status?: number;
  body?: unknown;
}

/**
 * The `/api/v1` routes this server serves, keyed `` `${METHOD} ${pathTemplate}` ``
 * with `{name}` for a dynamic segment — the same spelling the OpenAPI document
 * uses, so a key here reads like the operation it stands for.
 *
 * Written as REAL v1 payloads, never derived from the MCP script above. A helper
 * that translated one into the other would be a second adapter running
 * backwards, and every read test would then be asserting that this file and
 * `src/adapters/reads.ts` agree with each other rather than that either agrees
 * with the server.
 */
export type V1Script = Record<string, V1Reply | ((req: V1Request) => V1Reply)>;

/** What the server recorded about a `/api/v1` request it served. */
export interface V1Request {
  method: string;
  /** The full path, no query. */
  path: string;
  /** The resolved `{name}` segments. */
  params: Record<string, string>;
  query: URLSearchParams;
}

export interface TestMcpServer {
  /** Base URL for the CLI (`--server`), no trailing slash. */
  url: string;
  /** Every tool call the server received, in order. */
  calls: RecordedCall[];
  /** Every `/api/v1` request the server received, in order. */
  v1Calls: V1Request[];
  /** Replace / extend the scripted tools mid-test. */
  script(tools: ToolScript): void;
  /** Replace / extend the scripted `/api/v1` routes mid-test. */
  scriptV1(routes: V1Script): void;
  /**
   * Restore the `/api/v1` routes this server STARTED with.
   *
   * `scriptV1` merges, so a route one test overrides — a 404, an error envelope
   * — is inherited by every test after it. That is an order-dependent failure
   * whose symptom appears in an unrelated test, so suites reset in `beforeEach`
   * rather than each site remembering to put a route back.
   */
  resetV1(): void;
  close(): Promise<void>;
}

export interface TestMcpServerOptions {
  /** The bearer the server accepts; anything else gets a 401 (the shape
   *  `withMcpAuth` returns for an absent / invalid / revoked token). */
  token?: string;
  tools?: ToolScript;
  /** The `/api/v1` routes to serve. Merged over {@link DEFAULT_V1}. */
  v1?: V1Script;
  /** Start rejecting the (valid) token after this many requests — a token
   *  REVOKED mid-session, which the CLI must report as an auth failure on the
   *  call rather than as a generic crash. */
  revokeAfterRequests?: number;
}

export async function startTestMcpServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  const token = opts.token ?? 'test-token';
  const calls: RecordedCall[] = [];
  const v1Calls: V1Request[] = [];
  let v1: V1Script = { ...DEFAULT_V1, ...(opts.v1 ?? {}) };
  let tools: ToolScript = { ...(opts.tools ?? {}) };

  let requestCount = 0;

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      requestCount += 1;
      const revoked =
        opts.revokeAfterRequests !== undefined && requestCount > opts.revokeAfterRequests;
      const authorization = req.headers.authorization ?? '';
      if (revoked || authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/v1')) {
        const matched = matchV1(v1, req.method ?? 'GET', url);
        if (!matched) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'NOT_FOUND',
              error: `no scripted v1 route ${req.method} ${url.pathname}`,
            }),
          );
          return;
        }
        v1Calls.push(matched.request);
        const reply =
          typeof matched.reply === 'function' ? matched.reply(matched.request) : matched.reply;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;

      // Stateless, one server per request — the same shape the production route
      // uses (`mcp-handler` creates a fresh transport per POST).
      const server = new Server(
        { name: 'motir-test', version: '0.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: Object.keys(tools).map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' as const },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name, args });
        const entry = tools[name];
        const reply: ToolReply =
          entry === undefined
            ? { error: `NOT_FOUND: no scripted tool "${name}"` }
            : typeof entry === 'function'
              ? entry(args)
              : entry;
        const text = reply.error ?? reply.text ?? '';
        return {
          content: (reply.contentParts ?? (text ? [{ type: 'text' as const, text }] : [])) as {
            type: 'text';
            text: string;
          }[],
          ...(reply.structured === undefined
            ? {}
            : { structuredContent: reply.structured as Record<string, unknown> }),
          // `error: ''` is still an error — an empty content block is exactly
          // the case the client has to name the tool for.
          ...(reply.error !== undefined ? { isError: true } : {}),
        };
      });

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    v1Calls,
    script: (next) => {
      tools = { ...tools, ...next };
    },
    scriptV1: (next) => {
      v1 = { ...v1, ...next };
    },
    resetV1: () => {
      v1 = { ...DEFAULT_V1, ...(opts.v1 ?? {}) };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Resolve a request against the v1 script.
 *
 * Templates are matched segment by segment, `{name}` capturing one segment —
 * the same spelling the OpenAPI paths use, so a script key reads like the
 * operation it stands for. A literal segment always beats a placeholder, so
 * `…/work-items/{key}/activity` and `…/work-items/{key}` cannot shadow each
 * other by declaration order.
 */
function matchV1(
  script: V1Script,
  method: string,
  url: URL,
): { reply: V1Reply | ((req: V1Request) => V1Reply); request: V1Request } | undefined {
  const actual = url.pathname.split('/').filter(Boolean);
  for (const [key, reply] of Object.entries(script)) {
    const [scriptMethod, template] = key.split(' ');
    if (scriptMethod !== method || template === undefined) continue;
    const expected = template.split('/').filter(Boolean);
    if (expected.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [i, segment] of expected.entries()) {
      const got = actual[i] ?? '';
      if (segment.startsWith('{') && segment.endsWith('}')) {
        params[segment.slice(1, -1)] = decodeURIComponent(got);
        continue;
      }
      if (segment !== got) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        reply,
        request: { method, path: url.pathname, params, query: url.searchParams },
      };
    }
  }
  return undefined;
}

/** One `list_projects` row, with the fields the CLI reads. */
export function projectRow(key: string, name = key): ProjectSummary {
  return {
    key,
    name,
    accessLevel: 'open',
  };
}

/** The canned answers most command tests want — enough for `auth login`,
 *  `link`, `ready` and `status` to complete.
 *
 *  The default workspace holds exactly ONE project, which is the shape the
 *  single-project auto-link (MOTIR-1880) is for; a test that needs the ambiguous
 *  case scripts `list_projects` with several rows itself. */
export const DEFAULT_TOOLS: ToolScript = {
  whoami: {
    structured: {
      user: { id: 'user-1', name: 'Zhu Yue', email: 'yue@motir.test' },
      workspace: { id: 'ws-1', name: 'Acme', slug: 'acme' },
    },
  },
  list_projects: { structured: { projects: [projectRow('PROD', 'Prodect')] } },
  list_ready: { structured: { items: [], nextCursor: null } },
  list_sprints: { structured: { sprints: [] } },
  search_work_items: { structured: { items: [], total: 0, nextCursor: null } },
};

// ─────────────────────────────────────────────────────────────────────────────
// The `/api/v1` defaults (Subtask 11.5.4 — MOTIR-2212)
// ─────────────────────────────────────────────────────────────────────────────
//
// The READ methods move to `/api/v1` one slice at a time, so this helper serves
// it too. These payloads are the DEFAULTS that let `auth login`, `link` and
// `doctor` complete — the v1 counterpart of `DEFAULT_TOOLS`, and deliberately
// the same data, so a test that already relied on those defaults keeps passing.
// Each later slice adds the routes and builders its own methods need.
//
// ⚠️ They are written as REAL v1 shapes. Deriving them from `DEFAULT_TOOLS`
// would make every read test a round-trip through the adapter's own inverse:
// green whether or not either side matches the server.

/** The plain page envelope. */
export function v1Page<T>(items: T[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

/** One v1 project resource. */
export function v1Project(key: string, name = key) {
  return { key, name, accessLevel: 'open', archived: false };
}

/** A total dependency block — two arrays, empty rather than missing. */
export function v1Edges() {
  return { blockedBy: [], blocks: [] };
}

/** One v1 READY row. */
export function v1ReadyRow(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    kind: 'subtask',
    title: key,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    type: 'code',
    executor: 'coding_agent',
    assigneeId: null,
    assignee: null,
    descriptionExcerpt: null,
    dependencies: v1Edges(),
    ...over,
  };
}

/** One v1 SPRINT row. */
export function v1Sprint(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    goal: null,
    state: 'planned',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 1,
    issueCount: 0,
    committedPoints: null,
    committedIssueCount: null,
    ...over,
  };
}

/** The canned `/api/v1` answers, mirroring {@link DEFAULT_TOOLS}' data. */
export const DEFAULT_V1: V1Script = {
  'GET /api/v1/me': {
    body: {
      user: { id: 'user-1', name: 'Zhu Yue', email: 'yue@motir.test' },
      workspaceId: 'ws-1',
      scopes: ['read'],
    },
  },
  'GET /api/v1/workspaces': {
    body: v1Page([
      { id: 'ws-1', name: 'Acme', slug: 'acme', createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  },
  'GET /api/v1/projects': { body: v1Page([v1Project('PROD', 'Prodect')]) },
  'GET /api/v1/projects/{projectKey}/ready': { body: v1Page([]) },
  'GET /api/v1/projects/{projectKey}/sprints': { body: v1Page([]) },
};
