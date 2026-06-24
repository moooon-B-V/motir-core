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
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'cancelled' } });
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
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'cancelled' } });
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
    await db.workItem.update({ where: { id: blockerInB.id }, data: { status: 'cancelled' } });
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
    await db.workItem.update({ where: { id: blockerInA.id }, data: { status: 'cancelled' } });
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

describe('ready cascade through the ancestor chain (Subtask 7.0.13)', () => {
  // Build epic → story → subtask, returning the three ids + a free task to use
  // as a blocker. The subtask has NO own blocker, so its readiness is decided
  // entirely by the ancestor chain.
  async function tree() {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'E' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'S', parentId: epic.id },
      fx.ctx,
    );
    const subtask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'T', parentId: story.id },
      fx.ctx,
    );
    return { fx, epic, story, subtask };
  }

  async function block(
    fromId: string,
    fx: { projectId: string; ctx: Parameters<typeof workItemsService.isReady>[1] },
  ) {
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'BLK' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    return blocker;
  }

  it('a subtask with no own blocker is NOT ready while its STORY is blocked, and becomes ready once the story clears', async () => {
    const { fx, subtask, story } = await tree();
    // Baseline: nothing blocked → the subtask is ready.
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(true);

    // Block the STORY (an open sibling-level blocker). The subtask's own blockers
    // are still empty, but the cascade holds it out.
    const blocker = await block(story.id, fx);
    expect(await workItemsService.isReady(story.id, fx.ctx)).toBe(false);
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(false);

    // Clear the story's blocker (cancelled = category=done) → the chain is ready
    // again, so the subtask re-enters the ready set.
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'cancelled' } });
    expect(await workItemsService.isReady(story.id, fx.ctx)).toBe(true);
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(true);
  });

  it('blocks the subtree when the grandparent EPIC is not ready', async () => {
    const { fx, epic, story, subtask } = await tree();
    const blocker = await block(epic.id, fx);
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(false);
    // The story (the middle node) is also held by its unready parent.
    expect(await workItemsService.isReady(story.id, fx.ctx)).toBe(false);
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(true);
  });

  it("the flat rule still holds at the leaf: a subtask's OWN open blocker keeps it not-ready even when the chain is clear", async () => {
    const { fx, subtask } = await tree();
    const blocker = await block(subtask.id, fx);
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(false);
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    expect(await workItemsService.isReady(subtask.id, fx.ctx)).toBe(true);
  });

  it('the ready SET (listReady) reflects the cascade — the subtask is absent while its story is blocked, present once cleared', async () => {
    const { fx, subtask, story } = await tree();
    const inReady = async () =>
      (await workItemsService.listReady(fx.projectId, {}, fx.ctx)).items.some(
        (r) => r.id === subtask.id,
      );
    expect(await inReady()).toBe(true);

    const blocker = await block(story.id, fx);
    expect(await inReady()).toBe(false);

    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    expect(await inReady()).toBe(true);
  });

  it('listReady FILLS its window past not-ready candidates — a non-empty count never renders an empty list (count/list agree)', async () => {
    const fx = await makeWorkItemFixture();
    // An OPEN, NON-candidate blocker: `in_progress` is not terminal (so it
    // blocks) and is itself excluded from the ready set (candidates are
    // todo-category only) — so it can't slip into the ready window as a red
    // herring.
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'B' },
      fx.ctx,
    );
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'in_progress' } });
    // Two NOT-ready tasks created FIRST (lower keys → they sort AHEAD under
    // `(type, priority, key)`), each blocked by the in-progress task.
    for (const title of ['NR1', 'NR2']) {
      const nr = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      );
      await workItemsService.linkWorkItems(
        { fromId: nr.id, toId: blocker.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }
    // One READY task created LAST → highest key → sorts AFTER the not-ready ones.
    const ready = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'READY' },
      fx.ctx,
    );

    // A small window (limit 2) whose FIRST candidate page is entirely not-ready
    // (NR1, NR2). Before the window-fill, listReady returned that empty page →
    // the /ready page showed its empty state while the count badge said 1. Now
    // listReady walks past them to surface READY, so the two agree.
    const page = await workItemsService.listReady(fx.projectId, { limit: 2 }, fx.ctx);
    const count = await workItemsService.countReady(fx.projectId, {}, fx.ctx);

    expect(count.count).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((i) => i.id)).toContain(ready.id);
  });
});

describe('getIssueDetail readiness.blockedByAncestor — the cascade cause (Subtask 7.0.13)', () => {
  // The detail/quick-view readiness banner needs to NAME why a cascade-blocked
  // item is blocked: own blockers are clear but a blocked ancestor holds it out.
  // getReadiness already computes this; getIssueDetail surfaces the nearest
  // own-blocked ancestor as a summary so the shared ReadinessBadge can render it.
  async function tree() {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'E' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'S', parentId: epic.id },
      fx.ctx,
    );
    const subtask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'T', parentId: story.id },
      fx.ctx,
    );
    return { fx, epic, story, subtask };
  }
  async function blockWith(
    fromId: string,
    fx: { projectId: string; ctx: Parameters<typeof workItemsService.isReady>[1] },
  ) {
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'BLK' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    return blocker;
  }

  it('names the nearest own-blocked ancestor when the item has no own blocker', async () => {
    const { fx, story, subtask } = await tree();
    await blockWith(story.id, fx);

    const detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    expect(detail.readiness.ready).toBe(false);
    expect(detail.readiness.openBlockers).toEqual([]); // no OWN blockers
    expect(detail.readiness.blockedByAncestor?.id).toBe(story.id); // the parent is the cause
    expect(detail.readiness.blockedByAncestor?.identifier).toBe(story.identifier);
  });

  it('surfaces the NEAREST own-blocked ancestor when both parent and grandparent are blocked', async () => {
    const { fx, epic, story, subtask } = await tree();
    await blockWith(epic.id, fx);
    await blockWith(story.id, fx);

    const detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    // The parent (story) is nearer than the grandparent (epic).
    expect(detail.readiness.blockedByAncestor?.id).toBe(story.id);
  });

  it('is null when the item has its OWN open blocker (own blockers take precedence)', async () => {
    const { fx, subtask } = await tree();
    const own = await blockWith(subtask.id, fx);

    const detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    expect(detail.readiness.ready).toBe(false);
    expect(detail.readiness.openBlockers.map((b) => b.id)).toEqual([own.id]);
    expect(detail.readiness.blockedByAncestor).toBeNull();
  });

  it('is null when the item is ready (chain clear)', async () => {
    const { fx, subtask } = await tree();
    const detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    expect(detail.readiness.ready).toBe(true);
    expect(detail.readiness.blockedByAncestor).toBeNull();
  });

  it('clears once the ancestor blocker is resolved', async () => {
    const { fx, story, subtask } = await tree();
    const blocker = await blockWith(story.id, fx);

    let detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    expect(detail.readiness.blockedByAncestor?.id).toBe(story.id);

    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    detail = await workItemsService.getIssueDetail(fx.projectId, subtask.identifier, fx.ctx);
    expect(detail.readiness.ready).toBe(true);
    expect(detail.readiness.blockedByAncestor).toBeNull();
  });
});
