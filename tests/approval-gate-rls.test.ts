import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `approval_gate` RLS — read + write isolation (Story MOTIR-4778 · Subtask
// MOTIR-4788; ADR docs/decisions/approval-gates.md). The policy is a PURE
// active-workspace gate (`ENABLE` + `FORCE`, no `app.system_admin` arm) — the
// shape `design_evidence` / `acceptance_evidence` carry, NOT the
// `system_admin OR workspace_id` shape the connection-tier tables use.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE.
// Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE motir_app` (the non-bypass role). WITHOUT the role switch
// each would assert the OPPOSITE of reality. `asAppRole` is a local copy of the
// helper in tests/ciFleet/ci-container-usage-rls.test.ts, for the reason that
// file gives (each RLS suite keeps its own copy so the role-switch shape lives
// beside the policy it asserts).

interface GateTenantFixture {
  fx: WorkItemFixture;
  itemAId: string;
  itemBId: string;
  gateAIds: string[];
  gateBId: string;
  /** Tenant B's own tenancy columns — the target a smuggling INSERT names. */
  workspaceBId: string;
  projectBId: string;
}

async function makeTenants(): Promise<GateTenantFixture> {
  // Two independent tenants. A holds THREE awaiting gates (differing subjects
  // on one card — the partial unique is per-(workItem,kind,subject), so
  // distinct subjects coexist); B holds ONE. The populations DIFFER (3 vs 1),
  // so a workspace-A-scoped read (3) and the true population (4) cannot return
  // the same number — the fixture measures the POLICY, not the count.
  const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
  const b = await makeWorkItemFixture({ name: 'Bravo', identifier: 'BRAVO' });
  const itemA = await workItemsService.createWorkItem(
    { projectId: a.projectId, kind: 'task', title: 'A host' },
    a.ctx,
  );
  const itemB = await workItemsService.createWorkItem(
    { projectId: b.projectId, kind: 'task', title: 'B host' },
    b.ctx,
  );
  const gateAIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = await adminDb.approvalGate.create({
      data: {
        workspaceId: a.workspaceId,
        projectId: a.projectId,
        workItemId: itemA.id,
        kind: 'design_result',
        subjectId: `a-subj-${i}`,
      },
    });
    gateAIds.push(row.id);
  }
  const gateB = await adminDb.approvalGate.create({
    data: {
      workspaceId: b.workspaceId,
      projectId: b.projectId,
      workItemId: itemB.id,
      kind: 'design_result',
      subjectId: 'b-subj-0',
    },
  });
  return {
    fx: a,
    itemAId: itemA.id,
    itemBId: itemB.id,
    gateAIds,
    gateBId: gateB.id,
    workspaceBId: b.workspaceId,
    projectBId: b.projectId,
  };
}

/** Run `fn` with the given GUCs bound, as the non-bypass `motir_app` role —
 *  the role switch is what makes RLS actually bite. Reverts at txn end. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin === true) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('approval_gate RLS — read isolation (pure active-workspace gate, no system-admin hatch)', () => {
  it('with NO GUC set, the motir_app role sees zero gate rows', async () => {
    await makeTenants();
    expect(await asAppRole({}, (tx) => tx.approvalGate.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's gates are visible — never B's", async () => {
    const fx = await makeTenants();
    const rows = await asAppRole({ userId: fx.fx.ownerId, workspaceId: fx.fx.workspaceId }, (tx) =>
      tx.approvalGate.findMany(),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...fx.gateAIds].sort());
  });

  it('the fixture populations DIFFER — a scoped read (3) is not the true count (4)', async () => {
    const fx = await makeTenants();
    const scoped = await asAppRole(
      { userId: fx.fx.ownerId, workspaceId: fx.fx.workspaceId },
      (tx) => tx.approvalGate.findMany(),
    );
    const total = await adminDb.approvalGate.count();
    expect(scoped).toHaveLength(3);
    expect(total).toBe(4);
    expect(scoped.length).not.toBe(total);
  });

  it('the system-admin GUC buys nothing — the policy has NO system-admin arm', async () => {
    const fx = await makeTenants();
    // `system_admin` is set but `app.workspace_id` is NOT — the policy reads
    // only the workspace GUC, so the row's `workspace_id` is compared to NULL
    // and every row is hidden. This is the absence of the connection-tier
    // `system_admin OR …` arm, asserted rather than assumed.
    expect(await asAppRole({ systemAdmin: true }, (tx) => tx.approvalGate.findMany())).toEqual([]);
    expect(fx.gateAIds).toHaveLength(3);
  });

  it("tenant A cannot read tenant B's gate by id", async () => {
    const fx = await makeTenants();
    expect(
      await asAppRole({ userId: fx.fx.ownerId, workspaceId: fx.fx.workspaceId }, (tx) =>
        tx.approvalGate.findMany({ where: { id: fx.gateBId } }),
      ),
    ).toEqual([]);
  });
});

describe('approval_gate RLS — write isolation', () => {
  it('a gate tenanted to B cannot be INSERTed while bound to A (WITH CHECK)', async () => {
    // approval_gate_active_workspace's WITH CHECK requires the new row's own
    // workspace_id to equal current_setting('app.workspace_id'). A's GUC is
    // workspace A; attempting to insert a row whose workspace_id is B's fails
    // WITH CHECK and Postgres raises insufficient_privilege (42501). (A pure
    // workspace gate sees only the row's own tenancy columns — it cannot peer
    // through the `work_item_id` FK, so tenancy consistency of the SUBJECT is
    // the decide-door service's job, exactly as for every sibling lifecycle
    // table.)
    const fx = await makeTenants();
    await expect(
      asAppRole({ userId: fx.fx.ownerId, workspaceId: fx.fx.workspaceId }, (tx) =>
        tx.approvalGate.create({
          data: {
            workspaceId: fx.workspaceBId, // B's tenancy…
            projectId: fx.projectBId,
            workItemId: fx.itemBId,
            kind: 'design_result',
            subjectId: 'smuggled',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
