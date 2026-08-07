import { type Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { truncateAuthTables } from '../helpers/db';

// `ci_runner_provisioning_intent` isolation — direct-DB RLS proof (Story
// MOTIR-1916 · MOTIR-1920), the workspace_id + RLS contract every new tenant
// table ships under (PRODECT_FINDINGS #20).
//
// The rows say which projects are building, how often, and with what job names —
// the same commercially sensitive shape the metering tables carry, one step
// earlier in the pipeline.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality. `asAppRole` is a local copy of the helper in
// ci-minutes-meter-rls.test.ts, for the reason that file gives.

const QUEUED_AT = new Date('2026-08-01T09:00:00.000Z');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface TenantFixture {
  userAId: string;
  workspaceAId: string;
  workspaceBId: string;
  orgBId: string;
  intentBId: string;
}

async function makeFleetTenants(): Promise<TenantFixture> {
  const userA = await usersService.createUser({
    email: 'ci-fleet-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Fleet Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'ci-fleet-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Fleet Tenant B',
  });
  const a = await workspacesService.createWorkspace({ name: 'Fleet WS A', ownerUserId: userA.id });
  const b = await workspacesService.createWorkspace({ name: 'Fleet WS B', ownerUserId: userB.id });

  await db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: a.workspace.id,
      organizationId: a.workspace.organizationId,
      installationId: '55501',
      runId: 'run-a',
      runAttempt: 1,
      jobId: 'job-a',
      repoOwner: 'motir-projects',
      repoName: 'alpha-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: QUEUED_AT,
    },
  });
  const intentB = await db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: b.workspace.id,
      organizationId: b.workspace.organizationId,
      installationId: '55501',
      runId: 'run-b',
      runAttempt: 1,
      jobId: 'job-b',
      repoOwner: 'motir-projects',
      repoName: 'bravo-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: QUEUED_AT,
    },
  });

  return {
    userAId: userA.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    orgBId: b.workspace.organizationId,
    intentBId: intentB.id,
  };
}

/** Run `fn` with the given GUCs bound, as the non-bypass `prodect_app` role —
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('ci_runner_provisioning_intent RLS', () => {
  it('with NO GUC set, the prodect_app role sees zero intents', async () => {
    await makeFleetTenants();
    expect(await asAppRole({}, (tx) => tx.ciRunnerProvisioningIntent.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's intent is visible — never B's", async () => {
    const fx = await makeFleetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciRunnerProvisioningIntent.findMany(),
    );
    expect(rows.map((r) => r.runId)).toEqual(['run-a']);
  });

  it("tenant A cannot SELECT tenant B's intent by id", async () => {
    const fx = await makeFleetTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciRunnerProvisioningIntent.findMany({ where: { id: fx.intentBId } }),
      ),
    ).toEqual([]);
  });

  it("knowing B's ORGANIZATION id buys tenant A nothing", async () => {
    // `organization_id` is denormalized so MOTIR-1922's per-org in-flight cap is
    // one indexed read — but the RLS gate is the row's OWN workspace_id, and RLS
    // does not traverse foreign keys. The extra column widens the INDEX, never
    // the access.
    const fx = await makeFleetTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciRunnerProvisioningIntent.findMany({ where: { organizationId: fx.orgBId } }),
      ),
    ).toEqual([]);
  });

  it('tenant A cannot INSERT an intent into tenant B — WITH CHECK refuses it', async () => {
    const fx = await makeFleetTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciRunnerProvisioningIntent.create({
          data: {
            workspaceId: fx.workspaceBId,
            organizationId: fx.orgBId,
            installationId: '55501',
            runId: 'run-forged',
            runAttempt: 1,
            jobId: 'job-forged',
            repoOwner: 'motir-projects',
            repoName: 'bravo-web',
            requestedLabels: [MOTIR_RUNNER_LABEL],
            queuedAt: QUEUED_AT,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('the system-admin hatch DOES span tenants — the webhook writer needs it', async () => {
    // The deliberate difference from `project_repository`'s pure workspace gate:
    // this table's only writer is the `workflow_job` webhook, which has no
    // session and no active workspace. Without this branch the fleet could not
    // record its own intents at all.
    await makeFleetTenants();
    const rows = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.ciRunnerProvisioningIntent.findMany({ orderBy: { runId: 'asc' } }),
    );
    expect(rows.map((r) => r.runId)).toEqual(['run-a', 'run-b']);
  });
});
