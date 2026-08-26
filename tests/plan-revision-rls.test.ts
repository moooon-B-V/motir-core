import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `plan_revision` RLS — direct-DB tenancy proof (Story MOTIR-3532 · MOTIR-3535).
//
// The table has NO `workspace_id` column of its own, deliberately: denormalizing
// tenancy onto a revision row would let it lie about which workspace it belongs
// to (the decision `work_item_revision` made first). Its policy therefore JOINS
// to the parent `plan`, which makes it the one shape a column-shaped RLS test
// cannot check by inspection — hence this file.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as a superuser, which
// has BYPASSRLS — RLS is inert under it regardless of FORCE ROW LEVEL SECURITY.
// Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE motir_app`. Without the role switch each one would assert the
// OPPOSITE of reality. `asAppRole` is a local copy of the helper in
// `tests/work-item-rls.test.ts` / `tests/project-rls.test.ts` — the RLS suites
// each carry their own; see those files for why it is not hoisted yet.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** Two independent tenants, each with a plan that has already written its trail. */
async function twoTenants() {
  const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
  const planA = await plansService.createPlan(a.projectId, { title: "Acme's plan" }, a.ctx);
  const planB = await plansService.createPlan(b.projectId, { title: "Other's plan" }, b.ctx);
  return { a, b, planA, planB };
}

describe('plan_revision RLS — the gate is the parent plan, not a column on the row', () => {
  it('a workspace sees ONLY its own plans’ revisions', async () => {
    const { a, planA } = await twoTenants();

    // Both tenants have exactly one revision row (their `created`), so a leak
    // would be visible as a count of two rather than as an empty result.
    expect(await adminDb.planRevision.count()).toBe(2);

    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.planId).toBe(planA.id);
  });

  it('with NO workspace GUC bound, nothing is visible — no context, nothing to see', async () => {
    await twoTenants();

    const rows = await asAppRole({}, (tx) => tx.planRevision.findMany());
    expect(rows).toEqual([]);
  });

  it('INSERTing a revision against ANOTHER workspace’s plan is rejected by WITH CHECK', async () => {
    const { a, planB } = await twoTenants();

    // The write names a plan that exists and is perfectly valid — it just lives
    // in somebody else's workspace. This is the hole a `workspace_id` column on
    // the revision row could not close, because the row would simply claim the
    // writer's own workspace and pass.
    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.planRevision.create({
          data: { planId: planB.id, changeKind: 'appended', diff: { proposalCount: 1 } },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // …and nothing landed.
    expect(await adminDb.planRevision.count({ where: { planId: planB.id } })).toBe(1);
  });

  it('UPDATE and DELETE of a foreign revision reach no row', async () => {
    const { a, planB } = await twoTenants();

    const updated = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.updateMany({
        where: { planId: planB.id },
        data: { changeKind: 'tampered' },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.deleteMany({ where: { planId: planB.id } }),
    );
    expect(deleted.count).toBe(0);

    const survivor = await adminDb.planRevision.findFirstOrThrow({ where: { planId: planB.id } });
    expect(survivor.changeKind).toBe('created');
  });
});
