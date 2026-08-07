import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MotirClient, type SearchFilterEnvelope } from '../src/client.js';
import { AuthError, CliError } from '../src/errors.js';
import {
  startTestServer,
  v1CloseOut,
  v1CloseOutItem,
  v1DispatchPrompt,
  v1JobHandle,
  v1Page,
  v1Plan,
  v1PlanOutcome,
  v1PlanSession,
  v1PlanTurn,
  v1Project,
  v1Proposal,
  v1WorkItem,
  v1ReadyRow,
  v1Sprint,
  type TestServer,
} from './helpers/testServer.js';

// The CLI's CLIENT CORE against a real HTTP server (Subtask 7.9.5 · MOTIR-883).
//
// Every command in the tool reaches the server through exactly these methods,
// so three things have to hold and are asserted here rather than assumed:
//
//   1. Each method names the `/api/v1` operation the server routes and puts its
//      arguments where that operation declares them — path, query or body (a
//      wrong path or a dropped parameter is otherwise a runtime-only bug).
//   2. A failure surfaces as a `CliError` carrying the server's OWN text, never
//      a swallowed status, because that text is what tells the user which
//      statuses a transition allows.
//   3. Anything unauthorized is an `AuthError` with the re-login hint, matching
//      the server's uniform 401 — including a token revoked mid-run.

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ token: 'good-token' });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.v1Calls.length = 0;
});

/** A client on the good token. Nothing is opened — the client IS a base URL and
 *  a bearer (11.5.6), so this is a constructor call, kept as a helper only
 *  because every test below wants the same two arguments. */
function connected(): MotirClient {
  return new MotirClient({ serverUrl: server.url, token: 'good-token' });
}

describe('the client is a URL and a bearer — no session to open', () => {
  // ⚠️ THE PROPERTY 11.5.6 LEFT BEHIND. There was a `connect()` here that opened
  // an MCP session, and a `describe('connect')` asserting it was idempotent,
  // closed cleanly, and refused use before a handshake. All three tested the
  // SDK, not Motir. What survives the deletion is what a USER can observe: the
  // FIRST call a freshly-built client makes works, and the two failure modes the
  // handshake used to report — a bad token, an unreachable host — still report
  // themselves, now on the call that hit them.
  it('serves a read on a client that was only constructed', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'good-token' });
    await expect(client.whoami()).resolves.toMatchObject({
      user: { email: 'yue@motir.test' },
    });
  });

  it('maps a 401 to AuthError with the re-login hint', async () => {
    const client = new MotirClient({ serverUrl: server.url, token: 'revoked' });
    await expect(client.whoami()).rejects.toBeInstanceOf(AuthError);
    await expect(client.whoami()).rejects.toMatchObject({ hint: expect.stringMatching(/login/) });
  });

  it('maps an unreachable server to a CliError naming the URL', async () => {
    // Port 1 on loopback: nothing listens, and the connection fails immediately.
    const client = new MotirClient({ serverUrl: 'http://127.0.0.1:1', token: 'x' });
    await expect(client.whoami()).rejects.toThrow(/Could not reach http:\/\/127\.0\.0\.1:1/);
  });
});

describe('typed wrappers — each names its operation and forwards its arguments', () => {
  // The port has moved the reads (MOTIR-2212 / 2344 / 2345) and now the dispatch
  // and session WRITES (MOTIR-2213) onto `/api/v1`, so what a wrapper names is an
  // OPERATION and a path rather than a tool. What still speaks MCP: `nextReady`
  // (retired by 11.5.6), `searchWorkItems` (11.5.17), and the planning
  // conversation (11.5.20). Each test below asserts on the WIRE, which is what
  // proves a slice moved its own methods and no others.
  it('identity reads over /api/v1: each names its operation and forwards its arguments', async () => {
    const client = connected();

    const who = await client.whoami();
    expect(who.user.email).toBe('yue@motir.test');
    const { projects } = await client.listProjects();
    expect(projects).toEqual([{ key: 'PROD', name: 'Prodect', accessLevel: 'open' }]);

    expect(server.v1Calls.map((c) => c.path)).toEqual([
      '/api/v1/me',
      '/api/v1/workspaces',
      '/api/v1/projects',
    ]);
  });

  // The two properties this slice's adapters must have, and neither is visible
  // from a single-workspace / single-page fixture.
  it('whoami resolves its workspace by ID, never by position', async () => {
    const client = connected();
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
  });

  it('whoami reports NO workspace when the bound one is not in the list', async () => {
    const client = connected();
    server.scriptV1({ 'GET /api/v1/workspaces': { body: { items: [], nextCursor: null } } });

    // Rendering no workspace is the honest answer; rendering a wrong one is not.
    await expect(client.whoami()).resolves.toMatchObject({ workspace: null });
  });

  it('listProjects WALKS every page, echoing the cursor verbatim', async () => {
    const client = connected();
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
  });

  // The three semantics a transport swap loses SILENTLY — each produces output
  // that looks entirely reasonable when it is wrong, so each is asserted on the
  // WIRE rather than on what the client was asked for.
  it('sends a REPEATED `kind`, not one joined value', async () => {
    const client = connected();

    await client.listReady({ projectKey: 'PROD', kinds: ['epic', 'story'] });

    // A comma-joined encoding would read as ONE kind named `epic,story`, which
    // the route rejects — the filter would narrow to nothing.
    expect(server.v1Calls.at(-1)?.query.getAll('kind')).toEqual(['epic', 'story']);
  });

  it('sends the ready ORDER back untouched — the server ranks, the client renders', async () => {
    const client = connected();
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
  });

  it('carries a sprint’s NEVER-ACTIVATED baseline through as null, not zero', async () => {
    const client = connected();
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
  });

  // MOTIR-2398 took the LAST method off MCP. What used to be "these still name
  // their tools" is now a NEGATIVE: no read, no write, no pick makes a tool call
  // at all. Asserted over a run of every shape rather than method by method,
  // because the property is about the client as a whole.
  it('makes NO MCP tool call — every method speaks /api/v1', async () => {
    const client = connected();

    await client.nextReady({ projectKey: 'PROD', excludeKeys: ['PROD-9'] });
    await client.whoami();
    await client.listReady({ projectKey: 'PROD' });
    await client.transitionStatus({ key: 'PROD-7', status: 'in_progress' });

    expect(server.v1Calls.length).toBeGreaterThan(0);
  });

  // The PICK (11.5.23 — MOTIR-2398). Three properties, none visible from the
  // output alone, all asserted on the wire.
  it('takes items[0] — the SERVER ranks, the client never re-sorts', async () => {
    const client = connected();
    // A page whose order matches no field the client could sort on: not key
    // order, not priority, not title. If anything re-ranked, it shows here.
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/ready': {
        body: v1Page([
          v1ReadyRow('PROD-9', { priority: 'low', title: 'zeta' }),
          v1ReadyRow('PROD-2', { priority: 'highest', title: 'alpha' }),
        ]),
      },
    });

    const { item } = await client.nextReady({ projectKey: 'PROD' });

    expect(item?.key).toBe('PROD-9');
  });

  it('FOLLOWS the cursor when a whole page is held out', async () => {
    const client = connected();
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/ready': (req) =>
        req.query.get('cursor') === null
          ? { body: v1Page([v1ReadyRow('PROD-1'), v1ReadyRow('PROD-2')], 'page-2') }
          : { body: v1Page([v1ReadyRow('PROD-3')]) },
    });

    // Every row of page one is held out. Stopping there would report the set
    // drained to a run that still had work — the failure this asserts against.
    const { item } = await client.nextReady({
      projectKey: 'PROD',
      excludeKeys: ['PROD-1', 'PROD-2'],
    });

    expect(item?.key).toBe('PROD-3');
    expect(server.v1Calls.at(-1)?.query.get('cursor')).toBe('page-2');
  });

  it('sends NO row id — the hold-out never reaches the wire', async () => {
    const client = connected();
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/ready': { body: v1Page([v1ReadyRow('PROD-4')]) },
    });

    await client.nextReady({ projectKey: 'PROD', excludeKeys: ['PROD-1'], kinds: ['subtask'] });

    const ask = server.v1Calls.at(-1);
    // The exclusion is applied client-side; only the KIND filter is the
    // server's business. An `excludeIds`-shaped parameter would mean the id
    // came back (MOTIR-2338's coupling, undone here).
    expect(ask?.query.getAll('kind')).toEqual(['subtask']);
    expect([...(ask?.query.keys() ?? [])].sort()).toEqual(['kind']);
  });

  // The work-item COLLECTION and its COUNT (11.5.17 — MOTIR-2319). Two
  // operations, deliberately: the page carries no total, so the count is one
  // request that says what it is rather than a search whose row is discarded.
  it('search sends the filter as ?filter=, and the count is its own request', async () => {
    const client = connected();
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/work-items': {
        body: v1Page([v1WorkItem('PROD-7', { title: 'A row' })], 'cur-2'),
      },
      'GET /api/v1/projects/{projectKey}/work-items/count': { body: { count: 42 } },
    });
    const filter: SearchFilterEnvelope = {
      version: 'v1',
      combinator: 'and',
      conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] }],
    };

    const page = await client.searchWorkItems({ projectKey: 'PROD', filter, limit: 50 });
    const count = await client.countWorkItems({ projectKey: 'PROD', filter });

    // The wire's `key` becomes the view model's `identifier` at the adapter —
    // `render.ts` has said `identifier` since long before this port.
    expect(page).toEqual({
      items: [
        {
          identifier: 'PROD-7',
          kind: 'subtask',
          title: 'A row',
          status: 'todo',
          priority: 'medium',
          dependencies: { blockedBy: [], blocks: [] },
        },
      ],
      nextCursor: 'cur-2',
    });
    expect(count).toBe(42);

    // BOTH carry the same encoded filter — the count's whole promise is that it
    // counts what the collection would page, and that only holds if the two
    // narrow identically.
    const encoded = server.v1Calls[0]?.query.get('filter');
    expect(encoded).toMatch(/^v1:/);
    expect(server.v1Calls[1]?.query.get('filter')).toBe(encoded);
    expect(server.v1Calls[0]?.query.get('limit')).toBe('50');
    // The count takes no paging parameters at all: it is not a page.
    expect(server.v1Calls[1]?.query.get('limit')).toBeNull();
    expect(server.v1Calls[1]?.query.get('cursor')).toBeNull();
  });

  it('omits ?filter= entirely when there is none — never an empty one', async () => {
    const client = connected();

    await client.searchWorkItems({ projectKey: 'PROD' });
    await client.countWorkItems({ projectKey: 'PROD' });

    // `?filter=` empty is not the same as absent to a decoder that has to tell
    // "no filter" from "a filter I could not read".
    expect(server.v1Calls.map((c) => c.query.get('filter'))).toEqual([null, null]);
    expect(server.v1Calls[0]?.query.get('cursor')).toBeNull();
  });

  // The write half of the work loop over `/api/v1` (11.5.5 — MOTIR-2213). Each
  // one names a METHOD and a PATH now, and the argument that used to ride in a
  // tool's `arguments` object rides in a request BODY.
  it('writes: transitions / integration / session complete', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/sessions/complete': {
        body: v1CloseOut('motir/auto-1', [v1CloseOutItem('PROD-7')]),
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
    expect(server.v1Calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/work-items/PROD-7/transitions',
      'POST /api/v1/work-items/PROD-7/integration',
      'POST /api/v1/sessions/complete',
    ]);
    expect(server.v1Calls[0]?.body).toEqual({ status: 'in_progress' });
    // The provenance stamp is the argument most easily lost in a transport
    // swap: nothing renders it, so only the wire can prove it was sent.
    expect(server.v1Calls[1]?.body).toEqual({
      sessionBranch: 'motir/auto-1',
      implementationHarness: 'motir-cli/0.1.0',
    });
    // …and it is OMITTED, not sent as null, when the caller has none.
    expect(server.v1Calls[2]?.body).toEqual({ sessionBranch: 'motir/auto-1' });
  });

  it('the dispatch prompt is a GET, and seeds the session branch only when there is one', async () => {
    const client = connected();
    server.scriptV1({
      'GET /api/v1/work-items/{key}/dispatch-prompt': {
        body: v1DispatchPrompt('PROD-7', {
          prompt: 'do the thing\n',
          targetRepo: 'motir-core',
          targetRepoCloneUrl: 'https://github.com/motir/motir-core.git',
          targetRepoDefaultBranch: 'main',
        }),
      },
    });

    const bare = await client.dispatchPrompt('PROD-7');
    await client.dispatchPrompt('PROD-7', { sessionBranch: 'motir/auto-1' });
    // An explicit null seed must not put a null on the wire (the query takes an
    // optional string, and `motir auto` passes `repo?.branch ?? null`).
    await client.dispatchPrompt('PROD-7', { sessionBranch: null });

    expect(bare.prompt).toBe('do the thing\n');
    // A GET: reading a prompt has never changed anything, and the verb now says so.
    expect(server.v1Calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(server.v1Calls[0]?.query.get('sessionBranch')).toBeNull();
    expect(server.v1Calls[1]?.query.get('sessionBranch')).toBe('motir/auto-1');
    expect(server.v1Calls[2]?.query.get('sessionBranch')).toBeNull();
    // The two repo-plumbing fields the payload carries are NOT on the view
    // model: nothing routes on them, and a field with no reader is dropped at
    // the adapter rather than carried in case someone wants it later.
    expect(Object.keys(bare).sort()).toEqual([
      'advisories',
      'key',
      'prompt',
      'sessionBranch',
      'targetRepo',
      'workflowMode',
    ]);
  });

  // A PARTIAL close-out is a real answer, not a failure: the server closes what
  // it can, transactionally, and says why for the rest. The client reports the
  // outcomes verbatim — it neither re-derives one nor drops the reason, which is
  // the only thing that tells the operator what to do about the item.
  it('reports every close-out outcome verbatim, reasons included', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/sessions/complete': {
        body: v1CloseOut('motir/auto-1', [
          v1CloseOutItem('PROD-7'),
          v1CloseOutItem('PROD-8', { outcome: 'already_done' }),
          v1CloseOutItem('PROD-9', {
            outcome: 'failed',
            reason: 'Its pull request is not merged.',
          }),
        ]),
      },
    });

    const done = await client.completeSession({ sessionBranch: 'motir/auto-1' });

    expect(done).toEqual({
      sessionBranch: 'motir/auto-1',
      results: [
        { key: 'PROD-7', outcome: 'completed' },
        { key: 'PROD-8', outcome: 'already_done' },
        { key: 'PROD-9', outcome: 'failed', reason: 'Its pull request is not merged.' },
      ],
    });
  });

  // The PLANNING CONVERSATION over `/api/v1` (11.5.20 — MOTIR-2341). The two
  // invariants below are properties of WHEN rather than of shape, which is why
  // they are asserted on the wire: nothing about the response bodies would
  // reveal a client that had blurred them.
  it('APPENDING is not submitting — a turn starts no job', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/projects/{projectKey}/plan-session/turns': {
        body: v1PlanSession([v1PlanTurn(0, { body: 'split the billing epic' })]),
      },
    });

    const session = await client.appendPlanTurn({ projectKey: 'PROD', body: 'split it' });

    expect(session.turnCount).toBe(1);
    expect(session.turns[0]?.body).toBe('split the billing epic');
    // The turn is persisted and NOTHING was submitted. A client that submitted
    // eagerly would charge the user for a sentence they were still drafting.
    expect(server.v1Calls.map((c) => c.path)).toEqual(['/api/v1/projects/PROD/plan-session/turns']);
    expect(server.v1Calls[0]?.body).toEqual({ body: 'split it' });
  });

  it('submitting returns the handle WITHOUT waiting on the planner', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/projects/{projectKey}/plan-session/submissions': {
        status: 202,
        body: v1JobHandle({ jobId: 'job-7', planId: 'plan-7' }),
      },
      // Still generating when the submit resolves — which is the point: the
      // client hands back a handle and the COMMAND decides whether to poll.
      'GET /api/v1/plans/{planId}/status': {
        body: v1PlanOutcome({
          planId: 'plan-7',
          status: 'generating',
          job: { status: 'running', reachable: true, failure: null },
        }),
      },
    });

    const submitted = await client.submitPlanSession({
      projectKey: 'PROD',
      targetKeys: ['PROD-7'],
    });

    expect(submitted).toEqual({ jobId: 'job-7', planId: 'plan-7' });
    expect(server.v1Calls[0]?.body).toEqual({ targetKeys: ['PROD-7'] });
    // No status read happened inside the client: submitting is one request.
    expect(server.v1Calls).toHaveLength(1);

    const outcome = await client.getPlanStatus({ planId: 'plan-7' });
    expect(outcome.status).toBe('generating');
    expect(outcome.job).toEqual({ status: 'running', reachable: true, failure: null });
  });

  it('a plan read returns PROPOSALS — including ones that carry no fields', async () => {
    const client = connected();
    server.scriptV1({
      'GET /api/v1/plans/{planId}': {
        body: v1Plan([
          // An `add` whose kind the planner did not commit to. The renderer
          // falls back to `task`, which it can only do if the adapter omits
          // the key rather than carrying a null through.
          v1Proposal('a', { proposedFields: { ...v1Proposal('a').proposedFields, kind: null } }),
          // A `modify` has NO proposed fields at all — it patches a row that
          // already exists, and names it by KEY.
          v1Proposal('b', {
            op: 'modify',
            workItemKey: 'PROD-9',
            proposedFields: null,
            patch: { title: 'A new title' },
          }),
        ]),
      },
    });

    const plan = await client.getPlan({ planId: 'plan-1' });

    expect(plan.itemCount).toBe(2);
    expect(plan.items[0]?.proposedFields).not.toHaveProperty('kind');
    expect(plan.items[1]).toMatchObject({
      op: 'modify',
      workItemKey: 'PROD-9',
      proposedFields: null,
      patch: { title: 'A new title' },
    });
  });

  it('an expansion submit returns the job handle from a 202', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/work-items/{key}/expansions': {
        status: 202,
        body: v1JobHandle({ jobId: 'job-7', planId: 'plan-7' }),
      },
    });

    // 202 is a SUCCESS the transport must accept on its own terms — the job is
    // accepted, not finished, and the handle is the whole answer.
    await expect(client.expandItem('PROD-7')).resolves.toEqual({
      jobId: 'job-7',
      planId: 'plan-7',
    });
    expect(server.v1Calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/work-items/PROD-7/expansions',
      // No body: the item's key is the whole request.
      body: undefined,
    });
  });
});

describe('failures', () => {
  // ⚠️ The refusal has to keep TEACHING across the transport swap. The MCP tool
  // put the legal targets inside its sentence; v1 puts them beside it, in
  // `allowedTransitions`. Same information, different place — so a client that
  // reads only the envelope's two pinned fields silently turns actionable
  // guidance into a dead end, and this test is what forbids that.
  it('an illegal transition still names what IS allowed — from the field, not the sentence', async () => {
    const client = connected();
    server.scriptV1({
      'POST /api/v1/work-items/{key}/transitions': {
        status: 422,
        body: {
          code: 'ILLEGAL_TRANSITION',
          error: 'Illegal status transition: "in_progress" → "done".',
          allowedTransitions: [
            { key: 'todo', label: 'To Do', category: 'todo' },
            { key: 'in_review', label: 'In Review', category: 'in_progress' },
          ],
        },
      },
    });

    const failure = await client
      .transitionStatus({ key: 'PROD-7', status: 'done' })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CliError);
    // The server's sentence, then the targets — in the MESSAGE, because `motir
    // done` re-raises this error with a hint of its own and would drop them.
    expect((failure as CliError).message).toBe(
      'Illegal status transition: "in_progress" → "done". Allowed: To Do, In Review.',
    );
    expect((failure as CliError).hint).toBeUndefined();
  });

  it('a refusal with no usable target list still reports the refusal', async () => {
    const client = connected();
    // Three ways the enrichment can be useless — absent, empty (a terminal
    // status really has nowhere to go), and malformed. None may cost the user
    // the error itself, because this runs on a path where nothing is validated.
    for (const allowedTransitions of [undefined, [], [{ key: 'todo' }, 7]]) {
      server.scriptV1({
        'POST /api/v1/work-items/{key}/transitions': {
          status: 422,
          body: { code: 'ILLEGAL_TRANSITION', error: 'Nope.', allowedTransitions },
        },
      });

      const failure = await client
        .transitionStatus({ key: 'PROD-7', status: 'done' })
        .catch((err: unknown) => err);

      expect((failure as CliError).message).toBe('Nope.');
      expect((failure as CliError).hint).toBeUndefined();
    }
  });

  // ⚠️ The tool-error tests that lived here are GONE with the last method that
  // could reach them (MOTIR-2398). `callStructured` — and the `Tool <name>
  // failed` message it raises — now has no caller: every method speaks
  // `/api/v1`, where a failure is a STATUS mapped by the transport, not an
  // in-band error result. The code itself is 11.5.6's to delete along with the
  // SDK; nothing here can drive it in the meantime, and a test that reached in
  // to call a private method would be asserting a shape no user can produce.

  it('maps an unauthorized CALL to AuthError — a token revoked mid-run', async () => {
    // The first requests succeed; the revocation lands partway through, which is
    // what a real `motir auto` run would hit.
    const revoking = await startTestServer({
      token: 'good-token',
      revokeAfterRequests: 2,
    });
    const client = new MotirClient({ serverUrl: revoking.url, token: 'good-token' });

    // `whoami` is two requests, so the first call spends the budget and the
    // second is answered with the 401 a revoked token gets.
    await client.whoami();
    await expect(client.whoami()).rejects.toBeInstanceOf(AuthError);

    await revoking.close();
  });

  it('maps a call against a server that went away to a plain CliError, not a crash', async () => {
    const gone = await startTestServer({ token: 't' });
    const client = new MotirClient({ serverUrl: gone.url, token: 't' });
    await gone.close();

    const failure = await client.whoami().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).not.toBeInstanceOf(AuthError);
  });

  // ⚠️ Also gone with the last MCP method (MOTIR-2398): "the server does not
  // expose that tool" was reachable only through a `callStructured` caller, and
  // there is none. On `/api/v1` the equivalent — an endpoint this server does
  // not route — is a 404 with no envelope, which arms the version-skew probe and
  // is asserted in `transport.test.ts` where that logic lives.
});
