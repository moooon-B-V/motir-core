import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MotirClient, mcpEndpoint } from '../src/mcpClient.js';
import { AuthError, CliError } from '../src/errors.js';
import { DEFAULT_TOOLS, startTestMcpServer, type TestMcpServer } from './helpers/mcpTestServer.js';

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

  it('refuses to be used before connect()', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'good-token' });
    await expect(client.whoami()).rejects.toThrow(/used before connect/);
    await expect(client.listToolNames()).rejects.toThrow(/used before connect/);
  });
});

describe('typed wrappers — each names its tool and forwards its arguments', () => {
  it('reads: whoami / list_ready / next_ready / get_work_item / list_sprints / search_work_items', async () => {
    const client = await connected();
    server.script({
      next_ready: { structured: { item: { id: 'row-1', key: 'PROD-7' } } },
      get_work_item: { structured: { item: { identifier: 'PROD-7' }, readiness: { ready: true } } },
    });

    const who = await client.whoami();
    expect(who.user.email).toBe('yue@motir.test');

    await client.listReady({ projectKey: 'PROD', kinds: ['subtask'], limit: 200 });
    await client.nextReady({ projectKey: 'PROD', excludeIds: ['row-9'] });
    await client.getWorkItem('PROD-7');
    await client.listSprints({ projectKey: 'PROD' });
    await client.searchWorkItems({
      projectKey: 'PROD',
      filter: { version: 'v1', combinator: 'and', conditions: [] },
      limit: 1,
    });

    expect(server.calls.map((c) => c.name)).toEqual([
      'whoami',
      'list_ready',
      'next_ready',
      'get_work_item',
      'list_sprints',
      'search_work_items',
    ]);
    expect(server.calls[1]?.args).toMatchObject({ projectKey: 'PROD', kinds: ['subtask'] });
    expect(server.calls[2]?.args).toMatchObject({ excludeIds: ['row-9'] });
    expect(server.calls[3]?.args).toEqual({ key: 'PROD-7' });
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

    // An `isError` with an EMPTY content block still has to say WHICH tool failed.
    server.script({ list_sprints: { error: '' } });
    await expect(client.listSprints({ projectKey: 'PROD' })).rejects.toThrow(
      /Tool list_sprints failed/,
    );

    // …and so does one whose content carries no TEXT part (an image / resource
    // block is not an error message).
    server.script({
      list_sprints: {
        error: 'x',
        contentParts: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      },
    });
    await expect(client.listSprints({ projectKey: 'PROD' })).rejects.toThrow(
      /Tool list_sprints failed/,
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
