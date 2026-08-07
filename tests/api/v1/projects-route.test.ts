import type { Workspace } from '@/generated/prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { GET as GET_LIST } from '@/app/api/v1/projects/route';
import { GET as GET_ONE } from '@/app/api/v1/projects/[projectKey]/route';
import { projectSchema, type V1Project } from '@/lib/api/v1/projects/schema';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { createV1Caller, createV1ProjectCaller, withTokenFor } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects + GET /api/v1/projects/{projectKey} (Story 11.3 ·
// Subtask 11.3.3 — MOTIR-2060) against real Postgres.
//
// The cursor primitive's own branches live in `collection-cursor.test.ts`; this
// file asserts the ENDPOINTS — what a real client holding a real PAT sees, and
// in particular that the two DIFFERENT refusal paths (cross-tenant, and
// same-tenant-not-browsable) give the SAME answer.

const LIST = 'http://localhost:3000/api/v1/projects';

function listReq(headers: Record<string, string>, query = ''): Request {
  return new Request(`${LIST}${query}`, { headers });
}

function oneReq(headers: Record<string, string>, key: string): Request {
  return new Request(`${LIST}/${key}`, { headers });
}

function params(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

/**
 * A PLAIN workspace member (not the owner) holding a read token.
 *
 * The browse gate keeps a workspace OWNER able to see every project, private
 * ones included — so a not-browsable case asserted as the owner would pass for
 * the wrong reason. Only an ordinary member is actually gated.
 */
async function memberCaller(workspace: Workspace) {
  const user = await createTestUser();
  // Through the SERVICE, not a raw insert: workspace access is gated on ORG
  // membership too (`organizationsService.resolveWorkspaceAccess` refuses a
  // stale workspace-membership row with no org row behind it), and `addMember`
  // is what performs that upward auto-join.
  await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id, role: 'member' });
  return withTokenFor(user, workspace, { scopes: ['read'] });
}

interface Page {
  items: V1Project[];
  nextCursor: string | null;
}

async function fetchPage(headers: Record<string, string>, query = ''): Promise<Page> {
  const res = await GET_LIST(listReq(headers, query));
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/**
 * Walk the WHOLE collection using ONLY the cursors the server returned — never
 * a hand-built one, because that is precisely what an external client cannot do.
 */
async function walkAll(headers: Record<string, string>, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let guard = 0;

  do {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await fetchPage(headers, query);
    seen.push(...page.items.map((p) => p.key));
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor && guard < 50);

  return seen;
}

describe('GET /api/v1/projects', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the list envelope, gated on the read scope, in the schema shape', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const page = await fetchPage(caller.headers);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      key: caller.projectKey,
      name: 'Motir',
      accessLevel: 'open',
      archived: false,
    });
    // The body IS a schema output, not a shape that merely resembles one.
    expect(() => projectSchema.parse(page.items[0])).not.toThrow();
  });

  it('never puts the internal cuid on the wire (ADR §7)', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await GET_LIST(listReq(caller.headers));
    const body = await res.text();

    expect(body).not.toContain(caller.fixture.projectId);
  });

  it('refuses a token without the read scope', async () => {
    const caller = await createV1Caller({ scopes: ['integration'] });

    const res = await GET_LIST(listReq(caller.headers));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'INSUFFICIENT_SCOPE',
      error: expect.stringContaining('read'),
    });
  });

  it('answers an empty workspace with 200 and empty items, never a 404', async () => {
    const caller = await createV1Caller({ scopes: ['read'] });

    const res = await GET_LIST(listReq(caller.headers));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('pages by cursor and reports nextCursor: null on the LAST page', async () => {
    // Not an extra empty round trip: the last page that carries rows is also the
    // page that says there are no more (ADR §5's terminal case).
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'AAA' });
    for (const identifier of ['BBB', 'CCC']) {
      await createTestProject({
        workspaceId: caller.workspace.id,
        actorUserId: caller.user.id,
        identifier,
      });
    }

    const first = await fetchPage(caller.headers, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(
      caller.headers,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('walks every project exactly once, with no skip and no duplicate', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'AAA' });
    const keys = [caller.projectKey];
    for (const identifier of ['BBB', 'CCC', 'DDD', 'EEE']) {
      const created = await createTestProject({
        workspaceId: caller.workspace.id,
        actorUserId: caller.user.id,
        identifier,
      });
      // The service de-dupes an identifier collision by suffixing, so the key it
      // ASSIGNED is the only thing worth asserting against.
      keys.push(created.identifier);
    }

    const seen = await walkAll(caller.headers, 2);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // In the route's own total order — `key` ascending — which is what makes the
    // cursor sound over a read whose `created_at` order has no tiebreaker.
    expect(seen).toEqual([...keys].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('refuses a cursor issued for a DIFFERENT collection with 422', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    // A structurally identical cursor — a signed row id — from another
    // collection. Without the collection scope this would decode cleanly and
    // silently answer a page positioned by a row not in this list.
    const { encodeCollectionCursor } = await import('@/lib/api/v1/pagination');
    const foreign = encodeCollectionCursor('backlog', caller.fixture.projectId);

    const res = await GET_LIST(listReq(caller.headers, `?cursor=${encodeURIComponent(foreign)}`));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'INVALID_CURSOR', error: expect.any(String) });
  });

  it('clamps the limit to v1 ceiling and rejects a non-positive one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    // Over-cap is answered WITH the cap, not refused.
    expect((await fetchPage(caller.headers, '?limit=500')).items).toHaveLength(1);

    const res = await GET_LIST(listReq(caller.headers, '?limit=0'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'INVALID_LIMIT', error: expect.any(String) });
  });

  it('omits a project the caller cannot BROWSE rather than showing-then-denying', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'OPEN' });
    const secret = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      identifier: 'SECRET',
    });
    // Make it private AND drop the owner's project membership, so the browse
    // gate is the only thing standing between the caller and the row.
    await db.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });
    const member = await memberCaller(caller.workspace);

    const page = await fetchPage(member.headers);

    expect(page.items.map((p) => p.key)).toEqual(['OPEN']);
  });

  it("never lists ANOTHER workspace's projects", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'MINE' });
    await createV1ProjectCaller({ workspaceName: 'Other Co', identifier: 'THEIRS' });

    const page = await fetchPage(caller.headers);

    expect(page.items.map((p) => p.key)).toEqual(['MINE']);
  });

  it('excludes an ARCHIVED project from the list', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'LIVE' });
    const gone = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      identifier: 'GONE',
    });
    await db.project.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });

    const page = await fetchPage(caller.headers);

    expect(page.items.map((p) => p.key)).toEqual(['LIVE']);
  });
});

describe('GET /api/v1/projects/{projectKey}', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the project in the schema shape', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await GET_ONE(oneReq(caller.headers, caller.projectKey), params(caller.projectKey));

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Project;
    expect(body).toEqual({
      key: caller.projectKey,
      name: 'Motir',
      accessLevel: 'open',
      archived: false,
    });
    expect(() => projectSchema.parse(body)).not.toThrow();
  });

  it('resolves a lower-case key, because identifiers are canonically upper-case', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const lower = caller.projectKey.toLowerCase();

    const res = await GET_ONE(oneReq(caller.headers, lower), params(lower));

    expect(res.status).toBe(200);
    expect(((await res.json()) as V1Project).key).toBe(caller.projectKey);
  });

  it('answers an UNKNOWN key with 404 and the error envelope, not a 500', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await GET_ONE(oneReq(caller.headers, 'NOPE'), params('NOPE'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'PROJECT_NOT_FOUND', error: expect.any(String) });
  });

  it('answers a CROSS-TENANT key with 404, never 403', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'MINE' });
    const other = await createV1ProjectCaller({ workspaceName: 'Other Co', identifier: 'THEIRS' });

    const res = await GET_ONE(oneReq(caller.headers, other.projectKey), params(other.projectKey));

    // A 403 here would confirm that THEIRS exists — an existence oracle over
    // another tenant's data (ADR §4).
    expect(res.status).toBe(404);
  });

  it('answers a SAME-TENANT not-browsable key with 404 too — the same answer, a different path', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'], identifier: 'OPEN' });
    const secret = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      identifier: 'SECRET',
    });
    await db.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });
    const member = await memberCaller(caller.workspace);

    const res = await GET_ONE(oneReq(member.headers, 'SECRET'), params('SECRET'));

    // The cross-tenant case above 404s because the read finds nothing; this one
    // 404s because the browse gate refuses. Two code paths, deliberately
    // indistinguishable — otherwise the endpoint enumerates real project keys.
    expect(res.status).toBe(404);
  });

  it('refuses a token without the read scope', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });

    const res = await GET_ONE(oneReq(caller.headers, caller.projectKey), params(caller.projectKey));

    expect(res.status).toBe(403);
  });

  it('reports an ARCHIVED project as archived rather than hiding it', async () => {
    // The list filters archived rows out; a by-key read can still reach one, and
    // a client that could not tell would treat a dead project as live.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await db.project.update({
      where: { id: caller.fixture.projectId },
      data: { archivedAt: new Date() },
    });

    const res = await GET_ONE(oneReq(caller.headers, caller.projectKey), params(caller.projectKey));

    expect(res.status).toBe(200);
    expect(((await res.json()) as V1Project).archived).toBe(true);
  });
});
