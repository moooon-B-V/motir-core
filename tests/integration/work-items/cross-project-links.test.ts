import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestProject, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 1.4.7 — cross-project links WITHIN one workspace.
//
// The work_item tree is project-local, but a LINK (is_blocked_by / relates_to
// / …) is workspace-scoped: two items in different projects of the same
// workspace may be linked. This is a deliberate v1 use case (a Story in
// project A blocked by an infra Task in project B). Two facts this file pins,
// neither covered before 1.4.7:
//
//   1. The SERVICE path — workItemsService.linkWorkItems — accepts a
//      cross-project (same-workspace) pair, and getBlockers / getBlocking /
//      isReady resolve the cross-project endpoint. The workspace-consistency
//      trigger passes (both items share a workspaceId); there is no
//      same-project constraint on links (unlike on parent edges).
//
//   2. RLS: the work_item_link table carries NO project-narrowing policy, so a
//      cross-project link stays visible even under an app.project_id =
//      <one project> binding — whereas the OTHER project's work_item endpoint
//      IS narrowed out. That contrast is exactly why the service resolves
//      blockers at WORKSPACE scope (project_id = '' / the unscoped reader),
//      not under a single-project narrowing. (work-item-rls.test.ts proves the
//      link-narrowing exemption for a directly-inserted link; here it's a
//      link minted by the real service flow.)
//
// Real Postgres, no mocks. The RLS assertion drops to the non-bypass
// prodect_app role (the dev/CI superuser has BYPASSRLS, so RLS is inert under
// it — see work-item-rls.test.ts's header). asAppRole is a local copy of the
// helper the RLS suites each carry.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

/**
 * One workspace W1 with TWO projects P1 + P2, plus an item A in P1 and B in
 * P2. The owner of W1 reports both. Built on makeWorkItemFixture (W1 + P1 +
 * owner), then a second project added in the same workspace.
 */
async function twoProjectsOneWorkspace(): Promise<{
  fx: WorkItemFixture;
  projectP2Id: string;
  itemAId: string;
  itemBId: string;
}> {
  const fx = await makeWorkItemFixture({ identifier: 'PONE' });
  const p2 = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Project Two',
    identifier: 'PTWO',
  });

  const a = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'A in P1' },
    fx.ctx,
  );
  const b = await workItemsService.createWorkItem(
    { projectId: p2.id, kind: 'task', title: 'B in P2' },
    fx.ctx,
  );
  return { fx, projectP2Id: p2.id, itemAId: a.id, itemBId: b.id };
}

describe('cross-project links — service path (same workspace, different projects)', () => {
  it('linkWorkItems(A is_blocked_by B) succeeds and getBlockers/getBlocking resolve the cross-project endpoint', async () => {
    const { fx, itemAId, itemBId } = await twoProjectsOneWorkspace();

    const link = await workItemsService.linkWorkItems(
      { fromId: itemAId, toId: itemBId, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(link.fromId).toBe(itemAId);
    expect(link.toId).toBe(itemBId);

    // A's blocker is B (in the OTHER project); B blocks A.
    const blockers = await workItemsService.getBlockers(itemAId, fx.ctx);
    expect(blockers.map((w) => w.id)).toEqual([itemBId]);
    const blocking = await workItemsService.getBlocking(itemBId, fx.ctx);
    expect(blocking.map((w) => w.id)).toEqual([itemAId]);
  });

  it('isReady honors a cross-project blocker (false until B is done)', async () => {
    const { fx, itemAId, itemBId } = await twoProjectsOneWorkspace();
    await workItemsService.linkWorkItems(
      { fromId: itemAId, toId: itemBId, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await workItemsService.isReady(itemAId, fx.ctx)).toBe(false);
    await workItemsService.updateWorkItem(itemBId, { status: 'done' }, fx.ctx);
    expect(await workItemsService.isReady(itemAId, fx.ctx)).toBe(true);
  });

  it('getBlockers still resolves the cross-project blocker when called from inside a P1-narrowed context', async () => {
    // The card AC: "getBlockers(A) returns B even when called under a
    // P1-narrowed project context." The service's read paths run on the
    // unscoped `db` singleton (not the ambient withWorkspaceContext tx), and
    // the link table has no project policy — so an active P1 narrowing never
    // hides the cross-project blocker from the service API. We invoke
    // getBlockers from WITHIN a withWorkspaceContext({ projectId: P1 }) block
    // to encode that the surrounding narrowing is irrelevant to the result.
    const { fx, itemAId, itemBId } = await twoProjectsOneWorkspace();
    await workItemsService.linkWorkItems(
      { fromId: itemAId, toId: itemBId, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const blockers = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      () => workItemsService.getBlockers(itemAId, fx.ctx),
    );
    expect(blockers.map((w) => w.id)).toEqual([itemBId]);
  });
});

describe('cross-project links — RLS narrowing does not apply to the link table', () => {
  it('the cross-project link row stays visible under app.project_id = P1, even though B (in P2) does not', async () => {
    const { fx, itemAId, itemBId } = await twoProjectsOneWorkspace();
    const link = await workItemsService.linkWorkItems(
      { fromId: itemAId, toId: itemBId, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // Bind the W1 workspace AND narrow to P1, dropping to the non-bypass role.
    const ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };

    // The link row is visible — work_item_link has no project-scoped policy.
    const links = await asAppRole(ctx, (tx) => tx.workItemLink.findMany());
    expect(links.map((l) => l.id)).toEqual([link.id]);

    // The contrast: under P1 narrowing, B's work_item (in P2) is hidden by the
    // restrictive project policy — so a single-project-narrowed reader could
    // NOT resolve the blocker's row. That's precisely why the service resolves
    // blockers at workspace scope, not under a project narrowing.
    const visibleItems = await asAppRole(ctx, (tx) =>
      tx.workItem.findMany({ where: { id: { in: [itemAId, itemBId] } } }),
    );
    expect(visibleItems.map((w) => w.id)).toEqual([itemAId]);
  });
});
