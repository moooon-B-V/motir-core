import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// MOTIR-6359 — the roadmap read says, for each OFF-LEVEL edge, what the canvas
// draws: `covered` when the parents carry the edge, `uncovered` / `cross_level`
// when the validators call it invalid, `exempt` when an end has no parent. Design
// `design/roadmap/design-notes.md` § "Covered cross-parent edges" (MOTIR-6353).
// Real Postgres, no mocks (the spies below only COUNT calls).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function link(fx: WorkItemFixture, blockedId: string, blockerId: string): Promise<void> {
  await adminDb.workItemLink.create({
    data: {
      fromId: blockedId,
      toId: blockerId,
      kind: 'is_blocked_by',
      workspaceId: fx.workspaceId,
      createdById: fx.ctx.userId,
    },
  });
}

/**
 *   E1 (epic) ─ A (story) ─ a1, a2      E2 (epic) ─ C (story) ─ c1
 *            └ B (story) ─ b1, b2
 */
async function buildTree(fx: WorkItemFixture) {
  const E1 = await createWorkItem(fx, { kind: 'epic', title: 'Checkout' });
  const E2 = await createWorkItem(fx, { kind: 'epic', title: 'Payments platform' });
  const A = await createWorkItem(fx, { kind: 'story', title: 'Payments API', parentId: E1.id });
  const B = await createWorkItem(fx, { kind: 'story', title: 'Checkout flow', parentId: E1.id });
  const C = await createWorkItem(fx, { kind: 'story', title: 'Audit log', parentId: E2.id });
  const a1 = await createWorkItem(fx, { kind: 'subtask', title: 'Tokenise', parentId: A.id });
  const b1 = await createWorkItem(fx, { kind: 'subtask', title: 'Charge', parentId: B.id });
  const b2 = await createWorkItem(fx, { kind: 'subtask', title: 'Receipt', parentId: B.id });
  const c1 = await createWorkItem(fx, { kind: 'subtask', title: 'Audit', parentId: C.id });
  return { E1, E2, A, B, C, a1, b1, b2, c1 };
}

function coverageOf(
  res: Awaited<ReturnType<typeof workItemsService.getProjectRoadmap>>,
  blockedId: string,
  blockerId: string,
) {
  return res.edges.find((e) => e.blockedId === blockedId && e.blockerId === blockerId)?.coverage;
}

describe('getProjectRoadmap — off-level edge disposition (MOTIR-6359)', () => {
  it('UNCOVERED until the stories carry the edge, then COVERED', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    await link(fx, t.b1.id, t.a1.id);

    let res = await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx);
    expect(coverageOf(res, t.b1.id, t.a1.id)).toBe('uncovered');

    await link(fx, t.B.id, t.A.id);
    res = await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx);
    expect(coverageOf(res, t.b1.id, t.a1.id)).toBe('covered');
  });

  it('a STORY blocked by a story in another epic follows the same rule against its epic', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    await link(fx, t.B.id, t.C.id);

    let res = await workItemsService.getProjectRoadmap(fx.projectId, t.E1.id, fx.ctx);
    expect(coverageOf(res, t.B.id, t.C.id)).toBe('uncovered');

    await link(fx, t.E1.id, t.E2.id);
    res = await workItemsService.getProjectRoadmap(fx.projectId, t.E1.id, fx.ctx);
    expect(coverageOf(res, t.B.id, t.C.id)).toBe('covered');
  });

  it('a CROSS-LEVEL edge is cross_level even when the parents are linked', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    // b1 (depth 2) blocked by story C (depth 1): written straight to the table,
    // as a pre-rule edge would be.
    await link(fx, t.b1.id, t.C.id);
    await link(fx, t.B.id, t.E2.id);
    const res = await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx);
    expect(coverageOf(res, t.b1.id, t.C.id)).toBe('cross_level');
  });

  it('EXEMPT: two roots, one of them filed', async () => {
    const fx = await makeFixture();
    const R = await createWorkItem(fx, { kind: 'task', title: 'Rotate credentials' });
    const F = await createWorkItem(fx, { kind: 'task', title: 'Secrets store' });
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Ops' },
      fx.ctx,
    );
    await foldersService.fileWorkItem(F.id, { folderId: folder.id }, fx.ctx);
    await link(fx, R.id, F.id);

    const res = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      folders: true,
    });
    expect(coverageOf(res, R.id, F.id)).toBe('exempt');
  });

  it('a WITHIN-level edge carries no disposition', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    await link(fx, t.b2.id, t.b1.id);
    const res = await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx);
    const edge = res.edges.find((e) => e.blockedId === t.b2.id);
    expect(edge).toEqual({ blockedId: t.b2.id, blockerId: t.b1.id });
  });

  it('SPRINT scope carries no disposition — its own arm decides', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    const sprint = await adminDb.sprint.create({
      data: {
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        name: 'S1',
        state: 'active',
        sequence: 1,
      },
    });
    await adminDb.workItem.update({ where: { id: t.B.id }, data: { sprintId: sprint.id } });
    await link(fx, t.b1.id, t.a1.id);
    const res = await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx, {
      scope: 'sprint',
    });
    expect(res.edges.every((e) => e.coverage === undefined)).toBe(true);
  });

  it('BOUNDED: the same number of reads for 1 off-level edge as for 20', async () => {
    const fx = await makeFixture();
    const t = await buildTree(fx);
    const count = async () => {
      const ancestors = vi.spyOn(workItemRepository, 'findAncestorIdsForItems');
      const among = vi.spyOn(workItemLinkRepository, 'findBlockedByAmong');
      await workItemsService.getProjectRoadmap(fx.projectId, t.B.id, fx.ctx);
      const calls = [ancestors.mock.calls.length, among.mock.calls.length];
      vi.restoreAllMocks();
      return calls;
    };

    await link(fx, t.b1.id, t.a1.id);
    const one = await count();

    for (let i = 0; i < 19; i += 1) {
      const blocker = await createWorkItem(fx, {
        kind: 'subtask',
        title: `Blocker ${i}`,
        parentId: i % 2 === 0 ? t.A.id : t.C.id,
      });
      await link(fx, t.b1.id, blocker.id);
    }
    const twenty = await count();

    // The ancestor read is shared with the readiness leg (`getReadinessForItems`),
    // so its count is not 1; what the criterion asks is that it does not GROW.
    expect(one[1]).toBe(1);
    expect(twenty).toEqual(one);
  });
});
