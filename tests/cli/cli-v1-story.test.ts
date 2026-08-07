import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { makeCliWorkspace, type CliWorkspace } from '../helpers/cliHarness';

// THE STORY'S END-TO-END (Story 11.5 · Subtask 11.5.8 — MOTIR-2216).
//
// Two things nothing else in the story asserts, both about the SHIPPED artefact
// rather than about its source:
//
//   1. The socket harness really does dispatch `/api/v1`'s DYNAMIC routes — the
//      right handler, with the right segment values, and a 404 for anything it
//      was not asked to serve.
//   2. The BUILT binary handles the states a happy path skips: a scope-refused
//      call and a rate-limited one, over a real socket against real routes.
//
// ── ⚠️ THE CARD'S FIRST DELIVERABLE WAS ALREADY DONE, BY TWO OTHER CARDS ────
// This card was written expecting to TEACH `tests/helpers/mcpHttpServer.ts` to
// match a path pattern: "it serves exactly three paths today… none of them has a
// dynamic path segment, and every `/api/v1` route does." That was true when the
// card was written and is not true now. Story 11.2's conformance work
// (MOTIR-2054) added `matchRoute` with literal-beats-dynamic precedence, and
// MOTIR-2379 turned `v1Routes: true` on in the CLI story suites — so the built
// binary has been driving real v1 routes over this socket for several cards.
//
// What was NOT done, and is the honest remainder: nothing asserted the
// dispatcher DIRECTLY. It is exercised only as a side effect of suites whose
// subject is something else, which is precisely the arrangement the card warns
// about — "getting that wrong produces a harness that 404s or hands a handler
// the wrong key, and the failure would look like a client bug for as long as it
// took someone to suspect the test infrastructure instead." A dispatcher that
// silently matched the WRONG route would surface as a mysterious client bug in
// an unrelated suite. So the first half below tests the harness as a subject.
//
// ── Where the other three non-happy states already live ─────────────────────
// `cli-story.test.ts` covers an EMPTY ready set ("reports nothing to do rather
// than failing"), a REVOKED token ("the same uniform auth failure as an invalid
// one") and an UNKNOWN key ("fails an unknown key and a key in ANOTHER tenant
// the SAME way"). They are not duplicated here; a second copy of an assertion
// is a second place to update and no extra proof.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let server: McpTestServer;
let ws: CliWorkspace;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  ws = makeCliWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitStore();
});

/** A tenant plus a full-scope PAT — what a logged-in terminal holds. */
async function tenant(): Promise<{ fx: WorkItemFixture; token: string }> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'cli',
    scopes: [...TOKEN_SCOPES],
  });
  return { fx, token };
}

/** One request straight at the harness, with a real bearer. */
async function get(path: string, token: string): Promise<Response> {
  return fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe('the socket harness dispatches /api/v1 by PATTERN', () => {
  it('ONE dynamic segment reaches the handler with the right VALUE', async () => {
    const { fx, token } = await tenant();
    const wanted = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The one asked for' },
      fx.ctx,
    );
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Not this one' },
      fx.ctx,
    );

    const res = await get(`/api/v1/work-items/${wanted.identifier}`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; title: string };

    // ⚠️ Asserted by VALUE, not by status. A dispatcher that matched the right
    // PATTERN but handed the handler the wrong segment — or an empty params
    // object — still answers 200, about the wrong row or about nothing. The
    // second item exists so "it returned an item" cannot pass for "it returned
    // the item asked for".
    expect(body.key).toBe(wanted.identifier);
    expect(body.title).toBe('The one asked for');
    expect(body.key).not.toBe(other.identifier);
  });

  it('TWO dynamic segments in one tree, each resolved to its own name', async () => {
    const { fx, token } = await tenant();
    const mine = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'In my project' },
      fx.ctx,
    );
    // A SECOND tenant, so a params bug that dropped `projectKey` would show up
    // as another workspace's rows rather than as an empty list.
    const stranger = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    await workItemsService.createWorkItem(
      { projectId: stranger.projectId, kind: 'task', title: 'Somebody else' },
      stranger.ctx,
    );

    const res = await get(`/api/v1/projects/${fx.projectIdentifier}/work-items`, token);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { key: string; title: string }[] };

    expect(items.map((row) => row.key)).toContain(mine.identifier);
    expect(items.map((row) => row.title)).not.toContain('Somebody else');
  });

  it('a LITERAL segment beats a dynamic one — `…/work-items/count` is the count', async () => {
    const { fx, token } = await tenant();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'countable' },
      fx.ctx,
    );

    // Both `…/work-items/{key}`-shaped and `…/work-items/count` are registered
    // and the same length. Next.js resolves the literal first, and the harness
    // must too — otherwise this answers as a work item named "count", which is
    // a 404 the CLI would report as a missing card.
    const res = await get(`/api/v1/projects/${fx.projectIdentifier}/work-items/count`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count?: number };
    expect(typeof body.count).toBe('number');
    expect(body.count).toBeGreaterThanOrEqual(1);
  });

  it('a literal AFTER a dynamic segment routes to the sub-resource, not the parent', async () => {
    const { fx, token } = await tenant();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Has activity' },
      fx.ctx,
    );

    // `/work-items/{key}` and `/work-items/{key}/activity` differ only by a
    // trailing literal. A matcher that compared prefixes would serve the detail
    // route here and the CLI would render a resource where a stream belongs.
    const res = await get(`/api/v1/work-items/${item.identifier}/activity`, token);
    expect(res.status).toBe(200);
    // The activity page and the resource share no key: the page is a paged
    // envelope with per-entry `type` discriminators, the resource is a work
    // item. Asserting on BOTH sides is what distinguishes "routed correctly"
    // from "routed to the parent and happened to answer 200".
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toContain('nextCursor');
    expect(Object.keys(body)).toContain('totalComments');
    expect(Object.keys(body)).not.toContain('descriptionMd');
  });

  it('a percent-encoded segment arrives DECODED', async () => {
    const { fx, token } = await tenant();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Encoded' },
      fx.ctx,
    );

    const res = await get(`/api/v1/work-items/${encodeURIComponent(item.identifier)}`, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }).key).toBe(item.identifier);
  });

  it('404s a path it was never asked to serve — it is not a catch-all', async () => {
    const { token } = await tenant();

    // The harness's honesty property: a suite that accidentally depends on some
    // other route must FAIL rather than pass against a hand-built fake. Both
    // shapes are checked — an unknown tree, and a v1-looking path with no route
    // module behind it.
    for (const path of ['/api/not-a-surface', '/api/v1/invented-collection']) {
      const res = await get(path, token);
      expect(res.status, `${path} was served`).toBe(404);
    }
  });

  it('a WRONG-LENGTH path does not match a pattern by prefix', async () => {
    const { fx, token } = await tenant();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Deep' },
      fx.ctx,
    );

    // One segment too many. A matcher that stopped comparing at the end of the
    // registered pattern would serve the detail route and quietly ignore the
    // tail — the CLI would then get a 200 for an endpoint that does not exist,
    // which is the one answer it cannot recover from.
    const res = await get(`/api/v1/work-items/${item.identifier}/not-a-sub-resource`, token);
    expect(res.status).toBe(404);
  });
});

describe('the BUILT binary, in the states a happy path skips', () => {
  it('a SCOPE-refused call reports the scope, and exits 1', async () => {
    const { fx, token } = await tenant();
    expect(
      (await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode,
    ).toBe(0);
    expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);

    // A PAT that can WRITE work items and cannot READ anything. The refusal is
    // the shipped scope gate's, over a real socket — not a fixture's idea of
    // what a 403 looks like.
    const { token: writeOnly } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'write-only',
      scopes: ['work_items:write'],
    });

    const result = await ws.run(['ready'], { env: { MOTIR_TOKEN: writeOnly } });

    expect(result.exitCode).toBe(1);
    // The CLI names the scope from its OWN operation table rather than parsing
    // the server's sentence (ADR Q5), which is what makes the message
    // actionable instead of "forbidden".
    expect(result.stderr).toContain('read');
    expect(result.stderr).not.toContain('undefined');
  });

  it('a RATE-LIMITED call reports the wait, and exits 1', async () => {
    const { fx, token } = await tenant();
    expect(
      (await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode,
    ).toBe(0);
    expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);

    // ⚠️ The budget is read PER REQUEST from the environment of the process the
    // ROUTES run in — this one — so stubbing it here changes what the harness
    // enforces without the child knowing anything about it. That is the whole
    // reason a socket harness can test this at all.
    vi.stubEnv('MOTIR_API_V1_RATE_LIMIT', '1');
    resetRateLimitStore();

    const first = await ws.run(['ready']);
    expect(first.exitCode, first.stderr).toBe(0);

    const second = await ws.run(['ready']);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/rate limit/i);
    // The WAIT comes off the server's `x-ratelimit-reset`, not from a guess —
    // the only reason the CLI can tell a user when to try again.
    expect(second.stderr).toMatch(/\d/);
  });
});
