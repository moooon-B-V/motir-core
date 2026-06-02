import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Readiness against per-project terminal sets (Story 2.2 · Subtask 2.2.6,
// resolving finding #21). isReady no longer hardcodes 'done' — a blocker is
// resolved iff its status is in ITS OWN project's terminal-key set
// (category = done). Real Postgres; projects come from createTestProject
// (auto-seeded default workflow: done + cancelled are both category=done).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Recategorize a status in a project (admin would do this via 2.2.5's UI). */
async function recategorize(
  projectId: string,
  key: string,
  category: 'todo' | 'in_progress' | 'done',
): Promise<void> {
  await db.workflowStatus.updateMany({ where: { projectId, key }, data: { category } });
}

describe('isReady — terminal status is per-project category=done (finding #21)', () => {
  it('a `cancelled` blocker counts as RESOLVED out of the box (cancelled is category=done)', async () => {
    const fx = await makeWorkItemFixture();
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'B' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: x.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // Blocker still in `todo` → blocking.
    expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(false);

    // Cancel the blocker — `cancelled` is category=done in the default seed.
    await workItemsService.updateWorkItem(blocker.id, { status: 'cancelled' }, fx.ctx);
    expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(true);
  });

  it('recategorizing `cancelled` → todo makes the same blocker block again (live category, not a hardcoded set)', async () => {
    const fx = await makeWorkItemFixture();
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'B' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: x.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(blocker.id, { status: 'cancelled' }, fx.ctx);
    expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(true);

    // Admin recategorizes cancelled to a non-terminal bucket → it's no longer
    // resolved, and readiness re-reads the LIVE category.
    await recategorize(fx.projectId, 'cancelled', 'todo');
    expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(false);
  });

  it('cross-project: each blocker is classified by ITS OWN project terminal set', async () => {
    const fx = await makeWorkItemFixture();
    const projectB = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Project B',
      identifier: 'PROJB',
    });
    // In project B only, recategorize cancelled to non-terminal.
    await recategorize(projectB.id, 'cancelled', 'todo');

    // X (project A) blocked by a cancelled blocker in PROJECT B → B's terminal
    // set excludes cancelled → still blocked.
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    const blockerInB = await workItemsService.createWorkItem(
      { projectId: projectB.id, kind: 'task', title: 'BB' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(blockerInB.id, { status: 'cancelled' }, fx.ctx);
    await workItemsService.linkWorkItems(
      { fromId: x.id, toId: blockerInB.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(false);

    // Control: X2 (project A) blocked by a cancelled blocker in PROJECT A →
    // A still has cancelled as category=done → resolved → ready.
    const x2 = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X2' },
      fx.ctx,
    );
    const blockerInA = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'BA' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(blockerInA.id, { status: 'cancelled' }, fx.ctx);
    await workItemsService.linkWorkItems(
      { fromId: x2.id, toId: blockerInA.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(await workItemsService.isReady(x2.id, fx.ctx)).toBe(true);
  });

  it('no N+1: one blocker query + one terminal-set query regardless of how many blocker projects', async () => {
    const fx = await makeWorkItemFixture();
    const projectB = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Project B2',
      identifier: 'PRJB2',
    });
    const x = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'X' },
      fx.ctx,
    );
    // Three blockers across TWO projects (2 in A, 1 in B), all non-terminal.
    for (const [pid, title] of [
      [fx.projectId, 'b1'],
      [fx.projectId, 'b2'],
      [projectB.id, 'b3'],
    ] as const) {
      const b = await workItemsService.createWorkItem(
        { projectId: pid, kind: 'task', title },
        fx.ctx,
      );
      await workItemsService.linkWorkItems(
        { fromId: x.id, toId: b.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }

    const blockerSpy = vi.spyOn(workItemLinkRepository, 'findBlockerStates');
    const terminalSpy = vi.spyOn(workflowsRepository, 'findStatusesByProjects');
    try {
      expect(await workItemsService.isReady(x.id, fx.ctx)).toBe(false);
      // Exactly two queries — NOT one-per-blocker-project.
      expect(blockerSpy).toHaveBeenCalledTimes(1);
      expect(terminalSpy).toHaveBeenCalledTimes(1);
    } finally {
      blockerSpy.mockRestore();
      terminalSpy.mockRestore();
    }
  });
});
