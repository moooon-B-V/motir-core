import { beforeEach, describe, expect, it } from 'vitest';
import { GET as GET_BACKLOG } from '@/app/api/v1/projects/[projectKey]/backlog/route';
import { GET as GET_SPRINT_ITEMS } from '@/app/api/v1/sprints/[sprintId]/work-items/route';
import { encodeCollectionCursor } from '@/lib/api/v1/pagination';
import { workItemRefSchema, type WorkItemRef } from '@/lib/api/v1/workItems/schema';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/backlog + GET /api/v1/sprints/{id}/work-items
// (Story 11.3 · Subtask 11.3.8 — MOTIR-2065) against real Postgres.
//
// These are the only genuinely UNBOUNDED reads in the story, so the keyset
// property is tested the way 11.1's pagination suite tests it: with a real
// concurrent insert mid-scan, not against a static fixture.

const BASE = 'http://localhost:3000/api/v1';

function projectParams(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

interface RankedPage {
  items: WorkItemRef[];
  nextCursor: string | null;
  totalCount: number;
}

function backlogReq(caller: V1ProjectCaller, query = ''): Promise<Response> {
  return GET_BACKLOG(
    new Request(`${BASE}/projects/${caller.projectKey}/backlog${query}`, {
      headers: caller.headers,
    }),
    projectParams(caller.projectKey),
  );
}

function sprintItemsReq(caller: V1ProjectCaller, sprintId: string, query = ''): Promise<Response> {
  return GET_SPRINT_ITEMS(
    new Request(`${BASE}/sprints/${sprintId}/work-items${query}`, { headers: caller.headers }),
    sprintParams(sprintId),
  );
}

async function backlogPage(caller: V1ProjectCaller, query = ''): Promise<RankedPage> {
  const res = await backlogReq(caller, query);
  expect(res.status).toBe(200);
  return (await res.json()) as RankedPage;
}

async function sprintPage(
  caller: V1ProjectCaller,
  sprintId: string,
  query = '',
): Promise<RankedPage> {
  const res = await sprintItemsReq(caller, sprintId, query);
  expect(res.status).toBe(200);
  return (await res.json()) as RankedPage;
}

async function writer(opts: { workspaceName?: string; identifier?: string } = {}) {
  return createV1ProjectCaller({ scopes: ['read', 'sprints:write'], ...opts });
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
}

describe('GET /api/v1/projects/{projectKey}/backlog', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the RANKED envelope — items, nextCursor AND totalCount', async () => {
    const caller = await writer();
    const item = await makeItem(caller, 'queued');

    const page = await backlogPage(caller);

    expect(page.nextCursor).toBeNull();
    expect(page.totalCount).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.key).toBe(item.identifier);
    expect(() => workItemRefSchema.parse(page.items[0])).not.toThrow();
  });

  it('answers an EMPTY backlog with 200 and empty items, never a 404', async () => {
    const caller = await writer();

    expect(await backlogPage(caller)).toEqual({ items: [], nextCursor: null, totalCount: 0 });
  });

  it('preserves backlogRank order across page boundaries', async () => {
    const caller = await writer();
    for (const title of ['a', 'b', 'c', 'd', 'e']) await makeItem(caller, title);
    const expected = (
      await backlogService.getBacklog(caller.fixture.projectId, { limit: 100 }, caller.ctx)
    ).items.map((i) => i.identifier);

    const walked: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: RankedPage = await backlogPage(
        caller,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      walked.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(walked).toEqual(expected);
  });

  // The keyset property: a static fixture would not test pagination at all.
  it('never skips or duplicates a row when the collection is written MID-SCAN', async () => {
    const caller = await writer();
    for (const title of ['a', 'b', 'c', 'd']) await makeItem(caller, title);

    const first = await backlogPage(caller, '?limit=2');
    // A new item lands between the two fetches. Under an OFFSET pager this
    // shifts the window and a row is skipped or repeated.
    await makeItem(caller, 'inserted mid-scan');
    const second = await backlogPage(
      caller,
      `?limit=10&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );

    const seen = [...first.items, ...second.items].map((i) => i.key);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('clamps the limit to 100 and rejects a non-positive one', async () => {
    const caller = await writer();
    await makeItem(caller, 'one');

    expect((await backlogPage(caller, '?limit=500')).items).toHaveLength(1);
    const res = await backlogReq(caller, '?limit=0');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_LIMIT');
  });

  it('refuses a cursor issued by the SPRINT-members collection', async () => {
    const caller = await writer();
    const item = await makeItem(caller, 'one');
    // Structurally identical — both cursors wrap a bare row id — so only the
    // collection scope keeps them apart.
    const foreign = encodeCollectionCursor('sprintWorkItems', item.id);

    const res = await backlogReq(caller, `?cursor=${encodeURIComponent(foreign)}`);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
  });

  it('narrows by the versioned FilterAST, and 422s an invalid one', async () => {
    const caller = await writer();
    await makeItem(caller, 'keep me');
    const bug = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'bug', title: 'a bug' },
      caller.ctx,
    );

    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    const filtered = await backlogPage(
      caller,
      `?filter=${encodeURIComponent(encodeFilterParam(ast))}`,
    );

    expect(filtered.items.map((i) => i.key)).toEqual([bug.identifier]);
    expect(filtered.totalCount).toBe(1);

    const bad = await backlogReq(caller, '?filter=garbage');
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_FILTER');
  });

  it('answers an unknown projectKey with 404, and refuses a scopeless token', async () => {
    const caller = await writer();
    const noScope = await createV1ProjectCaller({ scopes: ['integration'] });

    expect(
      (
        await GET_BACKLOG(
          new Request(`${BASE}/projects/NOPE/backlog`, { headers: caller.headers }),
          projectParams('NOPE'),
        )
      ).status,
    ).toBe(404);
    expect((await backlogReq(noScope)).status).toBe(403);
  });
});

describe('GET /api/v1/sprints/{sprintId}/work-items', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  async function sprintWithItems(caller: V1ProjectCaller, titles: string[]) {
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Sprint 1' },
      caller.ctx,
    );
    const items = [];
    for (const title of titles) {
      const item = await makeItem(caller, title);
      await backlogService.assignToSprint(item.id, sprint.id, undefined, caller.ctx);
      items.push(item);
    }
    return { sprint, items };
  }

  it('returns the ranked envelope for a sprint, in rank order', async () => {
    const caller = await writer();
    const { sprint, items } = await sprintWithItems(caller, ['a', 'b']);

    const page = await sprintPage(caller, sprint.id);

    expect(page.totalCount).toBe(2);
    expect(page.items.map((i) => i.key)).toEqual(items.map((i) => i.identifier));
    expect(() => workItemRefSchema.parse(page.items[0])).not.toThrow();
  });

  it('answers an EMPTY sprint with 200 and empty items', async () => {
    const caller = await writer();
    const { sprint } = await sprintWithItems(caller, []);

    expect(await sprintPage(caller, sprint.id)).toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  // ⚠️ The asymmetry a later reader is most likely to "correct".
  it('KEEPS a done issue, while the backlog OMITS one — same item, both reads', async () => {
    const caller = await writer();
    const { sprint, items } = await sprintWithItems(caller, ['finished']);
    const item = items[0] as { id: string; identifier: string };
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', caller.ctx);
    await workItemsService.updateStatus(item.id, 'done', caller.ctx);

    // In the sprint: still there — a done issue stays part of the sprint's
    // scope, which is what makes a completed sprint a historical record.
    const inSprint = await sprintPage(caller, sprint.id);
    expect(inSprint.items.map((i) => i.key)).toEqual([item.identifier]);

    // Back in the backlog: gone — the backlog is the to-be-planned pile.
    await backlogService.moveToBacklog(item.id, caller.ctx);
    const inBacklog = await backlogPage(caller);
    expect(inBacklog.items.map((i) => i.key)).not.toContain(item.identifier);
    expect(inBacklog.totalCount).toBe(0);
  });

  it('pages a sprint by cursor and refuses a BACKLOG cursor', async () => {
    const caller = await writer();
    const { sprint, items } = await sprintWithItems(caller, ['a', 'b', 'c']);

    const first = await sprintPage(caller, sprint.id, '?limit=2');
    expect(first.items).toHaveLength(2);
    const second = await sprintPage(
      caller,
      sprint.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect([...first.items, ...second.items].map((i) => i.key)).toEqual(
      items.map((i) => i.identifier),
    );

    const foreign = encodeCollectionCursor('backlog', (items[0] as { id: string }).id);
    const res = await sprintItemsReq(caller, sprint.id, `?cursor=${encodeURIComponent(foreign)}`);
    expect(res.status).toBe(422);
  });

  it("answers ANOTHER tenant's sprint with 404, never 403", async () => {
    const caller = await writer();
    const other = await writer({ workspaceName: 'Other Co', identifier: 'OTHER' });
    const { sprint } = await sprintWithItems(other, ['theirs']);

    const res = await sprintItemsReq(caller, sprint.id);

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_NOT_FOUND');
  });
});
