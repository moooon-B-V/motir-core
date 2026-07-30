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

export interface TestMcpServer {
  /** Base URL for the CLI (`--server`), no trailing slash. */
  url: string;
  /** Every tool call the server received, in order. */
  calls: RecordedCall[];
  /** Replace / extend the scripted tools mid-test. */
  script(tools: ToolScript): void;
  close(): Promise<void>;
}

export interface TestMcpServerOptions {
  /** The bearer the server accepts; anything else gets a 401 (the shape
   *  `withMcpAuth` returns for an absent / invalid / revoked token). */
  token?: string;
  tools?: ToolScript;
  /** Start rejecting the (valid) token after this many requests — a token
   *  REVOKED mid-session, which the CLI must report as an auth failure on the
   *  call rather than as a generic crash. */
  revokeAfterRequests?: number;
}

export async function startTestMcpServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  const token = opts.token ?? 'test-token';
  const calls: RecordedCall[] = [];
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
    script: (next) => {
      tools = { ...tools, ...next };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** One `list_projects` row, with the fields the CLI reads. */
export function projectRow(key: string, name = key): ProjectSummary {
  return {
    key,
    id: `proj-${key.toLowerCase()}`,
    name,
    slug: key.toLowerCase(),
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
