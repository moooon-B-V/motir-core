import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  IllegalTransitionError,
  NoInitialStatusError,
  UnknownStatusError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Transition validation + the gated work_item.status write (Story 2.2 ·
// Subtask 2.2.4). Real Postgres — runs in CI. Projects come from
// createTestProject (→ createProject, which auto-seeds the default workflow:
// initial `todo`, transitions todo→in_progress→in_review→done, etc.), so the
// initial status + the legal/illegal transitions are the default seed's.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  itemId: string;
}

async function makeFixture(email = 'tv-a@example.com'): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'TV User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'TV WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Task' },
    ctx,
  );
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id, itemId: item.id };
}

async function revisionCount(itemId: string): Promise<number> {
  return (await workItemRevisionRepository.listByWorkItem(itemId)).length;
}

describe('createWorkItem seeds the workflow initial status', () => {
  it('a fresh item lands in the project initial status (todo), not the old `open` default', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.getWorkItem(fx.itemId, fx.ctx);
    expect(item.status).toBe('todo');
  });

  it('throws NoInitialStatusError when the project has no workflow (corrupt/absent seed)', async () => {
    const user = await usersService.createUser({
      email: 'tv-bare@example.com',
      password: 'hunter2hunter2',
      name: 'TV Bare',
    });
    const ws = await workspacesService.createWorkspace({
      name: 'TV Bare WS',
      ownerUserId: user.id,
    });
    const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
    // A BARE project (no auto-seed) — bypasses createProject's seed.
    const bare = await db.project.create({
      data: { workspaceId: ws.workspace.id, name: 'Bare', slug: 'tv-bare', identifier: 'TVB' },
    });
    await expect(
      workItemsService.createWorkItem({ projectId: bare.id, kind: 'task', title: 'X' }, ctx),
    ).rejects.toThrow(NoInitialStatusError);
  });
});

describe('updateStatus — restricted mode (the default seed)', () => {
  it('a legal transition (todo→in_progress) succeeds and writes ONE updated revision', async () => {
    const fx = await makeFixture();
    const before = await revisionCount(fx.itemId); // the 'created' revision

    const updated = await workItemsService.updateStatus(fx.itemId, 'in_progress', fx.ctx);
    expect(updated.status).toBe('in_progress');

    const revs = await workItemRevisionRepository.listByWorkItem(fx.itemId);
    expect(revs.length).toBe(before + 1);
    const latest = revs[0]!; // newest-first
    expect(latest.changeKind).toBe('updated');
    expect((latest.diff as Record<string, unknown>).status).toEqual({
      from: 'todo',
      to: 'in_progress',
    });
  });

  it('an illegal transition (todo→done, no seed edge) is rejected with IllegalTransitionError', async () => {
    const fx = await makeFixture();
    await expect(workItemsService.updateStatus(fx.itemId, 'done', fx.ctx)).rejects.toThrow(
      IllegalTransitionError,
    );
    // status unchanged, no revision written
    expect((await workItemsService.getWorkItem(fx.itemId, fx.ctx)).status).toBe('todo');
  });

  it('an unknown target status key is rejected with UnknownStatusError', async () => {
    const fx = await makeFixture();
    await expect(workItemsService.updateStatus(fx.itemId, 'nope', fx.ctx)).rejects.toThrow(
      UnknownStatusError,
    );
  });

  it('a no-op transition (to the current status) succeeds WITHOUT writing a revision', async () => {
    const fx = await makeFixture();
    const before = await revisionCount(fx.itemId);
    const same = await workItemsService.updateStatus(fx.itemId, 'todo', fx.ctx);
    expect(same.status).toBe('todo');
    expect(await revisionCount(fx.itemId)).toBe(before);
  });
});

describe('updateStatus — open mode', () => {
  it('accepts any legal status as a transition target, even with no transition row', async () => {
    const fx = await makeFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    // todo→done has NO transition row, but open mode allows any real status.
    const updated = await workItemsService.updateStatus(fx.itemId, 'done', fx.ctx);
    expect(updated.status).toBe('done');
  });

  it('still rejects an unknown status key in open mode', async () => {
    const fx = await makeFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    await expect(workItemsService.updateStatus(fx.itemId, 'ghost', fx.ctx)).rejects.toThrow(
      UnknownStatusError,
    );
  });
});

describe('updateStatus — tenant gate', () => {
  it('a cross-workspace work-item id → WorkItemNotFoundError (404), NOT UnknownStatusError', async () => {
    const fx = await makeFixture('tv-w1@example.com');
    // A second workspace + user; its ctx must not reach W1's item.
    const userB = await usersService.createUser({
      email: 'tv-w2@example.com',
      password: 'hunter2hunter2',
      name: 'TV W2',
    });
    const w2 = await workspacesService.createWorkspace({ name: 'TV W2 WS', ownerUserId: userB.id });
    const ctxB: ServiceContext = { userId: userB.id, workspaceId: w2.workspace.id };
    // 'in_progress' IS a real status in W1, so if the tenant gate didn't fire
    // first this would be a legal/illegal-transition path — assert the 404.
    await expect(workItemsService.updateStatus(fx.itemId, 'in_progress', ctxB)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });
});

describe('updateStatus — atomicity (status + revision in one transaction)', () => {
  it('a forced revision-insert failure rolls back the status change', async () => {
    const fx = await makeFixture();
    // A bogus changedById (no such user) makes the revision insert fail on its
    // FK — the whole transaction (status write + revision) must roll back.
    const poisonedCtx: ServiceContext = {
      userId: 'user-does-not-exist',
      workspaceId: fx.workspaceId,
    };
    await expect(
      workItemsService.updateStatus(fx.itemId, 'in_progress', poisonedCtx),
    ).rejects.toThrow();

    // Status unchanged — the rollback undid the (otherwise-valid) status write.
    expect((await workItemsService.getWorkItem(fx.itemId, fx.ctx)).status).toBe('todo');
    // No 'updated' revision persisted (only the original 'created').
    const revs = await workItemRevisionRepository.listByWorkItem(fx.itemId);
    expect(revs.every((r) => r.changeKind !== 'updated')).toBe(true);
  });
});
