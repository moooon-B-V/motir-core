import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_ME } from '@/app/api/v1/me/route';
import { GET as GET_WORKSPACES } from '@/app/api/v1/workspaces/route';
import { GET as GET_PROJECTS } from '@/app/api/v1/projects/route';
import { GET as GET_READY } from '@/app/api/v1/projects/[projectKey]/ready/route';
import { GET as GET_SPRINTS } from '@/app/api/v1/projects/[projectKey]/sprints/route';
import { GET as GET_WORK_ITEMS } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as GET_COUNT } from '@/app/api/v1/projects/[projectKey]/work-items/count/route';
import { GET as GET_DETAIL } from '@/app/api/v1/work-items/[key]/route';
import { GET as GET_ACTIVITY } from '@/app/api/v1/work-items/[key]/activity/route';
import { GET as GET_COMMENTS } from '@/app/api/v1/work-items/[key]/comments/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { commentsService } from '@/lib/services/commentsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { MotirClient } from '../../../packages/cli/src/client';
import { validators } from '../../../packages/cli/src/api/index';
import {
  renderCommentThread,
  renderReadyTable,
  renderSprintsTable,
  renderWorkItemDetail,
} from '../../../packages/cli/src/render';
import { RateLimitError, ScopeError } from '../../../packages/cli/src/errors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// THE TRANSPORT SEAMS (Story 11.5 · Subtask 11.5.7 — MOTIR-2215).
//
// ── What this suite is FOR, and why it is not more unit tests ───────────────
// Every code card in Story 11.5 shipped unit tests, and every one of them runs
// against a fixture its own author wrote. That is the right floor and it has
// one blind spot, which happens to be the blind spot a transport migration
// falls into: a fixture describes what the author BELIEVES the server returns.
// If that belief is wrong, the adapter, the adapter's test and the renderer's
// test all agree with each other, all disagree with production, and all are
// green.
//
// So this suite removes every place an assumption could stand in for the
// server. One request goes:
//
//   REAL route handler (real Postgres, real service, real schema mapper)
//     → REAL V1Transport (its URL builder, its bearer, its GENERATED VALIDATOR)
//       → REAL adapter in packages/cli/src/adapters/
//         → REAL renderer in packages/cli/src/render.ts
//           → the text a user sees
//
// Nothing in that chain is written here. The only thing this file supplies is a
// socket: a real `node:http` server that hands each request to the route it
// addresses, so the client under test reaches it exactly as it reaches a
// deployed Motir.
//
// ⚠️ It differs from `cli-renderers-from-v1.test.ts` in the one way that
// matters. That suite (11.7.2, written before the CLI had an adapter) asks
// whether v1's PROJECTIONS are sufficient, and answers it with a hand-written
// adapter inlined in the test — deliberately, because no other adapter existed.
// This one asks whether the SHIPPED adapter is correct, so a hand-written one
// would defeat the entire purpose: two adapters agreeing with each other says
// nothing about either agreeing with the server.
//
// ── The VALIDATOR is under test here too, and for free ──────────────────────
// `test/api-validators.test.ts` in the package feeds the generated validators
// hand-written samples. Every request below goes through `V1Transport.request`,
// which runs the real generated validator over the real route's body — so an
// emitter that grew a field the generated document has not been regenerated for
// fails HERE, on the response, rather than at a user's terminal.

// ─────────────────────────────────────────────────────────────────────────────
// The server the client talks to
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/**
 * Every read route the CLI's methods address, keyed by its path TEMPLATE —
 * the same spelling `V1_OPERATIONS` uses, so a row here reads like the
 * operation it serves.
 */
const ROUTES: Record<string, Handler> = {
  'GET /api/v1/me': GET_ME as Handler,
  'GET /api/v1/workspaces': GET_WORKSPACES as Handler,
  'GET /api/v1/projects': GET_PROJECTS as Handler,
  'GET /api/v1/projects/{projectKey}/ready': GET_READY as Handler,
  'GET /api/v1/projects/{projectKey}/sprints': GET_SPRINTS as Handler,
  'GET /api/v1/projects/{projectKey}/work-items': GET_WORK_ITEMS as Handler,
  'GET /api/v1/projects/{projectKey}/work-items/count': GET_COUNT as Handler,
  'GET /api/v1/work-items/{key}': GET_DETAIL as Handler,
  'GET /api/v1/work-items/{key}/activity': GET_ACTIVITY as Handler,
  'GET /api/v1/work-items/{key}/comments': GET_COMMENTS as Handler,
};

/** Resolve a concrete path against a template, returning its `{name}` params. */
function matchTemplate(template: string, path: string): Record<string, string> | null {
  const wanted = template.split('/');
  const actual = path.split('/');
  if (wanted.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const here = actual[index] as string;
    if (segment.startsWith('{') && segment.endsWith('}')) {
      params[segment.slice(1, -1)] = decodeURIComponent(here);
      continue;
    }
    // ⚠️ A LITERAL segment must beat a placeholder, which is why the whole
    // template is matched rather than a prefix: `…/work-items/count` and
    // `…/work-items/{key}` are otherwise the same route, and the count endpoint
    // would answer as a work item called "count".
    if (segment !== here) return null;
  }
  return params;
}

/** One request the server actually served — the paging assertions read it. */
interface ServedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

const served: ServedRequest[] = [];
let http: HttpServer;
let baseUrl: string;

/**
 * A REAL HTTP server in front of the real route handlers.
 *
 * A socket rather than a stubbed `fetch`, and the choice is deliberate: it is
 * the convention `V1TransportOptions.fetchImpl` records ("tests drive a REAL
 * stub HTTP server over a real socket rather than replacing this — a mocked
 * `fetch` would prove nothing about the request actually put on the wire"), and
 * it means `MotirClient` needs no test-only seam to be driven from here. The
 * header the transport sets, the query string it builds and the status the
 * route returns all make a genuine round trip.
 *
 * The server itself is deliberately dumb: it never synthesises a response, and
 * a path it cannot route gets a bare 404 with no envelope — the shape a server
 * LACKING the endpoint returns, which is what the version-skew probe exists to
 * notice.
 */
async function startRouteServer(): Promise<void> {
  http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = (req.method ?? 'GET').toUpperCase();
      served.push({ method, path: url.pathname, query: url.searchParams });

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');

      const request = new Request(new URL(url.pathname + url.search, baseUrl), {
        method,
        headers: Object.entries(req.headers).flatMap(([name, value]) =>
          typeof value === 'string' ? [[name, value] as [string, string]] : [],
        ),
        ...(raw.length > 0 ? { body: raw } : {}),
      });

      const matched = matchRoute(method, url.pathname);
      if (!matched) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      const response = await matched.handler(request, {
        params: Promise.resolve(matched.params),
      });
      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      res.writeHead(response.status, headers);
      res.end(body);
    })();
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function matchRoute(
  method: string,
  path: string,
): { handler: Handler; params: Record<string, string> } | null {
  for (const [key, handler] of Object.entries(ROUTES)) {
    const [routeMethod, template] = key.split(' ') as [string, string];
    if (routeMethod !== method) continue;
    const params = matchTemplate(template, path);
    if (params) return { handler, params };
  }
  return null;
}

/** A CLI client whose every request lands on a real route handler. */
function clientFor(caller: V1ProjectCaller): MotirClient {
  return new MotirClient({ serverUrl: baseUrl, token: caller.token });
}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(startRouteServer);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    http.closeAllConnections();
    http.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('wire → transport → adapter → renderer, over real routes', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    served.length = 0;
    caller = await createV1ProjectCaller();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRateLimitStore();
  });

  it('IDENTITY — whoami resolves the workspace the token is bound to', async () => {
    const who = await clientFor(caller).whoami();

    expect(who.user.email).toBe(caller.user.email);
    expect(who.workspace?.slug).toBe(caller.workspace.slug);
  });

  it('PROJECTS — the collection reaches the CLI as its own view model', async () => {
    const { projects } = await clientFor(caller).listProjects();

    expect(projects.map((p) => p.key)).toContain(caller.projectKey);
    // `accessLevel` is a field the CLI RENDERS. A wire rename would show up as
    // an empty column, never as an error, which is why it is asserted by value.
    expect(projects[0]!.accessLevel).toBeTruthy();
  });

  it('READY — the row a real route emits renders through the real table', async () => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'task',
        title: 'Wire the seam',
        priority: 'high',
        assigneeId: caller.user.id,
      },
      caller.ctx,
    );

    const page = await clientFor(caller).listReady({ projectKey: caller.projectKey });
    const rendered = renderReadyTable(page.items);

    expect(page.items.map((row) => row.key)).toContain(item.identifier);
    expect(rendered).toContain(item.identifier);
    expect(rendered).toContain('Wire the seam');
    // Amendment 10 Q1's actor: the NAME, off the row the route already read.
    // Before that field existed the renderer printed `unassigned` for every
    // assigned row — a wrong answer no status code would have reported.
    expect(rendered).toContain(caller.user.name);
    expect(rendered).not.toContain('unassigned');
  });

  it('DETAIL — the resource renders, and `--json` carries the SERVER payload', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'A detail read' },
      caller.ctx,
    );

    const { detail, payload } = await clientFor(caller).readWorkItem(item.identifier);
    expect(renderWorkItemDetail(detail)).toContain('A detail read');

    // ADR Amendment 14: `--json` emits the RESOURCE, not the CLI's narrowed
    // view of it. Asserted against the payload's own keys, because the whole
    // point is that it carries fields the view model drops.
    const keys = Object.keys(payload as Record<string, unknown>);
    // ⚠️ `key`, not `identifier` — ADR §7: v1 addresses a work item by its
    // `MOTIR-<n>` KEY, and the internal identifier never crosses the boundary.
    // (This assertion was written the other way round first, and the seam is
    // what corrected it: a hand-written fixture would have agreed with the
    // mistake.)
    expect(keys).toContain('key');
    expect(keys).toContain('descriptionMd');
    // The view model is deliberately LOSSY, so the resource must be strictly
    // richer — that gap IS the reason `--json` bypasses it.
    expect(keys.length).toBeGreaterThan(Object.keys(detail).length);
  });

  it('SPRINTS — a real sprint reaches the sprint table', async () => {
    await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Seam sprint', goal: 'prove the chain' },
      caller.ctx,
    );

    const { sprints } = await clientFor(caller).listSprints({ projectKey: caller.projectKey });
    expect(renderSprintsTable(sprints)).toContain('Seam sprint');
  });

  it('COMMENTS — the author NAME survives route → adapter → renderer', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Commented' },
      caller.ctx,
    );
    await commentsService.addComment(item.id, { bodyMd: 'the first word' }, caller.ctx);

    const page = await clientFor(caller).getWorkItemActivity({
      key: item.identifier,
      view: 'comments',
    });
    const rendered = ('threads' in page ? page.threads : [])
      .map((thread) => renderCommentThread(thread, new Date()))
      .join('\n');

    expect(rendered).toContain('the first word');
    expect(rendered).toContain(caller.user.name);
  });

  it('COUNT — a real count reaches the CLI as a number, not a page', async () => {
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'countable' },
      caller.ctx,
    );

    // Amendment 12: counting is its OWN operation, so this is one request and
    // says what it is — rather than a page read for its `total`.
    const total = await clientFor(caller).countWorkItems({ projectKey: caller.projectKey });
    expect(total).toBeGreaterThanOrEqual(1);
  });
});

describe('paging — a real multi-page collection, walked to exhaustion', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    served.length = 0;
    caller = await createV1ProjectCaller();
  });

  // ⚠️ ONE MORE THAN A PAGE. `DEFAULT_PAGE_LIMIT` is 50, and the CLI's walk
  // takes no `limit`, so 51 is the smallest seed that forces the server to mint
  // a real cursor. Seeding 7 and asserting "every row exactly once" passes on a
  // single response and proves nothing about paging at all — which is what the
  // first version of this test did, and why the request COUNT is asserted below
  // rather than assumed.
  const SEED = 51;

  it('yields every row exactly once, and never inspects the cursor', async () => {
    const created: string[] = [];
    for (let batch = 0; batch < SEED; batch += 10) {
      const made = await Promise.all(
        Array.from({ length: Math.min(10, SEED - batch) }, (_unused, n) =>
          workItemsService.createWorkItem(
            { projectId: caller.fixture.projectId, kind: 'task', title: `Row ${batch + n}` },
            caller.ctx,
          ),
        ),
      );
      created.push(...made.map((item) => item.identifier));
    }

    // `listReadyForDispatch` is the CLI's own exhaustive walk — the one
    // `motir batch` snapshots with. Driving THAT rather than a loop written
    // here is the point: a paging bug in the client is invisible to a test that
    // does the paging itself.
    served.length = 0;
    const items = await clientFor(caller).listReadyForDispatch({
      projectKey: caller.projectKey,
    });

    const keys = items.map((item) => item.key);
    expect(new Set(keys).size, 'a row came back twice').toBe(keys.length);
    for (const identifier of created) expect(keys).toContain(identifier);

    // It really did page — otherwise "every row exactly once" is trivially true
    // of a single response and this test proves nothing.
    const readyCalls = served.filter((r) => r.path.endsWith('/ready'));
    expect(readyCalls.length).toBeGreaterThan(1);

    // ⚠️ THE CURSOR IS ECHOED, NEVER REBUILT (ADR §5). Each request after the
    // first carries a cursor, and each one is a value the server minted — a
    // client that re-encoded it would be depending on an encoding the server is
    // free to change.
    const cursors = readyCalls.slice(1).map((r) => r.query.get('cursor'));
    expect(cursors.every((cursor) => typeof cursor === 'string' && cursor.length > 0)).toBe(true);
  });
});

describe('the error path, end to end from a real refusal', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    served.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRateLimitStore();
  });

  it('a real 403 becomes a ScopeError NAMING the scope the operation needs', async () => {
    // A token with a write scope and no `read`: the routes below all gate on
    // `read`, so the refusal comes from the shipped scope gate rather than from
    // anything arranged here.
    const scopeless = await createV1ProjectCaller({ scopes: ['work_items:write'] });

    const failure = await clientFor(scopeless)
      .whoami()
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ScopeError);
    // The CLI reads the scope off its OWN operation table rather than parsing
    // the server's sentence — ADR Q5's instruction, and what makes the message
    // actionable ("this token lacks X") instead of "forbidden".
    expect((failure as ScopeError).message).toContain('read');
  });

  it('a real 429 becomes a RateLimitError carrying the reset the server sent', async () => {
    const caller = await createV1ProjectCaller();
    vi.stubEnv('MOTIR_API_V1_RATE_LIMIT', '1');

    const client = clientFor(caller);
    // The first call spends the whole budget; the second is refused by the real
    // limiter in the real wrapper, with the real `x-ratelimit-reset` header.
    await client.countWorkItems({ projectKey: caller.projectKey });
    const failure = await client
      .countWorkItems({ projectKey: caller.projectKey })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(RateLimitError);
    expect((failure as RateLimitError).message).toMatch(/rate limit/i);
    // The WAIT comes from the header, not from a guess — which is the only
    // reason the CLI can tell a user when to try again.
    expect((failure as RateLimitError).message).toMatch(/\d/);
  });
});

describe('the generated validators, against the EMITTER rather than a sample', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    served.length = 0;
    caller = await createV1ProjectCaller();
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Validated' },
      caller.ctx,
    );
  });

  // ⚠️ WHY THIS IS NOT `packages/cli/test/api-validators.test.ts`.
  //
  // That suite round-trips a representative body from each family through its
  // validator, and every one of those bodies is a LITERAL written beside the
  // assertion. It proves the generated artifact is usable. It cannot prove the
  // artifact matches what the server EMITS today, because nothing in it has
  // ever met the server — if a schema module grows a field and the committed
  // client is not regenerated, both halves of that suite stay green.
  //
  // Here the payload comes out of the real route. A validator that rejects it,
  // or a schema that has drifted from the document the validators were built
  // from, fails on this line.
  const FAMILIES: { operationId: string; read: () => Promise<Response> }[] = [
    {
      operationId: 'getMe',
      read: () => callRoute('GET', '/api/v1/me'),
    },
    {
      operationId: 'listWorkspaces',
      read: () => callRoute('GET', '/api/v1/workspaces'),
    },
    {
      operationId: 'listProjects',
      read: () => callRoute('GET', '/api/v1/projects'),
    },
    {
      operationId: 'getProjectReadySet',
      read: () => callRoute('GET', `/api/v1/projects/${caller.projectKey}/ready`),
    },
    {
      operationId: 'listProjectSprints',
      read: () => callRoute('GET', `/api/v1/projects/${caller.projectKey}/sprints`),
    },
    {
      operationId: 'listProjectWorkItems',
      read: () => callRoute('GET', `/api/v1/projects/${caller.projectKey}/work-items`),
    },
    {
      operationId: 'countProjectWorkItems',
      read: () => callRoute('GET', `/api/v1/projects/${caller.projectKey}/work-items/count`),
    },
  ];

  /** One request through the running server, with the caller's real bearer. */
  async function callRoute(method: string, path: string): Promise<Response> {
    return fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${caller.token}` },
    });
  }

  it.each(FAMILIES)('$operationId accepts what the route emits', async ({ operationId, read }) => {
    const response = await read();
    expect(response.status, `${operationId} did not answer 200`).toBe(200);
    const body: unknown = await response.json();

    const validate = (validators as Record<string, (data: unknown) => boolean>)[
      `operation_${operationId}`
    ];
    expect(validate, `no generated validator for ${operationId}`).toBeTypeOf('function');

    const accepted = validate!(body);
    const errors = (validate as unknown as { errors?: { instancePath?: string }[] | null }).errors;
    expect(
      accepted,
      `${operationId}: the generated validator REJECTED the live response at ` +
        `${JSON.stringify(errors?.map((e) => e.instancePath))}. Regenerate the client ` +
        '(`pnpm generate:cli-api`) — or the schema drifted from the document.',
    ).toBe(true);
  });

  it('and REJECTS a body the emitter could not have produced', () => {
    // The anti-vacuity half: a validator that accepted everything would pass
    // every assertion above, which is the failure mode a "does it accept the
    // real thing" test cannot see on its own.
    expect(validators.operation_getMe({ user: { id: 'u' } })).toBe(false);
  });
});
