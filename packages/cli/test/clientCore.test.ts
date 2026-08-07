import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MotirClient, mcpEndpoint } from '../src/mcpClient.js';
import { AuthError, CliError } from '../src/errors.js';
import {
  DEFAULT_TOOLS,
  startTestMcpServer,
  v1Page,
  v1Project,
  v1ReadyRow,
  v1Sprint,
  type TestMcpServer,
} from './helpers/mcpTestServer.js';

// The CLI's CLIENT CORE against a real MCP server (Subtask 7.9.5 · MOTIR-883).
//
// Every command in the tool reaches the server through exactly these wrappers,
// so three things have to hold and are asserted here rather than assumed:
//
//   1. Each wrapper names the tool the server exposes and passes the arguments
//      through unchanged (a typo'd tool name is otherwise a runtime-only bug).
//   2. A tool ERROR surfaces as a `CliError` carrying the tool's OWN text —
//      never a swallowed JSON-RPC failure, because that text is what tells the
//      user which statuses a transition allows.
//   3. Anything unauthorized — at connect OR mid-session — is an `AuthError`
//      with the re-login hint, matching the server's uniform 401.

let server: TestMcpServer;

beforeAll(async () => {
  server = await startTestMcpServer({ token: 'good-token', tools: DEFAULT_TOOLS });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.calls.length = 0;
  server.v1Calls.length = 0;
});

/** A connected client on the good token. */
async function connected(): Promise<MotirClient> {
  const client = new MotirClient({ serverUrl: server.url, token: 'good-token' });
  await client.connect();
  return client;
}

describe('mcpEndpoint', () => {
  it('derives /api/mcp from a server base, trailing slash or not', () => {
    expect(mcpEndpoint('https://app.motir.co').toString()).toBe('https://app.motir.co/api/mcp');
    expect(mcpEndpoint('https://app.motir.co/').toString()).toBe('https://app.motir.co/api/mcp');
    expect(mcpEndpoint('http://localhost:3000').toString()).toBe('http://localhost:3000/api/mcp');
  });
});

describe('connect', () => {
  it('opens a session, is idempotent, and closes cleanly', async () => {
    const client = await connected();
    await client.connect(); // second call is a no-op, not a second session
    expect(await client.listToolNames()).toContain('whoami');
    await client.close();
    // Closing twice must not throw either — `withProjectSession` always closes.
    await client.close();
  });

  it('maps a 401 at connect to AuthError with the re-login hint', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'revoked' });
    await expect(client.connect()).rejects.toBeInstanceOf(AuthError);
    await expect(client.connect()).rejects.toMatchObject({ hint: expect.stringMatching(/login/) });
  });

  it('maps an unreachable server to a CliError naming the URL', async () => {
    // Port 1 on loopback: nothing listens, and connecting fails immediately.
    const client = new MotirClient({ serverUrl: 'http://127.0.0.1:1', token: 'x' });
    await expect(client.connect()).rejects.toThrow(/Could not reach the Motir server/);
  });

  it('refuses to be used before connect() — on the paths that still speak MCP', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'good-token' });
    await expect(client.listToolNames()).rejects.toThrow(/used before connect/);
    await expect(client.nextReady({ projectKey: 'PROD' })).rejects.toThrow(/used before connect/);
  });

  // MOTIR-2212. A READ no longer needs the MCP handshake — that is the point of
  // the port, not an oversight: `/api/v1` is a bearer and a URL, and the two
  // transports coexist until 11.5.6 removes the MCP half.
  it('serves a READ with no connect() at all', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'good-token' });
    await expect(client.whoami()).resolves.toMatchObject({
      user: { email: 'yue@motir.test' },
    });
  });
});

describe('typed wrappers — each names its tool and forwards its arguments', () => {
  // MOTIR-2212 split this: the six READS moved to `/api/v1`, so what they name
  // is an OPERATION and a path. `nextReady` and `searchWorkItems` still speak
  // MCP (11.5.19 retires the first, 11.5.17 ports the second).
  // MOTIR-2212 moves the IDENTITY reads to `/api/v1`, so what they name is an
  // operation and a path. The rest still speak MCP; 11.5.21 and 11.5.22 take
  // them, and the assertion below is what proves this slice moved only its own.
  it('identity reads over /api/v1: each names its operation and forwards its arguments', async () => {
    const client = await connected();

    const who = await client.whoami();
    expect(who.user.email).toBe('yue@motir.test');
    const { projects } = await client.listProjects();
    expect(projects).toEqual([{ key: 'PROD', name: 'Prodect', accessLevel: 'open' }]);

    expect(server.v1Calls.map((c) => c.path)).toEqual([
      '/api/v1/me',
      '/api/v1/workspaces',
      '/api/v1/projects',
    ]);
    // No MCP tool call was made for either — the whole point of the slice.
    expect(server.calls).toEqual([]);
    await client.close();
  });

  // The two properties this slice's adapters must have, and neither is visible
  // from a single-workspace / single-page fixture.
  it('whoami resolves its workspace by ID, never by position', async () => {
    const client = await connected();
    server.scriptV1({
      'GET /api/v1/workspaces': {
        body: {
          items: [
            {
              id: 'ws-other',
              name: 'Someone Else',
              slug: 'other',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            { id: 'ws-1', name: 'Acme', slug: 'acme', createdAt: '2026-01-01T00:00:00.000Z' },
          ],
          nextCursor: null,
        },
      },
    });

    // `/me` says the token is bound to `ws-1`, which is the SECOND row. A client
    // that took `items[0]` passes every single-workspace fixture and is wrong
    // the moment a user belongs to two.
    await expect(client.whoami()).resolves.toMatchObject({ workspace: { slug: 'acme' } });
    await client.close();
  });

  it('whoami reports NO workspace when the bound one is not in the list', async () => {
    const client = await connected();
    server.scriptV1({ 'GET /api/v1/workspaces': { body: { items: [], nextCursor: null } } });

    // Rendering no workspace is the honest answer; rendering a wrong one is not.
    await expect(client.whoami()).resolves.toMatchObject({ workspace: null });
    await client.close();
  });

  it('listProjects WALKS every page, echoing the cursor verbatim', async () => {
    const client = await connected();
    const cursor = 'eyJrIjoiMjAyNi0wOC0wN1QwMDowMDowMFoifQ==';
    server.scriptV1({
      'GET /api/v1/projects': (req) =>
        req.query.get('cursor') === null
          ? { body: { items: [v1Project('AAA')], nextCursor: cursor } }
          : { body: { items: [v1Project('BBB')], nextCursor: null } },
    });

    const { projects } = await client.listProjects();

    expect(projects.map((p) => p.key)).toEqual(['AAA', 'BBB']);
    // The cursor is opaque: sent back exactly as received, never rebuilt.
    expect(server.v1Calls[1]?.query.get('cursor')).toBe(cursor);
    await client.close();
  });

  // The three semantics a transport swap loses SILENTLY — each produces output
  // that looks entirely reasonable when it is wrong, so each is asserted on the
  // WIRE rather than on what the client was asked for.
  it('sends a REPEATED `kind`, not one joined value', async () => {
    const client = await connected();

    await client.listReady({ projectKey: 'PROD', kinds: ['epic', 'story'] });

    // A comma-joined encoding would read as ONE kind named `epic,story`, which
    // the route rejects — the filter would narrow to nothing.
    expect(server.v1Calls.at(-1)?.query.getAll('kind')).toEqual(['epic', 'story']);
    await client.close();
  });

  it('sends the ready ORDER back untouched — the server ranks, the client renders', async () => {
    const client = await connected();
    // A page whose rank matches no field the client could sort on: not key
    // order, not priority, not title.
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/ready': {
        body: v1Page([
          v1ReadyRow('PROD-9', { priority: 'low', title: 'zeta' }),
          v1ReadyRow('PROD-2', { priority: 'highest', title: 'alpha' }),
          v1ReadyRow('PROD-5', { priority: 'medium', title: 'mu' }),
        ]),
      },
    });

    const { items } = await client.listReady({ projectKey: 'PROD' });

    expect(items.map((i) => i.key)).toEqual(['PROD-9', 'PROD-2', 'PROD-5']);
    await client.close();
  });

  it('carries a sprint’s NEVER-ACTIVATED baseline through as null, not zero', async () => {
    const client = await connected();
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/sprints': {
        body: v1Page([
          v1Sprint('s1'),
          v1Sprint('s2', { committedPoints: 21, committedIssueCount: 2 }),
        ]),
      },
    });

    const { sprints } = await client.listSprints({ projectKey: 'PROD' });

    // `?? 0` here would report a scope-lock baseline that was never taken —
    // a sprint nobody estimated and a sprint never started look identical.
    expect(sprints[0]).toMatchObject({ committedPoints: null, committedIssueCount: null });
    expect(sprints[1]).toMatchObject({ committedPoints: 21, committedIssueCount: 2 });
    await client.close();
  });

  it('the UNPORTED reads still name their MCP tools', async () => {
    const client = await connected();
    server.script({
      next_ready: { structured: { item: { id: 'row-1', key: 'PROD-7' } } },
      get_work_item: { structured: { item: { identifier: 'PROD-7' }, readiness: { ready: true } } },
    });

    await client.nextReady({ projectKey: 'PROD', excludeIds: ['row-9'] });
    await client.getWorkItem('PROD-7');

    expect(server.calls.map((c) => c.name)).toEqual(['next_ready', 'get_work_item']);
    expect(server.calls[0]?.args).toMatchObject({ excludeIds: ['row-9'] });
    await client.close();
  });

  it('writes: transition_status / mark_integrated / complete_session', async () => {
    const client = await connected();
    server.script({
      transition_status: { structured: { status: 'in_progress' } },
      mark_integrated: { structured: { ok: true } },
      complete_session: {
        structured: {
          sessionBranch: 'motir/auto-1',
          results: [{ key: 'PROD-7', outcome: 'completed' }],
        },
      },
    });

    await client.transitionStatus({ key: 'PROD-7', status: 'in_progress' });
    await client.markIntegrated({
      key: 'PROD-7',
      sessionBranch: 'motir/auto-1',
      implementationHarness: 'motir-cli/0.1.0',
    });
    const done = await client.completeSession({ sessionBranch: 'motir/auto-1' });

    expect(done.results[0]?.outcome).toBe('completed');
    expect(server.calls.map((c) => c.name)).toEqual([
      'transition_status',
      'mark_integrated',
      'complete_session',
    ]);
    expect(server.calls[1]?.args).toMatchObject({ implementationHarness: 'motir-cli/0.1.0' });
    await client.close();
  });

  it('dispatch_prompt sends the session-branch SEED only when there is one', async () => {
    const client = await connected();
    server.script({
      dispatch_prompt: {
        structured: {
          key: 'PROD-7',
          prompt: 'do the thing\n',
          targetRepo: 'motir-core',
          workflowMode: 'per_item_pr',
          sessionBranch: null,
        },
      },
    });

    const bare = await client.dispatchPrompt('PROD-7');
    await client.dispatchPrompt('PROD-7', { sessionBranch: 'motir/auto-1' });
    // An explicit null seed must not put a null on the wire (the tool's schema
    // takes an optional string, and `motir auto` passes `repo?.branch ?? null`).
    await client.dispatchPrompt('PROD-7', { sessionBranch: null });

    expect(bare.prompt).toBe('do the thing\n');
    expect(server.calls[0]?.args).toEqual({ key: 'PROD-7' });
    expect(server.calls[1]?.args).toEqual({ key: 'PROD-7', sessionBranch: 'motir/auto-1' });
    expect(server.calls[2]?.args).toEqual({ key: 'PROD-7' });
    await client.close();
  });
});

describe('failures', () => {
  it("surfaces a tool error VERBATIM as a CliError — it carries the server's guidance", async () => {
    const client = await connected();
    server.script({
      transition_status: {
        error: 'ILLEGAL_TRANSITION: In Progress → Done is not allowed. Allowed: To Do, In Review.',
      },
    });

    await expect(client.transitionStatus({ key: 'PROD-7', status: 'done' })).rejects.toThrow(
      /Allowed: To Do, In Review/,
    );
    await expect(client.transitionStatus({ key: 'PROD-7', status: 'done' })).rejects.toBeInstanceOf(
      CliError,
    );
    await client.close();
  });

  it('names the tool when an error result carries no usable text', async () => {
    const client = await connected();

    // An `isError` with an EMPTY content block still has to say WHICH tool
    // failed. Driven on a tool that still speaks MCP — `list_sprints` moved to
    // `/api/v1` in MOTIR-2212, where a failure is a status, not a tool result.
    server.script({ search_work_items: { error: '' } });
    await expect(client.searchWorkItems({ projectKey: 'PROD' })).rejects.toThrow(
      /Tool search_work_items failed/,
    );

    // …and so does one whose content carries no TEXT part (an image / resource
    // block is not an error message).
    server.script({
      search_work_items: {
        error: 'x',
        contentParts: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      },
    });
    await expect(client.searchWorkItems({ projectKey: 'PROD' })).rejects.toThrow(
      /Tool search_work_items failed/,
    );
    await client.close();
  });

  it('maps an unauthorized CALL to AuthError — a token revoked mid-session', async () => {
    // The session opens fine; the revocation lands between the connect and the
    // tool call, which is what a real `motir auto` run would hit.
    const revoking = await startTestMcpServer({
      token: 'good-token',
      tools: DEFAULT_TOOLS,
      revokeAfterRequests: 2,
    });
    const client = new MotirClient({ serverUrl: revoking.url, token: 'good-token' });
    await client.connect();

    await expect(client.whoami()).rejects.toBeInstanceOf(AuthError);
    await expect(client.listToolNames()).rejects.toBeInstanceOf(AuthError);

    await client.close();
    await revoking.close();
  });

  it('maps a call against a server that went away to a plain CliError, not a crash', async () => {
    const gone = await startTestMcpServer({ token: 't', tools: DEFAULT_TOOLS });
    const client = new MotirClient({ serverUrl: gone.url, token: 't' });
    await client.connect();
    await gone.close();

    const failure = await client.whoami().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).not.toBeInstanceOf(AuthError);
    await client.close();
  });

  it('reports a tool the server does not expose rather than hanging', async () => {
    const client = await connected();
    // `dispatch_prompt` is not in DEFAULT_TOOLS on this fresh server.
    const bare = await startTestMcpServer({ token: 't', tools: DEFAULT_TOOLS });
    const other = new MotirClient({ serverUrl: bare.url, token: 't' });
    await other.connect();

    await expect(other.dispatchPrompt('PROD-7')).rejects.toThrow(/no scripted tool/);

    await other.close();
    await bare.close();
    await client.close();
  });
});
