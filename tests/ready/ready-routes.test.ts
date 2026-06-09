import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Ready-set API routes — `GET /api/ready` (the list/browse consumer, Subtask
// 7.0.4) + `POST /api/ready/next` (the BYOK dispatch consumer, 7.0.5). Real
// Postgres; every DB read goes through the real route → projectsService.getByKey
// → workItemsService → repository → Prisma chain (the readiness predicate, sort,
// cursor, and DTO mapping are already covered service-side in
// `listReady.test.ts`). These tests assert the TRANSPORT contract these two
// routes own: the workspace/session gate, the `?projectKey` → 404-not-403
// no-existence-leak resolution, the hand-validation 400s, the `Cache-Control`
// header, and the 204-on-empty dispatch semantics.
//
// We stub ONLY `getWorkspaceContext` — the session+active-workspace resolver the
// routes read, which the test env can't supply (no cookies). This is the same
// "mock the context resolver the env can't provide" exception the board-routes
// suite takes for `getSession`/`getActiveProject`; these routes happen to read
// the workspace context through `getWorkspaceContext` (the `getSession`
// analogue, lib/workspaces/index.ts). The mock is PARTIAL (importOriginal) so
// the real `withWorkspaceContext` — the RLS-binding transaction every service
// call below depends on — is preserved untouched.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// Import the handlers AFTER the mock is registered.
const { GET: readyGET } = await import('@/app/api/ready/route');
const { POST: nextPOST } = await import('@/app/api/ready/next/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Sign the test in as the fixture's owner, scoped to its workspace. */
function signInAs(fx: WorkItemFixture) {
  ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

/** Create a ready (todo, unblocked) work item the way the service does. */
async function make(
  fx: WorkItemFixture,
  opts: {
    title?: string;
    kind?: 'task' | 'bug' | 'story';
    priority?: 'lowest' | 'low' | 'medium' | 'high' | 'highest';
    assigneeId?: string | null;
    descriptionMd?: string | null;
  } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title ?? 'Item',
      priority: opts.priority,
      assigneeId: opts.assigneeId ?? null,
      descriptionMd: opts.descriptionMd ?? null,
    },
    fx.ctx,
  );
}

function getReq(query = '') {
  return readyGET(new Request(`${BASE}/api/ready${query}`));
}

function nextReq(body: unknown, opts: { raw?: string } = {}) {
  return nextPOST(
    new Request(`${BASE}/api/ready/next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
    }),
  );
}

describe('GET /api/ready — list endpoint (Subtask 7.0.4)', () => {
  it('200 + `{ items, nextCursor }` shape and per-row DTO fields for the happy path', async () => {
    const fx = await makeWorkItemFixture();
    const item = await make(fx, { title: 'Ready one', priority: 'high' });
    signInAs(fx);

    const res = await getReq('?projectKey=PROD');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
    const row = body.items.find((i: { key: string }) => i.key === item.identifier);
    expect(row).toBeTruthy();
    // The cheap card-row DTO (ReadyItemDto) — not the dispatch payload.
    expect(row).toMatchObject({
      id: item.id,
      key: item.identifier,
      kind: 'task',
      title: 'Ready one',
      priority: 'high',
    });
    expect(row.status).toMatchObject({ category: expect.any(String) });
    expect(row).toHaveProperty('assignee');
    expect(row).toHaveProperty('descriptionExcerpt');
    // The list row must NOT carry the heavy dispatch-only fields.
    expect(row).not.toHaveProperty('descriptionMd');
    expect(row).not.toHaveProperty('runCommand');
  });

  it('sends `Cache-Control: private, no-store` (readiness is never cached)', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'X' });
    signInAs(fx);

    const res = await getReq('?projectKey=PROD');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('emits a `nextCursor` when more remain and resumes deterministically', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'a', priority: 'highest' });
    await make(fx, { title: 'b', priority: 'high' });
    await make(fx, { title: 'c', priority: 'medium' });
    signInAs(fx);

    const first = await getReq('?projectKey=PROD&limit=2');
    const firstBody = await first.json();
    expect(firstBody.items).toHaveLength(2);
    expect(typeof firstBody.nextCursor).toBe('string');

    const second = await getReq(
      `?projectKey=PROD&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    const secondBody = await second.json();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    // No overlap between the two pages — the cursor seeks past page one.
    const firstKeys = firstBody.items.map((i: { key: string }) => i.key);
    const secondKeys = secondBody.items.map((i: { key: string }) => i.key);
    expect(firstKeys).not.toContain(secondKeys[0]);
  });

  it('401 when there is no session', async () => {
    const res = await getReq('?projectKey=PROD');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('400 when `projectKey` is missing', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await getReq('');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('404 (not 403) on a cross-tenant / unknown projectKey — no existence leak', async () => {
    const fx = await makeWorkItemFixture();
    // A project that exists, but in a DIFFERENT workspace.
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    await make(other, { title: 'theirs' });
    signInAs(fx); // authed as workspace A, asking for workspace B's key

    const res = await getReq('?projectKey=OTHER');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('400 on a malformed cursor (InvalidReadyCursorError)', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'X' });
    signInAs(fx);
    const res = await getReq('?projectKey=PROD&cursor=not-a-cursor!!');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: expect.any(String) });
  });

  it('400 on an unknown enum facet (a typo would otherwise silently match nothing)', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await getReq('?projectKey=PROD&kinds=task,wat');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('clamps an over-cap / non-numeric `limit` silently (200, never 400 — CLI-friendly)', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'X' });
    signInAs(fx);
    expect((await getReq('?projectKey=PROD&limit=9999')).status).toBe(200);
    expect((await getReq('?projectKey=PROD&limit=notanumber')).status).toBe(200);
  });

  it('the `kinds` facet narrows the result set', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'a task', kind: 'task' });
    const bug = await make(fx, { title: 'a bug', kind: 'bug' });
    signInAs(fx);

    const res = await getReq('?projectKey=PROD&kinds=bug');
    const body = await res.json();
    expect(body.items.map((i: { key: string }) => i.key)).toEqual([bug.identifier]);
  });
});

describe('POST /api/ready/next — dispatch endpoint (Subtask 7.0.5)', () => {
  it('200 + a full ReadyItemDispatchDto for the first item under the sort', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await make(fx, { title: 'Parent story', kind: 'story' });
    const descriptionMd = [
      'Do the thing.',
      '',
      '## Context refs',
      '',
      '- `lib/services/workItemsService.ts` — the service',
    ].join('\n');
    const top = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Top',
        priority: 'highest',
        parentId: parent.id,
        descriptionMd,
      },
      fx.ctx,
    );
    signInAs(fx);

    // Exclude the (childless-leaf) parent story so the highest-priority task wins.
    const res = await nextReq({ projectKey: 'PROD', excludeIds: [parent.id] });
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.key).toBe(top.identifier);
    expect(dto.descriptionMd).toBe(descriptionMd);
    expect(dto.contextRefs).toEqual(['lib/services/workItemsService.ts']);
    expect(dto.parentKey).toBe(parent.identifier);
    expect(dto.runCommand).toBe(`prodect run ${top.identifier}`);
    expect(dto.runCommand).toMatch(/^prodect run PROD-\d+$/);
    expect(Array.isArray(dto.blockerKeys)).toBe(true);
  });

  it('`excludeIds` walks the set: a second call returns the next item under the sort', async () => {
    const fx = await makeWorkItemFixture();
    const top = await make(fx, { title: 'top', priority: 'highest' });
    const mid = await make(fx, { title: 'mid', priority: 'medium' });
    signInAs(fx);

    const first = await nextReq({ projectKey: 'PROD' });
    expect((await first.json()).key).toBe(top.identifier);

    const second = await nextReq({ projectKey: 'PROD', excludeIds: [top.id] });
    expect((await second.json()).key).toBe(mid.identifier);
  });

  it('204 (no body) when the filtered ready set is empty', async () => {
    const fx = await makeWorkItemFixture();
    const only = await make(fx, { title: 'only' });
    signInAs(fx);

    // Exhaust the set via excludeIds → nothing left → 204.
    const res = await nextReq({ projectKey: 'PROD', excludeIds: [only.id] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('204 against a real-but-empty project (unambiguous vs. a missing project, which 404s)', async () => {
    const fx = await makeWorkItemFixture(); // project PROD exists, has no ready items
    signInAs(fx);
    const res = await nextReq({ projectKey: 'PROD' });
    expect(res.status).toBe(204);
  });

  it('the `kinds` facet narrows the dispatch candidate set', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'a task', kind: 'task', priority: 'highest' });
    const bug = await make(fx, { title: 'a bug', kind: 'bug', priority: 'low' });
    signInAs(fx);

    // Highest-priority item is the task, but kinds:["bug"] forces the bug.
    const res = await nextReq({ projectKey: 'PROD', kinds: ['bug'] });
    expect((await res.json()).key).toBe(bug.identifier);
  });

  it('401 when there is no session', async () => {
    const res = await nextReq({ projectKey: 'PROD' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('404 (not 403) on a cross-tenant / unknown projectKey', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHER' });
    await make(other, { title: 'theirs' });
    signInAs(fx);

    const res = await nextReq({ projectKey: 'OTHER' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('400 on a non-JSON body', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await nextReq(undefined, { raw: 'not json{' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('400 when `projectKey` is missing from the body', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await nextReq({ kinds: ['task'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('400 on a malformed `excludeIds` (not an array of strings)', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await nextReq({ projectKey: 'PROD', excludeIds: [42] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('400 on an unknown enum facet value', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await nextReq({ projectKey: 'PROD', kinds: ['wat'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
