import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Row-level security for the job-ledger tables (Story 1.6 · Subtask 1.6.4) —
// direct-DB tenancy proof for `job_run` + `job_run_dlq`. The Story-1.6 companion
// to tests/work-item-rls.test.ts.
//
// The job-ledger policy differs from project / work_item in ONE way: a
// system-admin escape hatch. job_run / job_run_dlq are written by the
// background-jobs runtime OUTSIDE any workspace context, and they hold
// untenanted SYSTEM rows (workspace_id IS NULL). So the policy admits a row
// when EITHER `app.workspace_id` matches OR `app.system_admin = 'true'`. This
// file proves:
//   * a tenant context (app.workspace_id set, no system_admin) sees ONLY its
//     workspace's rows — never another workspace's, never the system rows;
//   * the system-admin context sees everything, including the untenanted rows;
//   * with NO context, the non-bypass role sees nothing (safe failure mode);
//   * WRITES respect WITH CHECK: a tenant can insert only into its own
//     workspace; the system-admin branch is what lets the trusted writer insert
//     a row for any/no workspace.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser (BYPASSRLS) — RLS is inert under it regardless of FORCE ROW LEVEL
// SECURITY. Every assertion below runs inside a transaction that
// `SET LOCAL ROLE prodect_app` (the NOSUPERUSER NOBYPASSRLS role). The asAppRole
// helper binds the SAME GUCs the runtime binds (app.workspace_id via
// withWorkspaceContext for reads; app.system_admin via withSystemContext for the
// trusted writer) then drops the role so the policies bite. Local copy of the
// helper, per the convention each RLS suite carries its own.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

interface JobLedgerFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  runW1Id: string;
  runW2Id: string;
  runSystemId: string;
  dlqW1Id: string;
  dlqW2Id: string;
  dlqSystemId: string;
}

let seq = 0;
function uniq(): string {
  seq += 1;
  return `seed-${seq}`;
}

async function seedJobRun(workspaceId: string | null): Promise<string> {
  const row = await db.jobRun.create({
    data: {
      workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: uniq(),
      attempt: 0,
      status: 'succeeded',
    },
  });
  return row.id;
}

async function seedDlq(workspaceId: string | null): Promise<string> {
  const row = await db.jobRunDlq.create({
    data: {
      workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
      functionId: 'email.send',
      eventName: 'email.send',
      eventData: { idempotencyKey: uniq() },
      failure: { message: 'seed failure' },
      attempts: 1,
    },
  });
  return row.id;
}

// Two tenants + one untenanted (system) row per table.
async function makeLedgerFixture(): Promise<JobLedgerFixture> {
  const userA = await usersService.createUser({
    email: 'jobs-rls-a@example.com',
    password: 'hunter2hunter2',
    name: 'Jobs RLS A',
  });
  const userB = await usersService.createUser({
    email: 'jobs-rls-b@example.com',
    password: 'hunter2hunter2',
    name: 'Jobs RLS B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'Jobs WS 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'Jobs WS 2', ownerUserId: userB.id });

  return {
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    runW1Id: await seedJobRun(w1.workspace.id),
    runW2Id: await seedJobRun(w2.workspace.id),
    runSystemId: await seedJobRun(null),
    dlqW1Id: await seedDlq(w1.workspace.id),
    dlqW2Id: await seedDlq(w2.workspace.id),
    dlqSystemId: await seedDlq(null),
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id /
 * app.user_id / app.system_admin and (b) drops to the non-bypass prodect_app
 * role for the duration. The role switch is what makes RLS bite; it reverts at
 * txn end.
 */
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
    if (ctx.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('job_run RLS — read isolation', () => {
  it('with NO context, prodect_app sees zero job_run rows', async () => {
    await makeLedgerFixture();
    const rows = await asAppRole({}, (tx) => tx.jobRun.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context bound, only W1's runs are visible — never W2's, never system", async () => {
    const fx = await makeLedgerFixture();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) => tx.jobRun.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.runW1Id]);
    expect(ids).not.toContain(fx.runW2Id);
    expect(ids).not.toContain(fx.runSystemId);
  });

  it('a tenant cannot SELECT a system (null-workspace) run', async () => {
    const fx = await makeLedgerFixture();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobRun.findMany({ where: { id: fx.runSystemId } }),
    );
    expect(rows).toEqual([]);
  });

  it('the system-admin context sees every run, including the untenanted system row', async () => {
    const fx = await makeLedgerFixture();
    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.jobRun.findMany());
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.runW1Id, fx.runW2Id, fx.runSystemId].sort());
  });
});

describe('job_run_dlq RLS — read isolation', () => {
  it('with NO context, prodect_app sees zero DLQ rows', async () => {
    await makeLedgerFixture();
    const rows = await asAppRole({}, (tx) => tx.jobRunDlq.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context, only W1's DLQ entries are visible", async () => {
    const fx = await makeLedgerFixture();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobRunDlq.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.dlqW1Id]);
    expect(ids).not.toContain(fx.dlqW2Id);
    expect(ids).not.toContain(fx.dlqSystemId);
  });

  it('system-event DLQ reads require the system-admin context', async () => {
    const fx = await makeLedgerFixture();
    // Tenant context: system row hidden.
    const asTenant = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobRunDlq.findMany({ where: { id: fx.dlqSystemId } }),
    );
    expect(asTenant).toEqual([]);
    // System-admin context: system row visible.
    const asAdmin = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.jobRunDlq.findMany({ where: { id: fx.dlqSystemId } }),
    );
    expect(asAdmin.map((r) => r.id)).toEqual([fx.dlqSystemId]);
  });
});

describe('job_run RLS — write isolation (WITH CHECK)', () => {
  it('a tenant can INSERT a run for its OWN workspace', async () => {
    const fx = await makeLedgerFixture();
    const created = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobRun.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          functionId: 'email.send',
          eventName: 'email.send',
          eventId: 'own-ws-insert',
          attempt: 0,
          status: 'running',
        },
      }),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('a tenant CANNOT INSERT a run for ANOTHER workspace (WITH CHECK rejects)', async () => {
    const fx = await makeLedgerFixture();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.jobRun.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            functionId: 'email.send',
            eventName: 'email.send',
            eventId: 'foreign-ws-insert',
            attempt: 0,
            status: 'running',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the system-admin context (the trusted writer) can INSERT a run for any/no workspace', async () => {
    const fx = await makeLedgerFixture();
    // A tenanted insert with no app.workspace_id bound — only the system-admin
    // branch can admit this, which is exactly the runtime writer's situation.
    const tenanted = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.jobRun.create({
        data: {
          workspaceId: fx.workspaceW2Id,
          functionId: 'email.send',
          eventName: 'email.send',
          eventId: 'sysadmin-tenanted',
          attempt: 0,
          status: 'running',
        },
      }),
    );
    expect(tenanted.workspaceId).toBe(fx.workspaceW2Id);

    const system = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.jobRun.create({
        data: {
          functionId: 'system.daily-health-check',
          eventName: 'scheduled.system.daily-health-check',
          eventId: 'sysadmin-system',
          attempt: 0,
          status: 'running',
        },
      }),
    );
    expect(system.workspaceId).toBeNull();
  });
});
