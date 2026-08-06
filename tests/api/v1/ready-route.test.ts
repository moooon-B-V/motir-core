import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/v1/projects/[projectKey]/ready/route';
import { readyItemSchema, type V1ReadyItem } from '@/lib/api/v1/ready/schema';
import { encodeCollectionCursor } from '@/lib/api/v1/pagination';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/ready (Story 11.3 · Subtask 11.3.9 —
// MOTIR-2066) against real Postgres.
//
// Two assertions here are the REASON this endpoint may not be re-derived:
//
//   • the PARENT-READY CASCADE case — an item whose own sibling blockers are all
//     done but whose ancestor is not ready must be ABSENT. A flat "all its own
//     blockers are done" check returns it, and that is a different, wrong answer.
//   • the edge projection is TWO queries for the whole page, not one per row —
//     an N+1 here is invisible until a 100-row page.

const BASE = 'http://localhost:3000/api/v1';

function params(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function req(caller: V1ProjectCaller, query = '', projectKey?: string): Promise<Response> {
  const key = projectKey ?? caller.projectKey;
  return GET(
    new Request(`${BASE}/projects/${key}/ready${query}`, { headers: caller.headers }),
    params(key),
  );
}

interface ReadyPage {
  items: V1ReadyItem[];
  nextCursor: string | null;
}

async function page(caller: V1ProjectCaller, query = ''): Promise<ReadyPage> {
  const res = await req(caller, query);
  expect(res.status).toBe(200);
  return (await res.json()) as ReadyPage;
}

async function makeItem(
  caller: V1ProjectCaller,
  title: string,
  extra: { parentId?: string; kind?: 'task' | 'subtask' | 'story' } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: extra.kind ?? 'task',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
    },
    caller.ctx,
  );
}

async function blockedBy(caller: V1ProjectCaller, fromId: string, toId: string) {
  return workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, caller.ctx);
}

async function markDone(caller: V1ProjectCaller, id: string) {
  await workItemsService.updateStatus(id, 'in_progress', caller.ctx);
  await workItemsService.updateStatus(id, 'in_review', caller.ctx);
  await workItemsService.updateStatus(id, 'done', caller.ctx);
}

describe('GET /api/v1/projects/{projectKey}/ready', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('returns the schema shape with the edge block on every row', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await makeItem(caller, 'pick me');

    const result = await page(caller);

    expect(result.items).toHaveLength(1);
    const row = result.items[0] as V1ReadyItem;
    expect(() => readyItemSchema.parse(row)).not.toThrow();
    // TOTAL: a row with no edges gets two EMPTY arrays, never a missing key.
    expect(row.dependencies).toEqual({ blockedBy: [], blocks: [] });
  });

  it('carries `blocks` edges keyed by MOTIR-<n>, so a client sees downstream impact', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const first = await makeItem(caller, 'do me first');
    const second = await makeItem(caller, 'waits on the first');
    await blockedBy(caller, second.id, first.id);

    const result = await page(caller);

    const ready = result.items.find((i) => i.key === first.identifier) as V1ReadyItem;
    expect(ready.dependencies.blocks).toEqual([
      { key: second.identifier, title: 'waits on the first', status: 'todo' },
    ]);
    // The blocked item is not ready, so it is absent entirely.
    expect(result.items.map((i) => i.key)).not.toContain(second.identifier);
  });

  it('returns the SAME set and ORDER as workItemsService.listReady', async () => {
    // Compared against the service rather than against a re-implemented
    // expectation: if the two ever disagree, an agent loop and the board
    // disagree, which is the failure this endpoint exists to prevent.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (const title of ['a', 'b', 'c']) await makeItem(caller, title);
    // A subtask needs a parent, and the parent then stops being a leaf — which
    // is exactly the mix that makes the dispatch rank observable (subtask before
    // task).
    const story = await makeItem(caller, 'a story', { kind: 'story' });
    await makeItem(caller, 'a subtask', { kind: 'subtask', parentId: story.id });

    const fromApi = (await page(caller)).items.map((i) => i.key);
    const fromService = (
      await workItemsService.listReady(caller.fixture.projectId, {}, caller.ctx)
    ).items.map((i) => i.key);

    expect(fromApi).toEqual(fromService);
  });

  // ⚠️ THE case a flat blocker check gets wrong.
  it('EXCLUDES an item whose own blockers are done but whose ANCESTOR is not ready', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    // A story that is itself blocked by unfinished work…
    const blockerStory = await makeItem(caller, 'must ship first', { kind: 'story' });
    await makeItem(caller, 'unfinished child of the blocker', { parentId: blockerStory.id });
    const gatedStory = await makeItem(caller, 'gated story', { kind: 'story' });
    await blockedBy(caller, gatedStory.id, blockerStory.id);

    // …with a child whose OWN sibling blocker IS done.
    const doneSibling = await makeItem(caller, 'done sibling', { parentId: gatedStory.id });
    const child = await makeItem(caller, 'child with satisfied blockers', {
      parentId: gatedStory.id,
    });
    await blockedBy(caller, child.id, doneSibling.id);
    await markDone(caller, doneSibling.id);

    const result = await page(caller);

    // A flat "all its own blockers are done" check would return `child` — every
    // blocker it names IS terminal. The parent-ready cascade excludes it,
    // because its ancestor story is still gated.
    expect(result.items.map((i) => i.key)).not.toContain(child.identifier);
    // And the endpoint agrees with the service exactly.
    const fromService = (
      await workItemsService.listReady(caller.fixture.projectId, {}, caller.ctx)
    ).items.map((i) => i.key);
    expect(result.items.map((i) => i.key)).toEqual(fromService);
  });

  // ⚠️ An N+1 here is invisible until a 100-row page.
  it("projects the whole page's edges in ONE batched call, not one per row", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (const title of ['a', 'b', 'c', 'd', 'e']) await makeItem(caller, title);
    const spy = vi.spyOn(workItemsService, 'getDependencyEdgesForItems');

    const result = await page(caller);

    expect(result.items.length).toBeGreaterThan(1);
    // ONE call, carrying EVERY id — not one call per row.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(result.items.length);
  });

  it('pages in dispatch rank across boundaries and clamps the limit to 100', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (const title of ['a', 'b', 'c', 'd']) await makeItem(caller, title);
    const expected = (
      await workItemsService.listReady(caller.fixture.projectId, {}, caller.ctx)
    ).items.map((i) => i.key);

    const first = await page(caller, '?limit=2');
    expect(first.nextCursor).not.toBeNull();
    const second = await page(
      caller,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect([...first.items, ...second.items].map((i) => i.key)).toEqual(expected);

    // The service permits 200; v1 documents 100 and clamps before the service
    // sees the number.
    expect((await page(caller, '?limit=200')).items).toHaveLength(expected.length);
  });

  it('narrows by kind and priority, and 422s an unknown value', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    await makeItem(caller, 'a task');
    const bug = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'bug', title: 'a bug' },
      caller.ctx,
    );

    expect((await page(caller, '?kind=bug')).items.map((i) => i.key)).toEqual([bug.identifier]);

    const res = await req(caller, '?kind=nonsense');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_READY_FILTER');
  });

  // MOTIR-2317. The document declared `kind` as a scalar until this card, so
  // the route's REPEATED form had no test of its own — it was described in
  // prose and read by `getAll`, and nothing held the two together. A generated
  // client now depends on this exact wire form.
  it('narrows to the UNION of a repeated kind, not to the last one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const task = await makeItem(caller, 'a task');
    const bug = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'bug', title: 'a bug' },
      caller.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'a story' },
      caller.ctx,
    );

    const keys = (await page(caller, '?kind=task&kind=bug')).items.map((i) => i.key);

    // Both, and only both — a last-value-wins read would return the bug alone,
    // and an ignored filter would drag the story in.
    expect(new Set(keys)).toEqual(new Set([task.identifier, bug.identifier]));
  });

  it('supports the UNASSIGNED bucket as an explicit literal', async () => {
    // Absent means "any assignee"; an empty `?assigneeId=` cannot mean
    // "unassigned" because it is indistinguishable from omitting it — so the
    // bucket needs a name of its own.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const unassigned = await makeItem(caller, 'nobody has this');

    const result = await page(caller, '?assigneeId=none');

    expect(result.items.map((i) => i.key)).toContain(unassigned.identifier);
  });

  it('answers an EMPTY ready set with 200 and empty items, never a 404', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    expect(await page(caller)).toEqual({ items: [], nextCursor: null });
  });

  it('refuses a malformed cursor with 422 rather than restarting at page one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await req(caller, '?cursor=garbage');

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
  });

  it('refuses a cursor issued by a DIFFERENT collection', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const foreign = encodeCollectionCursor('backlog', 'some-row-id');

    const res = await req(caller, `?cursor=${encodeURIComponent(foreign)}`);

    expect(res.status).toBe(422);
  });

  it('answers an unknown projectKey with 404 and refuses a scopeless token', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const noScope = await createV1ProjectCaller({ scopes: ['integration'] });

    expect((await req(caller, '', 'NOPE')).status).toBe(404);
    expect((await req(noScope)).status).toBe(403);
  });

  it("never returns ANOTHER tenant's ready items", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const other = await createV1ProjectCaller({ workspaceName: 'Other Co', identifier: 'OTHER' });
    const mine = await makeItem(caller, 'mine');
    await makeItem(other, 'theirs');

    expect((await page(caller)).items.map((i) => i.key)).toEqual([mine.identifier]);
  });
});
