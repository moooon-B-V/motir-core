import { beforeEach, describe, expect, it } from 'vitest';
import { POST as INTO_SPRINT } from '@/app/api/v1/sprints/[sprintId]/work-items/route';
import { POST as INTO_BACKLOG } from '@/app/api/v1/projects/[projectKey]/backlog/work-items/route';
import type { MembershipMoveResult } from '@/lib/api/v1/sprints/membership';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { db } from '@/lib/db';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/sprints/{sprintId}/work-items and
// POST /api/v1/projects/{projectKey}/backlog/work-items (Story 11.3 · Subtask
// 11.3.7 — MOTIR-2064) against real Postgres.
//
// ⚠️ The ATOMICITY assertions read every OTHER member back afterwards and find
// it unmoved. A status-code check alone would pass against an implementation
// that moved four items and then failed on the fifth — which is precisely the
// failure these endpoints exist to make impossible.
//
// Read-backs go through the SHIPPED `backlogService` reads, not through the v1
// collection endpoints: those are a sibling card's deliverable, and the
// move-over-HTTP-then-read-over-HTTP journey belongs to the story's conformance
// suite, which is blocked_by both cards.

const BASE = 'http://localhost:3000/api/v1';

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

function projectParams(projectKey: string): { params: Promise<{ projectKey: string }> } {
  return { params: Promise.resolve({ projectKey }) };
}

function intoSprint(
  caller: V1ProjectCaller,
  sprintId: string,
  workItemKeys: unknown,
): Promise<Response> {
  return INTO_SPRINT(
    new Request(`${BASE}/sprints/${sprintId}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workItemKeys }),
    }),
    sprintParams(sprintId),
  );
}

function intoBacklog(
  caller: V1ProjectCaller,
  projectKey: string,
  workItemKeys: unknown,
): Promise<Response> {
  return INTO_BACKLOG(
    new Request(`${BASE}/projects/${projectKey}/backlog/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ workItemKeys }),
    }),
    projectParams(projectKey),
  );
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

async function makeSprint(caller: V1ProjectCaller, name: string) {
  return sprintsService.createSprint(caller.fixture.projectId, { name }, caller.ctx);
}

/** The sprint's members, in rank order, as keys. */
async function sprintMemberKeys(caller: V1ProjectCaller, sprintId: string): Promise<string[]> {
  const page = await backlogService.getSprintIssues(sprintId, { limit: 100 }, caller.ctx);
  return page.items.map((item) => item.identifier);
}

/** The project's backlog, in rank order, as keys. */
async function backlogKeys(caller: V1ProjectCaller): Promise<string[]> {
  const page = await backlogService.getBacklog(
    caller.fixture.projectId,
    { limit: 100 },
    caller.ctx,
  );
  return page.items.map((item) => item.identifier);
}

describe('POST /api/v1/sprints/{sprintId}/work-items', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('moves a batch into the sprint at the rank TAIL, in request order', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const first = await makeItem(caller, 'one');
    const second = await makeItem(caller, 'two');
    const third = await makeItem(caller, 'three');

    const res = await intoSprint(caller, sprint.id, [
      third.identifier,
      first.identifier,
      second.identifier,
    ]);

    expect(res.status).toBe(200);
    expect((await res.json()) as MembershipMoveResult).toEqual({
      movedKeys: [third.identifier, first.identifier, second.identifier],
    });
    // Request order IS rank order: each is appended strictly after the previous.
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([
      third.identifier,
      first.identifier,
      second.identifier,
    ]);
  });

  // ⚠️ The atomicity claim, and only a read-back proves it.
  it('lands NOTHING when one member of the batch is unknown', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const good = await makeItem(caller, 'good');

    const res = await intoSprint(caller, sprint.id, [good.identifier, 'PROD-99999']);

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('WORK_ITEM_NOT_FOUND');
    // The good member did NOT move — the whole batch was refused before any write.
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([]);
    expect(await backlogKeys(caller)).toContain(good.identifier);
  });

  it('lands NOTHING when one member belongs to another PROJECT', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const mine = await makeItem(caller, 'mine');
    const other = await writer({ workspaceName: 'Other Co', identifier: 'OTHER' });
    const theirs = await makeItem(other, 'theirs');

    const res = await intoSprint(caller, sprint.id, [mine.identifier, theirs.identifier]);

    // A key from another project does not resolve within THIS project, so it is
    // refused before the service's own cross-project check even runs — and the
    // refusal is the same 404 a key that never existed gets, which is what keeps
    // the endpoint from confirming another tenant's keys.
    expect(res.status).toBe(404);
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([]);
  });

  it('collapses DUPLICATE keys to one move each', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const item = await makeItem(caller, 'one');

    const res = await intoSprint(caller, sprint.id, [item.identifier, item.identifier]);

    expect(res.status).toBe(200);
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([item.identifier]);
  });

  it('treats an EMPTY batch as a 200 no-op, not a 422', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await intoSprint(caller, sprint.id, []);

    expect(res.status).toBe(200);
    expect((await res.json()) as MembershipMoveResult).toEqual({ movedKeys: [] });
  });

  it('refuses a batch OVER the cap with a typed error rather than truncating it', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    // 101 well-formed keys. They need not exist: the cap is checked before the
    // batch is loaded, which is the point — an over-cap request costs nothing.
    const keys = Array.from({ length: 101 }, (_, i) => `PROD-${i + 1000}`);

    const res = await intoSprint(caller, sprint.id, keys);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('BULK_BATCH_TOO_LARGE');
  });

  it('refuses a read-only token with 403', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await intoSprint(readOnly, sprint.id, []);

    expect(res.status).toBe(403);
  });

  it("answers ANOTHER tenant's sprint with 404, never 403", async () => {
    const caller = await writer();
    const other = await writer({ workspaceName: 'Other Co', identifier: 'OTHER' });
    const theirs = await makeSprint(other, 'Theirs');

    const res = await intoSprint(caller, theirs.id, []);

    expect(res.status).toBe(404);
  });

  it('rejects a malformed key with 422 before any read', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await intoSprint(caller, sprint.id, ['not-a-key']);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_BODY');
  });
});

describe('POST /api/v1/projects/{projectKey}/backlog/work-items', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('moves items back to the backlog, KEEPING their rank position', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const first = await makeItem(caller, 'one');
    const second = await makeItem(caller, 'two');
    const third = await makeItem(caller, 'three');
    const backlogBefore = await backlogKeys(caller);

    await intoSprint(caller, sprint.id, [first.identifier, third.identifier]);
    const res = await intoBacklog(caller, caller.projectKey, [first.identifier, third.identifier]);

    expect(res.status).toBe(200);
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([]);
    // Back where they were — the rank was never touched, so the backlog reads
    // identically to before the round trip.
    expect(await backlogKeys(caller)).toEqual(backlogBefore);
    expect(backlogBefore).toContain(second.identifier);
  });

  it('is a NO-OP with no revision for an item already in the backlog', async () => {
    const caller = await writer();
    const item = await makeItem(caller, 'already here');
    const before = await db.workItemRevision.count({ where: { workItemId: item.id } });

    const res = await intoBacklog(caller, caller.projectKey, [item.identifier]);

    expect(res.status).toBe(200);
    // No write means no history entry: a client that re-sends a batch must not
    // pollute the item's revision trail.
    const after = await db.workItemRevision.count({ where: { workItemId: item.id } });
    expect(after).toBe(before);
  });

  it('lands NOTHING when one member of the batch is unknown', async () => {
    const caller = await writer();
    const sprint = await makeSprint(caller, 'Sprint 1');
    const good = await makeItem(caller, 'good');
    await intoSprint(caller, sprint.id, [good.identifier]);

    const res = await intoBacklog(caller, caller.projectKey, [good.identifier, 'PROD-99999']);

    expect(res.status).toBe(404);
    // Still in the sprint: the whole batch was refused before any write.
    expect(await sprintMemberKeys(caller, sprint.id)).toEqual([good.identifier]);
  });

  it('treats an EMPTY batch as a 200 no-op', async () => {
    const caller = await writer();

    const res = await intoBacklog(caller, caller.projectKey, []);

    expect(res.status).toBe(200);
    expect((await res.json()) as MembershipMoveResult).toEqual({ movedKeys: [] });
  });

  it('refuses a read-only token with 403, and an unknown project with 404', async () => {
    const caller = await writer();
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    expect((await intoBacklog(readOnly, caller.projectKey, [])).status).toBe(403);
    expect((await intoBacklog(caller, 'NOPE', [])).status).toBe(404);
  });
});
