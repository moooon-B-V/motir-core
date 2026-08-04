import { beforeEach, describe, expect, it } from 'vitest';
import { POST as START } from '@/app/api/v1/sprints/[sprintId]/start/route';
import { POST as COMPLETE } from '@/app/api/v1/sprints/[sprintId]/complete/route';
import { GET as GET_ONE } from '@/app/api/v1/sprints/[sprintId]/route';
import type { V1Sprint } from '@/lib/api/v1/sprints/schema';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { backlogService } from '@/lib/services/backlogService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../../fixtures/userFixtures';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1Caller,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/sprints/{sprintId}/start + /complete (Story 11.3 · Subtask
// 11.3.6 — MOTIR-2063) against real Postgres.
//
// These are the only READ-DERIVED WRITES in the story — both guard on the
// project's current active sprint before writing — so the concurrency test is
// the deliverable, not a nicety. A serial test would pass against a completely
// unguarded implementation.

const BASE = 'http://localhost:3000/api/v1';

function sprintParams(sprintId: string): { params: Promise<{ sprintId: string }> } {
  return { params: Promise.resolve({ sprintId }) };
}

function action(
  handler: (req: Request, args: { params: Promise<{ sprintId: string }> }) => Promise<Response>,
  caller: V1Caller,
  sprintId: string,
  body: unknown = {},
): Promise<Response> {
  return handler(
    new Request(`${BASE}/sprints/${sprintId}/action`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    sprintParams(sprintId),
  );
}

async function readBack(caller: V1Caller, sprintId: string): Promise<V1Sprint> {
  const res = await GET_ONE(
    new Request(`${BASE}/sprints/${sprintId}`, { headers: caller.headers }),
    sprintParams(sprintId),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as V1Sprint;
}

async function makeSprint(caller: V1ProjectCaller, name: string) {
  return sprintsService.createSprint(caller.fixture.projectId, { name }, caller.ctx);
}

async function seedIssueIn(caller: V1ProjectCaller, sprintId: string, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  await backlogService.assignToSprint(item.id, sprintId, undefined, caller.ctx);
  return item;
}

/** A `sprints:write` token whose OWNER is an ordinary member, not the owner. */
async function nonAdminWriter(caller: V1ProjectCaller): Promise<V1Caller> {
  const user = await createTestUser();
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: caller.workspace.id,
    role: 'member',
  });
  return withTokenFor(user, caller.workspace, { scopes: ['read', 'sprints:write'] });
}

describe('POST /api/v1/sprints/{sprintId}/start', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('activates a planned sprint and stamps the baseline so a read can SEE it', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    const item = await seedIssueIn(caller, sprint.id, 'work');
    await workItemsService.updateWorkItem(item.id, { storyPoints: 3 }, caller.ctx);

    const res = await action(START, caller, sprint.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Sprint;
    expect(body.state).toBe('active');
    expect(body.startDate).not.toBeNull();

    // The baseline is observable THROUGH THE API, not just in the database —
    // it is the difference a client can see between planned and started.
    const after = await readBack(caller, sprint.id);
    expect(after.committedIssueCount).toBe(1);
    expect(after.committedPoints).toBe(3);
  });

  it('accepts the inline name/goal edits the start dialog performs', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await action(START, caller, sprint.id, { name: 'Renamed', goal: 'ship it' });

    const body = (await res.json()) as V1Sprint;
    expect(body.name).toBe('Renamed');
    expect(body.goal).toBe('ship it');
  });

  // ⚠️ THE deliverable of this card.
  //
  // Driven REPEATEDLY, and that is not belt-and-braces — it is the difference
  // between this test working and not. The race has two losing paths and they do
  // NOT occur with equal probability:
  //
  //   • the in-transaction `FOR UPDATE` lock catches the loser (rare here), or
  //   • the `sprint_one_active_per_project` partial-unique index does (common).
  //
  // A single round hits the first path often enough to go green on a developer
  // machine while the second is broken — which is exactly what happened: this
  // test passed locally and failed in CI, where the untranslated unique
  // violation surfaced as a 500 (MOTIR-2071). Five rounds makes the common path
  // the one under test.
  it('lets exactly ONE of two SIMULTANEOUS starts win, and types the loser 409 — every time', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });

    for (let round = 0; round < 5; round += 1) {
      const first = await makeSprint(caller, `One-${round}`);
      const second = await makeSprint(caller, `Two-${round}`);

      // Genuine concurrency: both requests are in flight before either resolves.
      // A serial pair would pass against a completely unguarded implementation.
      const [a, b] = await Promise.all([
        action(START, caller, first.id),
        action(START, caller, second.id),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses, `round ${round}`).toEqual([200, 409]);

      // Either ordering is legitimate; what must NOT happen is two winners, or
      // the loser receiving a raw unique-violation 500 with a driver message.
      const loser = a.status === 409 ? a : b;
      expect(await loser.json(), `round ${round} loser body`).toEqual({
        code: 'SPRINT_ALREADY_ACTIVE',
        error: expect.any(String),
      });

      // And the database agrees: exactly one active sprint on the project.
      const sprints = await sprintsService.listByProject(caller.fixture.projectId, caller.ctx);
      const active = sprints.filter((s) => s.state === 'active');
      expect(active, `round ${round} active count`).toHaveLength(1);

      // Clear the slot so the next round races for a FIRST activation again —
      // the case the lock cannot guard, and therefore the case worth repeating.
      await action(COMPLETE, caller, active[0]?.id as string);
    }
  });

  it('refuses to start a sprint that is not planned — 422, typed', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    await action(START, caller, sprint.id);

    const res = await action(START, caller, sprint.id);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_NOT_STARTABLE');
  });

  it('refuses an invalid window with 422 from the service', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await action(START, caller, sprint.id, {
      startDate: '2026-08-10T00:00:00.000Z',
      endDate: '2026-08-01T00:00:00.000Z',
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_WINDOW_INVALID');
  });

  it('refuses a read-only token, and a scoped token whose owner is not a sprint admin', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const member = await nonAdminWriter(caller);

    const scopeRefusal = await action(START, readOnly, sprint.id);
    const roleRefusal = await action(START, member, sprint.id);

    expect(scopeRefusal.status).toBe(403);
    expect(((await scopeRefusal.json()) as { code: string }).code).toBe('INSUFFICIENT_SCOPE');
    expect(roleRefusal.status).toBe(403);
    expect(((await roleRefusal.json()) as { code: string }).code).toBe('NOT_SPRINT_ADMIN');
  });

  it("answers ANOTHER tenant's sprint with 404, never 403", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const other = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      identifier: 'OTHER',
      scopes: ['read', 'sprints:write'],
    });
    const theirs = await makeSprint(other, 'Theirs');

    const res = await action(START, caller, theirs.id);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/sprints/{sprintId}/complete', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  /** An ACTIVE sprint holding one done and one unfinished issue. */
  async function activeSprintWithMixedWork(caller: V1ProjectCaller) {
    const sprint = await makeSprint(caller, 'Sprint 1');
    const done = await seedIssueIn(caller, sprint.id, 'finished');
    const open = await seedIssueIn(caller, sprint.id, 'unfinished');
    await sprintsService.startSprint(sprint.id, {}, caller.ctx);
    await workItemsService.updateStatus(done.id, 'in_progress', caller.ctx);
    await workItemsService.updateStatus(done.id, 'in_review', caller.ctx);
    await workItemsService.updateStatus(done.id, 'done', caller.ctx);
    return { sprint, done, open };
  }

  it('closes the sprint, keeps DONE work on it, and returns the rest to the backlog', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint, done, open } = await activeSprintWithMixedWork(caller);

    const res = await action(COMPLETE, caller, sprint.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Sprint;
    expect(body.state).toBe('complete');
    expect(body.completedAt).not.toBeNull();

    // The done issue STAYS — that is the sprint's historical record.
    const stayed = await workItemsService.getWorkItem(done.id, caller.ctx);
    expect(stayed.sprintId).toBe(sprint.id);
    // The unfinished one is back in the backlog.
    const carried = await workItemsService.getWorkItem(open.id, caller.ctx);
    expect(carried.sprintId).toBeNull();
  });

  it('appends the unfinished work to a PLANNED target sprint when asked', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint, open } = await activeSprintWithMixedWork(caller);
    const next = await makeSprint(caller, 'Next');

    const res = await action(COMPLETE, caller, sprint.id, {
      carryOverTo: { sprintId: next.id },
    });

    expect(res.status).toBe(200);
    const carried = await workItemsService.getWorkItem(open.id, caller.ctx);
    expect(carried.sprintId).toBe(next.id);
  });

  it('refuses a NON-PLANNED carry-over target with a typed 422, not a 500', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint } = await activeSprintWithMixedWork(caller);

    // The sprint itself is `active`, so it is not a legal destination.
    const res = await action(COMPLETE, caller, sprint.id, {
      carryOverTo: { sprintId: sprint.id },
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CARRY_OVER_TARGET');
  });

  it('refuses a CROSS-PROJECT carry-over target with a typed 422', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint } = await activeSprintWithMixedWork(caller);
    const other = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      identifier: 'OTHER',
      scopes: ['read', 'sprints:write'],
    });
    const theirs = await makeSprint(other, 'Theirs');

    const res = await action(COMPLETE, caller, sprint.id, {
      carryOverTo: { sprintId: theirs.id },
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CARRY_OVER_TARGET');
  });

  it('refuses to complete a sprint that is not active — 422, typed', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const sprint = await makeSprint(caller, 'Sprint 1');

    const res = await action(COMPLETE, caller, sprint.id);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SPRINT_NOT_COMPLETABLE');
  });

  it('lets exactly ONE of two SIMULTANEOUS completes win', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint } = await activeSprintWithMixedWork(caller);

    const [a, b] = await Promise.all([
      action(COMPLETE, caller, sprint.id),
      action(COMPLETE, caller, sprint.id),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 422]);
    const loser = a.status === 422 ? a : b;
    // A typed domain error, never a raw driver message.
    expect(((await loser.json()) as { code: string }).code).toBe('SPRINT_NOT_COMPLETABLE');
  });

  it('refuses a read-only token, and a scoped token whose owner is not a sprint admin', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
    const { sprint } = await activeSprintWithMixedWork(caller);
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });
    const member = await nonAdminWriter(caller);

    expect((await action(COMPLETE, readOnly, sprint.id)).status).toBe(403);
    const roleRefusal = await action(COMPLETE, member, sprint.id);
    expect(roleRefusal.status).toBe(403);
    expect(((await roleRefusal.json()) as { code: string }).code).toBe('NOT_SPRINT_ADMIN');
  });
});
