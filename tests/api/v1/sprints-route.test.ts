import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET as GET_LIST } from '@/app/api/v1/projects/[projectKey]/sprints/route';
import { GET as GET_ONE } from '@/app/api/v1/sprints/[sprintId]/route';
import { sprintSchema, type V1Sprint } from '@/lib/api/v1/sprints/schema';
import { encodeCollectionCursor } from '@/lib/api/v1/pagination';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { backlogService } from '@/lib/services/backlogService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/sprints + GET /api/v1/sprints/{sprintId}
// (Story 11.3 · Subtask 11.3.4 — MOTIR-2061) against real Postgres.
//
// Two assertions here are REGRESSION tests rather than coverage: the
// hard-coded `issueCount: 0` this card exists to avoid, and the three distinct
// null/zero states of the activation baseline. Both would pass a shape check
// while being wrong.

const BASE = 'http://localhost:3000/api/v1';

function listReq(caller: V1ProjectCaller, query = ''): Request {
  return new Request(`${BASE}/projects/${caller.projectKey}/sprints${query}`, {
    headers: caller.headers,
  });
}

function projectParams(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

async function readOne(caller: V1ProjectCaller, sprintId: string): Promise<Response> {
  return GET_ONE(
    new Request(`${BASE}/sprints/${sprintId}`, { headers: caller.headers }),
    sprintParams(sprintId),
  );
}

interface Page {
  items: V1Sprint[];
  nextCursor: string | null;
}

async function fetchPage(caller: V1ProjectCaller, query = ''): Promise<Page> {
  const res = await GET_LIST(listReq(caller, query), projectParams(caller.projectKey));
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/** A sprint on the caller's project, created through the shipped service. */
async function makeSprint(caller: V1ProjectCaller, name: string) {
  return sprintsService.createSprint(caller.fixture.projectId, { name }, caller.ctx);
}

/** A work item on the caller's project, assigned to `sprintId`. */
async function seedIssueIn(caller: V1ProjectCaller, sprintId: string, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  await backlogService.assignToSprint(item.id, sprintId, undefined, caller.ctx);
  return item;
}

describe('GET /api/v1/projects/{projectKey}/sprints', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the list envelope in the schema shape, gated on read', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const page = await fetchPage(caller);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      id: sprint.id,
      name: 'Sprint 1',
      goal: null,
      state: 'planned',
      startDate: null,
      endDate: null,
      completedAt: null,
      sequence: 1,
      issueCount: 0,
      committedPoints: null,
      committedIssueCount: null,
    });
    expect(() => sprintSchema.parse(page.items[0])).not.toThrow();
  });

  it('answers a project with no sprints with 200 and empty items, never a 404', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const page = await fetchPage(caller);

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('pages in sequence order and reports nextCursor: null on the last page', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (const name of ['One', 'Two', 'Three']) await makeSprint(caller, name);

    const first = await fetchPage(caller, '?limit=2');
    expect(first.items.map((s) => s.name)).toEqual(['One', 'Two']);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(
      caller,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.items.map((s) => s.name)).toEqual(['Three']);
    expect(second.nextCursor).toBeNull();
  });

  it('orders DUPLICATE sequences deterministically, so the cursor stays sound', async () => {
    // `sequence` has no unique constraint — `createSprint` derives it from a
    // `maxSequence + 1` read that guards a write, so two concurrent creates can
    // collide (the service records this). Under a bare `sequence` ORDER BY the
    // tie comes back in an order Postgres does not promise to repeat, and a
    // cursor cannot page soundly over an order that can shuffle. The route
    // breaks the tie on the row id; this asserts the two pages agree.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const first = await makeSprint(caller, 'One');
    const second = await makeSprint(caller, 'Two');
    await db.sprint.update({ where: { id: second.id }, data: { sequence: first.sequence } });

    const expected = [first, second].map((s) => s.id).sort((a, b) => a.localeCompare(b));

    const page = await fetchPage(caller, '?limit=1');
    expect(page.items.map((s) => s.id)).toEqual([expected[0]]);
    const next = await fetchPage(
      caller,
      `?limit=1&cursor=${encodeURIComponent(page.nextCursor as string)}`,
    );
    expect(next.items.map((s) => s.id)).toEqual([expected[1]]);
  });

  it('refuses a cursor issued for a DIFFERENT collection', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    const foreign = encodeCollectionCursor('backlog', sprint.id);

    const res = await GET_LIST(
      listReq(caller, `?cursor=${encodeURIComponent(foreign)}`),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'INVALID_CURSOR', error: expect.any(String) });
  });

  it('answers an unknown projectKey with 404', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await GET_LIST(listReq(caller), projectParams('NOPE'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'PROJECT_NOT_FOUND', error: expect.any(String) });
  });

  it('refuses a token without the read scope', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });

    const res = await GET_LIST(listReq(caller), projectParams(caller.projectKey));

    expect(res.status).toBe(403);
  });

  it("never lists another project's sprints", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const other = await createV1ProjectCaller({ workspaceName: 'Other Co', identifier: 'OTHER' });
    await makeSprint(caller, 'Mine');
    await makeSprint(other, 'Theirs');

    const page = await fetchPage(caller);

    expect(page.items.map((s) => s.name)).toEqual(['Mine']);
  });
});

describe('GET /api/v1/sprints/{sprintId}', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the sprint in the schema shape', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await readOne(caller, sprint.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Sprint;
    expect(body.id).toBe(sprint.id);
    expect(body.name).toBe('Sprint 1');
    expect(() => sprintSchema.parse(body)).not.toThrow();
  });

  it('reports the REAL issueCount, not a hard-coded zero', async () => {
    // The regression this card exists for. `getActiveSprint` returns
    // `toSprintDto(row, 0)`; an endpoint built on it would answer 0 here and
    // nothing would fail — the field is present, well-typed and wrong.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    await seedIssueIn(caller, sprint.id, 'first');
    await seedIssueIn(caller, sprint.id, 'second');

    const res = await readOne(caller, sprint.id);

    expect(((await res.json()) as V1Sprint).issueCount).toBe(2);
  });

  it('reports the same issueCount whether read alone or in the list', async () => {
    // The single read and the list must not drift: they are two paths to one
    // sprint, and a client that used both would see a contradiction.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    await seedIssueIn(caller, sprint.id, 'only');

    const single = (await (await readOne(caller, sprint.id)).json()) as V1Sprint;
    const fromList = (await fetchPage(caller)).items[0];

    expect(single).toEqual(fromList);
  });

  it('reports a NEVER-STARTED sprint baseline as null, not 0', async () => {
    // Three distinct states, and `?? 0` would collapse the first into the
    // second: "there is no baseline" vs "the baseline was zero".
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const body = (await (await readOne(caller, sprint.id)).json()) as V1Sprint;

    expect(body.committedIssueCount).toBeNull();
    expect(body.committedPoints).toBeNull();
  });

  it('reports a STARTED but wholly UNESTIMATED sprint as points-null, count-numeric', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    await seedIssueIn(caller, sprint.id, 'unestimated');
    await sprintsService.startSprint(sprint.id, {}, caller.ctx);

    const body = (await (await readOne(caller, sprint.id)).json()) as V1Sprint;

    expect(body.state).toBe('active');
    // The sprint HAS a baseline now — one issue — but nothing was estimated, so
    // the points baseline is genuinely absent rather than zero.
    expect(body.committedIssueCount).toBe(1);
    expect(body.committedPoints).toBeNull();
  });

  it('reports a STARTED and ESTIMATED sprint with a numeric points baseline', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    const item = await seedIssueIn(caller, sprint.id, 'estimated');
    await workItemsService.updateWorkItem(item.id, { storyPoints: 5 }, caller.ctx);
    await sprintsService.startSprint(sprint.id, {}, caller.ctx);

    const body = (await (await readOne(caller, sprint.id)).json()) as V1Sprint;

    expect(body.committedIssueCount).toBe(1);
    expect(body.committedPoints).toBe(5);
  });

  it('answers an unknown sprint id with 404 and the error envelope, not a 500', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await readOne(caller, 'cmnotasprintid000000000000');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'SPRINT_NOT_FOUND', error: expect.any(String) });
  });

  it("answers ANOTHER tenant's sprint with 404, never 403", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const other = await createV1ProjectCaller({ workspaceName: 'Other Co', identifier: 'OTHER' });
    const theirs = await makeSprint(other, 'Theirs');

    const res = await readOne(caller, theirs.id);

    // 403 would confirm the sprint exists — the existence oracle ADR §4 forbids.
    expect(res.status).toBe(404);
  });

  it('refuses a token without the read scope', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['integration'] });
    const readCaller = await createV1ProjectCaller({ scopes: ['read'] });
    const sprint = await makeSprint(readCaller, 'Sprint 1');

    const res = await readOne(caller, sprint.id);

    expect(res.status).toBe(403);
  });
});
