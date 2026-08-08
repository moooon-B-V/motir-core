import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectSummary } from '../../src/client.js';

// A REAL HTTP server for the package's own tests (Subtask 7.9.5 · MOTIR-883).
//
// `client.ts` is the CLI's client core — the one place it talks to a Motir
// server — and it speaks `/api/v1` over `fetch`. Faking THAT out (a stubbed
// `fetch`) would test a stand-in for the exact layer that most needs proving:
// that a `{ code, error }` envelope becomes a `CliError` carrying the server's
// own text, that a 401 anywhere becomes an `AuthError`, that a body which does
// not match the generated schema raises rather than reaching a renderer, and
// that each method builds the URL and query the operation actually declares.
//
// So the tests speak HTTP to a genuine socket, with canned RESPONSES standing in
// for Motir's business logic. The framing, the status handling, the header and
// the URL building are all the real implementations; only the data is scripted.
// (The end-to-end article — this client against the real `/api/v1` and real
// Postgres — is the story suite in `tests/cli/`, which runs the built binary as
// a child process.)
//
// ⚠️ It used to serve `/api/mcp` too, from an SDK `Server` with a scripted TOOL
// table. That half went with the CLI's MCP transport (11.5.6) — a request to
// anything but `/api/v1` now 404s, which is exactly what a CLI reaching for the
// old protocol would deserve.

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
  /**
   * The parsed JSON request body, or `undefined` when the request sent none.
   *
   * A read is fully described by its path and query, so this stayed unrecorded
   * until the work loop's WRITES arrived (MOTIR-2213) — and for those it is the
   * only place the interesting argument lives. `implementationHarness` rides in
   * the body, so a test that cannot see the body cannot tell a client that
   * forwards it from one that silently drops it.
   */
  body: unknown;
}

export interface TestServer {
  /** Base URL for the CLI (`--server`), no trailing slash. */
  url: string;
  /** Every `/api/v1` request the server received, in order. */
  v1Calls: V1Request[];
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

export interface TestServerOptions {
  /** The bearer the server accepts; anything else gets a 401 (the shape
   *  the v1 routes return for an absent / invalid / revoked token). */
  token?: string;
  /** The `/api/v1` routes to serve. Merged over {@link DEFAULT_V1}. */
  v1?: V1Script;
  /** Start rejecting the (valid) token after this many requests — a token
   *  REVOKED mid-session, which the CLI must report as an auth failure on the
   *  call rather than as a generic crash. */
  revokeAfterRequests?: number;
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const token = opts.token ?? 'test-token';
  const v1Calls: V1Request[] = [];
  let v1: V1Script = { ...DEFAULT_V1, ...(opts.v1 ?? {}) };

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
        // Drained BEFORE the route match, because an unmatched request must not
        // leave an unread socket behind.
        const v1Chunks: Buffer[] = [];
        for await (const chunk of req) v1Chunks.push(chunk as Buffer);
        const v1Raw = Buffer.concat(v1Chunks).toString('utf8');
        const v1Body: unknown = v1Raw.length > 0 ? JSON.parse(v1Raw) : undefined;

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
        const request: V1Request = { ...matched.request, body: v1Body };
        v1Calls.push(request);
        const reply = typeof matched.reply === 'function' ? matched.reply(request) : matched.reply;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'NOT_FOUND',
          error: `not a v1 route: ${req.method} ${url.pathname}`,
        }),
      );
    })();
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    v1Calls,
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
        // The body is attached by the caller, which is where it is read off the
        // socket; matching is a function of the path alone.
        request: { method, path: url.pathname, params, query: url.searchParams, body: undefined },
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

// ─────────────────────────────────────────────────────────────────────────────
// The `/api/v1` defaults (Subtask 11.5.4 — MOTIR-2212)
// ─────────────────────────────────────────────────────────────────────────────
//
// The payloads that let `auth login`, `link` and `doctor` complete without a
// test scripting anything; each slice of the port added the routes and builders
// its own methods needed.
//
// ⚠️ They are written as REAL v1 shapes, and always were — never derived from
// the MCP `DEFAULT_TOOLS` table that used to sit above them, because that would
// have made every read test a round-trip through the adapter's own inverse:
// green whether or not either side matched the server. (The tool table itself
// went with the CLI's MCP transport in 11.5.6.)

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
    // Amendment 17's readiness qualifier — null is "ready from the trunk", which
    // is what a fixture row should be unless a test is about the other case.
    inheritedSessionBranch: null,
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

/** One v1 work-item REFERENCE — a link target, a child, an open blocker. */
export function v1Ref(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    kind: 'subtask',
    title: key,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    estimateMinutes: null,
    storyPoints: null,
    parentKey: null,
    archived: false,
    ...over,
  };
}

/** The v1 work-item DETAIL aggregate. */
export function v1Detail(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    kind: 'subtask',
    type: 'code',
    title: key,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'user-1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    descriptionMd: null,
    parentKey: null,
    ancestorKeys: [],
    children: [],
    links: { blockedBy: [], blocks: [], relatesTo: [], duplicates: [], clones: [] },
    readiness: {
      ready: true,
      openBlockers: [],
      blockedByAncestorKey: null,
      blockedByAncestorTitle: null,
    },
    labels: [],
    components: [],
    commentCount: 0,
    sprintId: null,
    targetRepo: null,
    executor: 'coding_agent',
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
    ...over,
  };
}

/** The activity page — the ranked envelope plus its two per-source totals. */
export function v1Activity(
  items: unknown[] = [],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items,
    nextCursor: null,
    totalCount: items.length,
    totalComments: 0,
    totalChanges: 0,
    ...over,
  };
}

/**
 * The v1 dispatch prompt.
 *
 * Carries `targetRepoCloneUrl` and `targetRepoDefaultBranch` even though no CLI
 * view model declares them, because a fixture's job is to be what the SERVER
 * sends: a payload trimmed to what the client happens to read would stop
 * exercising the adapter's decision to drop them, which is the only place that
 * decision is expressible.
 */
export function v1DispatchPrompt(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    prompt: `Prompt for ${key}`,
    // MOTIR-2445 — the parent, promoted out of the prompt's prose. The client
    // VALIDATES this body, so an omission fails the run rather than the render.
    parentKey: null,
    targetRepo: null,
    targetRepoCloneUrl: null,
    targetRepoDefaultBranch: null,
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    advisories: [],
    ...over,
  };
}

/** The integration record — the item's new status and its stamped provenance. */
export function v1Integration(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    status: 'in_review',
    sessionBranch: 'motir/session-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    ...over,
  };
}

/** One item's outcome in a session close-out. */
export function v1CloseOutItem(key: string, over: Record<string, unknown> = {}) {
  return { key, outcome: 'completed', ...over };
}

/** The bulk session close-out. */
export function v1CloseOut(sessionBranch: string, results: unknown[] = []) {
  return { sessionBranch, results };
}

/** The planner job handle an expansion submit answers with. */
export function v1JobHandle(over: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    planId: 'plan-1',
    statusUrl: '/api/v1/plans/plan-1',
    ...over,
  };
}

/** One row of the work-item COLLECTION (`WorkItemSummary`). */
export function v1WorkItem(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    kind: 'subtask',
    type: 'code',
    title: key,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    reporterId: 'user-1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependencies: v1Edges(),
    ...over,
  };
}

/** One turn of a planning thread. */
export function v1PlanTurn(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: `turn-${seq}`,
    seq,
    role: 'user',
    body: `Turn ${seq}`,
    jobId: null,
    question: null,
    isAnswer: false,
    authorId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** The planning CONVERSATION, thread included. */
export function v1PlanSession(turns: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    id: 'ps-1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    turns,
    ...over,
  };
}

/** What became of a submitted planning job. */
export function v1PlanOutcome(over: Record<string, unknown> = {}) {
  return {
    planId: 'plan-1',
    status: 'planned',
    origin: 'user',
    jobId: 'job-1',
    proposalCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    plannedAt: '2026-01-01T00:01:00.000Z',
    decidedAt: null,
    job: null,
    ...over,
  };
}

/** ONE proposal — never a work item. */
export function v1Proposal(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    op: 'add',
    workItemKey: null,
    proposedFields: {
      title: `Proposal ${id}`,
      kind: 'subtask',
      type: null,
      priority: null,
      executor: null,
      storyPoints: null,
      estimateMinutes: null,
      descriptionMd: null,
      targetRepo: null,
    },
    patch: null,
    parentRef: null,
    blockedByRefs: [],
    ...over,
  };
}

/** A plan with the proposals it bundles. */
export function v1Plan(proposals: unknown[] = [], over: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    status: 'planned',
    origin: 'user',
    title: null,
    summary: null,
    sourceJobId: 'job-1',
    proposalCount: proposals.length,
    createdAt: '2026-01-01T00:00:00.000Z',
    plannedAt: '2026-01-01T00:01:00.000Z',
    decidedAt: null,
    proposals,
    ...over,
  };
}

/** The canned `/api/v1` answers every suite starts from. */
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
  'GET /api/v1/work-items/{key}': {
    status: 404,
    body: { code: 'NOT_FOUND', error: 'No such work item.' },
  },
  'GET /api/v1/work-items/{key}/activity': { body: v1Activity() },
  'GET /api/v1/projects/{projectKey}/work-items': { body: v1Page([]) },
  // Its OWN operation, not a field on the page above — a collection either
  // promises a total or it does not (ADR Amendment 14).
  'GET /api/v1/projects/{projectKey}/work-items/count': { body: { count: 0 } },
  // The planning conversation. Opening and appending both answer with the
  // WHOLE thread; the submit answers 202 with a job handle and nothing else.
  'POST /api/v1/projects/{projectKey}/plan-session': { body: v1PlanSession() },
  'POST /api/v1/projects/{projectKey}/plan-session/turns': { body: v1PlanSession() },
  'POST /api/v1/projects/{projectKey}/plan-session/submissions': {
    status: 202,
    body: v1JobHandle(),
  },
  'GET /api/v1/plans/{planId}': { body: v1Plan() },
  'GET /api/v1/plans/{planId}/status': { body: v1PlanOutcome() },
  // The write half of the work loop. A transition answers with the item at its
  // new status; nothing in the CLI reads that body, but the transport validates
  // every success, so the default has to be a real one.
  'POST /api/v1/work-items/{key}/transitions': { body: v1Detail('PROD-1') },
  // The CLAIM (MOTIR-2427) — a plain assignment before every dispatch, which
  // answers with the patched item. Every dispatch path makes this call, so it
  // belongs in the DEFAULTS rather than in each command suite's script.
  'PATCH /api/v1/work-items/{key}': { body: v1Detail('PROD-1') },
  'GET /api/v1/work-items/{key}/dispatch-prompt': { body: v1DispatchPrompt('PROD-1') },
  'POST /api/v1/work-items/{key}/integration': { body: v1Integration('PROD-1') },
  'POST /api/v1/sessions/complete': { body: v1CloseOut('motir/session-1') },
  // 202, not 200: the submit is ACCEPTED, and the handle describes a job that
  // has not run yet.
  'POST /api/v1/work-items/{key}/expansions': { status: 202, body: v1JobHandle() },
};
