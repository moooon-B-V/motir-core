import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_BACKLOG } from '@/app/api/v1/projects/[projectKey]/backlog/route';
import { GET as GET_SPRINT_ITEMS } from '@/app/api/v1/sprints/[sprintId]/work-items/route';
import { POST as INTO_BACKLOG } from '@/app/api/v1/projects/[projectKey]/backlog/work-items/route';
import { GET as GET_READY } from '@/app/api/v1/projects/[projectKey]/ready/route';
import { encodeCollectionCursor } from '@/lib/api/v1/pagination';
import { parseReadyFilters, presentReadyItem, UNASSIGNED } from '@/lib/api/v1/ready/schema';
import { FILTER_ROW_CAP, FILTER_PARAM_VERSION } from '@/lib/filters/ast';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story 11.3 coverage TOP-UP (Subtask 11.3.10 — MOTIR-2067).
//
// The branches the per-subtask suites left uncovered, measured rather than
// guessed: each `it` below names the branch it exists for. This is the gate
// card's first job — the per-subtask floor covers each card's own happy and
// error paths, and this reaches the seams and the rarely-taken arms between
// them.

const BASE = 'http://localhost:3000/api/v1';

function projectParams(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

async function writer() {
  return createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
}

/** A `?filter=` value that is well-formed base64 but the WRONG version. */
function foreignVersionFilter(): string {
  const compact = { c: 'and', f: [] };
  const payload = Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
  return `v99:${payload}`;
}

/** A `?filter=` value carrying more rows than the codec's cap. */
function overCapFilter(): string {
  const compact = {
    c: 'and',
    f: Array.from({ length: FILTER_ROW_CAP + 1 }, () => ['kind', 'is_any_of', ['task']]),
  };
  const payload = Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
  return `${FILTER_PARAM_VERSION}:${payload}`;
}

describe('top-up — the ranked collections’ filter failure arms', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  // `parseRankedFilterParam`'s `unsupported-version` branch. A DISTINCT code
  // from a malformed filter, because the two need different fixes: upgrade the
  // client, versus correct the encoding.
  it('answers a filter written against another VERSION with UNSUPPORTED_FILTER_VERSION', async () => {
    const caller = await writer();

    const res = await GET_BACKLOG(
      new Request(
        `${BASE}/projects/${caller.projectKey}/backlog?filter=${encodeURIComponent(foreignVersionFilter())}`,
        { headers: caller.headers },
      ),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('UNSUPPORTED_FILTER_VERSION');
  });

  // The `too-large` branch — refused by the CODEC before the registry sees it.
  it('answers an over-cap filter with FILTER_TOO_LARGE', async () => {
    const caller = await writer();

    const res = await GET_BACKLOG(
      new Request(
        `${BASE}/projects/${caller.projectKey}/backlog?filter=${encodeURIComponent(overCapFilter())}`,
        { headers: caller.headers },
      ),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('FILTER_TOO_LARGE');
  });

  // The sprint-members side of the SAME parser — the two routes share it, and a
  // shared parser exercised through only one caller is half-tested.
  it('applies the same filter parser on the SPRINT-members collection', async () => {
    const caller = await writer();
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Sprint 1' },
      caller.ctx,
    );

    const res = await GET_SPRINT_ITEMS(
      new Request(`${BASE}/sprints/${sprint.id}/work-items?filter=garbage`, {
        headers: caller.headers,
      }),
      sprintParams(sprint.id),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_FILTER');
  });

  // `presentRankedPage`'s parent-key RESOLVER — only invoked for a row whose
  // parent is in the same page. An unresolvable parent comes back null rather
  // than leaking a cuid, and neither arm runs without a parented row.
  it('resolves a parentKey when the parent is in the SAME page, and nulls it otherwise', async () => {
    const caller = await writer();
    const parent = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'the parent' },
      caller.ctx,
    );
    const child = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'the child',
        parentId: parent.id,
      },
      caller.ctx,
    );

    const res = await GET_BACKLOG(
      new Request(`${BASE}/projects/${caller.projectKey}/backlog`, { headers: caller.headers }),
      projectParams(caller.projectKey),
    );

    const body = (await res.json()) as { items: Array<{ key: string; parentKey: string | null }> };
    const childRow = body.items.find((i) => i.key === child.identifier);
    expect(childRow?.parentKey).toBe(parent.identifier);
    // The parent itself is top-level, so its own parentKey is null.
    expect(body.items.find((i) => i.key === parent.identifier)?.parentKey).toBeNull();
    // …and no cuid crossed the wire either way.
    expect(JSON.stringify(body)).not.toContain(parent.id);
  });

  // The `nextCursor !== null` arm of `presentRankedPage` on the SPRINT side.
  it('issues a next cursor on a sprint page that has more rows', async () => {
    const caller = await writer();
    const sprint = await sprintsService.createSprint(
      caller.fixture.projectId,
      { name: 'Sprint 1' },
      caller.ctx,
    );
    for (const title of ['a', 'b']) {
      const item = await workItemsService.createWorkItem(
        { projectId: caller.fixture.projectId, kind: 'task', title },
        caller.ctx,
      );
      const { backlogService } = await import('@/lib/services/backlogService');
      await backlogService.assignToSprint(item.id, sprint.id, undefined, caller.ctx);
    }

    const res = await GET_SPRINT_ITEMS(
      new Request(`${BASE}/sprints/${sprint.id}/work-items?limit=1`, { headers: caller.headers }),
      sprintParams(sprint.id),
    );

    expect(((await res.json()) as { nextCursor: string | null }).nextCursor).not.toBeNull();
  });
});

describe('top-up — the backlog membership move’s cap guard', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  // The over-cap arm on the BACKLOG direction. Its sibling (into a sprint) is
  // covered by the membership suite; this one shares the guard and was not.
  it('refuses an over-cap batch on the move-to-backlog direction too', async () => {
    const caller = await writer();
    const keys = Array.from({ length: 101 }, (_, i) => `PROD-${i + 1000}`);

    const res = await INTO_BACKLOG(
      new Request(`${BASE}/projects/${caller.projectKey}/backlog/work-items`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ workItemKeys: keys }),
      }),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('BULK_BATCH_TOO_LARGE');
  });
});

describe('top-up — the ready endpoint’s rare arms', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  // ⚠️ The `InvalidReadyCursorError` catch. Reachable only by a cursor v1 SIGNED
  // (so it passes the collection scope) whose inner payload the shipped ready
  // codec rejects — a version skew rather than a client mistake. Without the
  // catch it would escape as a bare 500.
  it('maps a v1-signed cursor the READY codec rejects to 422, not a 500', async () => {
    const caller = await writer();
    const signedButNotAReadyPosition = encodeCollectionCursor('ready', 'not-a-ready-token');

    const res = await GET_READY(
      new Request(
        `${BASE}/projects/${caller.projectKey}/ready?cursor=${encodeURIComponent(signedButNotAReadyPosition)}`,
        { headers: caller.headers },
      ),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
  });

  // A real error must still ESCAPE that catch rather than being relabelled as a
  // cursor problem. The catch wraps the service call, so this has to fail INSIDE
  // it — a bad project key throws before the try and would prove nothing.
  it('re-throws a NON-cursor failure from the service instead of calling it a bad cursor', async () => {
    const caller = await writer();
    const boom = new Error('the database fell over');
    const spy = vi.spyOn(workItemsService, 'listReady').mockRejectedValueOnce(boom);

    const res = await GET_READY(
      new Request(`${BASE}/projects/${caller.projectKey}/ready`, { headers: caller.headers }),
      projectParams(caller.projectKey),
    );

    expect(spy).toHaveBeenCalled();
    // An unrecognised fault is a bare 500 that leaks nothing — NOT a 422 telling
    // the caller to fix a cursor that was perfectly valid.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error.' });
    spy.mockRestore();
  });

  it('answers an unknown project with 404 before the read is even attempted', async () => {
    const caller = await writer();

    const res = await GET_READY(
      new Request(`${BASE}/projects/NOPE/ready`, { headers: caller.headers }),
      projectParams('NOPE'),
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_NOT_FOUND');
  });

  // The `blockedBy` mapper arm. A ready row's blockers are all TERMINAL — that
  // is what makes it ready — but the edges still EXIST and still ship, and the
  // arm that maps them is only reached by a row that actually has one.
  it('maps a ready row’s DONE blockers into the blockedBy array', async () => {
    const caller = await writer();
    const blocker = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'shipped already' },
      caller.ctx,
    );
    const gated = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'now unblocked' },
      caller.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: gated.id, toId: blocker.id, kind: 'is_blocked_by' },
      caller.ctx,
    );
    for (const status of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(blocker.id, status, caller.ctx);
    }

    const res = await GET_READY(
      new Request(`${BASE}/projects/${caller.projectKey}/ready`, { headers: caller.headers }),
      projectParams(caller.projectKey),
    );

    const body = (await res.json()) as {
      items: Array<{
        key: string;
        dependencies: { blockedBy: Array<{ key: string; status: string }> };
      }>;
    };
    const row = body.items.find((i) => i.key === gated.identifier);
    expect(row?.dependencies.blockedBy).toEqual([
      { key: blocker.identifier, title: 'shipped already', status: 'done' },
    ]);
  });

  // The cursor-supplied arm of the read, on the SUCCESS path — the failure arm
  // above exercises the catch, not the spread.
  it('passes a valid cursor through to the service', async () => {
    const caller = await writer();
    for (const title of ['a', 'b', 'c']) {
      await workItemsService.createWorkItem(
        { projectId: caller.fixture.projectId, kind: 'task', title },
        caller.ctx,
      );
    }

    const first = (await (
      await GET_READY(
        new Request(`${BASE}/projects/${caller.projectKey}/ready?limit=1`, {
          headers: caller.headers,
        }),
        projectParams(caller.projectKey),
      )
    ).json()) as { nextCursor: string | null };

    const res = await GET_READY(
      new Request(
        `${BASE}/projects/${caller.projectKey}/ready?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
        { headers: caller.headers },
      ),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('narrows by PRIORITY, the third filter axis', async () => {
    const caller = await writer();
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'low', priority: 'low' },
      caller.ctx,
    );
    const urgent = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'urgent', priority: 'highest' },
      caller.ctx,
    );

    const res = await GET_READY(
      new Request(`${BASE}/projects/${caller.projectKey}/ready?priority=highest`, {
        headers: caller.headers,
      }),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { items: Array<{ key: string }> }).items.map((i) => i.key),
    ).toEqual([urgent.identifier]);
  });

  it('422s an unknown PRIORITY rather than silently matching everything', async () => {
    const caller = await writer();

    const res = await GET_READY(
      new Request(`${BASE}/projects/${caller.projectKey}/ready?priority=nonsense`, {
        headers: caller.headers,
      }),
      projectParams(caller.projectKey),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_READY_FILTER');
  });

  it('carries an ASSIGNED row’s assigneeId through the mapper', async () => {
    const caller = await writer();
    const item = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'assigned' },
      caller.ctx,
    );
    await workItemsService.updateWorkItem(item.id, { assigneeId: caller.user.id }, caller.ctx);

    const res = await GET_READY(
      new Request(`${BASE}/projects/${caller.projectKey}/ready?assigneeId=${caller.user.id}`, {
        headers: caller.headers,
      }),
      projectParams(caller.projectKey),
    );

    const body = (await res.json()) as { items: Array<{ key: string; assigneeId: string | null }> };
    expect(body.items[0]?.assigneeId).toBe(caller.user.id);
  });
});

describe('top-up — the ready filter parser and mapper, as units', () => {
  const req = (query: string) => new Request(`${BASE}/projects/PROD/ready${query}`);

  it('reads ABSENT / none / an id as the three assignee states', () => {
    // The tri-state the wire form exists to preserve. An empty `?assigneeId=` is
    // indistinguishable from omitting it, so it means "any" — which is why the
    // unassigned bucket needs an explicit literal.
    expect(parseReadyFilters(req('')).assigneeId).toBeUndefined();
    expect(parseReadyFilters(req('?assigneeId=')).assigneeId).toBeUndefined();
    expect(parseReadyFilters(req(`?assigneeId=${UNASSIGNED}`)).assigneeId).toBeNull();
    expect(parseReadyFilters(req('?assigneeId=user-1')).assigneeId).toBe('user-1');
  });

  it('accepts repeated kind and priority params as "any of" sets', () => {
    const filter = parseReadyFilters(req('?kind=task&kind=bug&priority=high&priority=highest'));

    expect(filter.kinds).toEqual(['task', 'bug']);
    expect(filter.priority).toEqual(['high', 'highest']);
  });

  it('defaults a row with NO edge entry to two empty arrays', () => {
    // `getDependencyEdgesForItems` pre-seeds every requested id, so the fallback
    // is unreachable in production — but `noUncheckedIndexedAccess` demands it
    // and an untested fallback is where a `undefined.map` waits.
    const row = presentReadyItem(
      {
        id: 'x',
        key: 'PROD-1',
        kind: 'task',
        title: 'orphan',
        priority: 'medium',
        status: { key: 'todo', category: 'todo' },
        assignee: null,
        descriptionExcerpt: null,
        type: null,
        executor: null,
        descriptionMd: null,
      },
      undefined,
    );

    expect(row.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(row.assigneeId).toBeNull();
  });
});
