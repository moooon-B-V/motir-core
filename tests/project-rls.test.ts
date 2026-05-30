import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from './helpers/db';

// Project isolation — direct-DB RLS proof (Subtask 1.3.6).
//
// Story-1.3-closing companion to tests/multi-tenant-rls.test.ts. That file
// proves cross-tenant isolation at the workspace + membership level; this
// file extends the same shape to the project table, the new tenant-scoped
// entity Story 1.3 shipped. Two independent tenants (each with their own
// workspace + one project) must never see or mutate each other's project
// rows once we drop to the non-bypass prodect_app role.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of
// FORCE ROW LEVEL SECURITY. Every RLS assertion below therefore runs inside
// a transaction that `SET LOCAL ROLE prodect_app` (the non-bypass role
// installed by the add_workspace_rls migration). Without the role switch
// each assertion would assert the OPPOSITE of reality. The role reverts at
// txn end. The asAppRole helper here is intentionally a local copy of the
// one in multi-tenant-rls.test.ts / workspace-rls.test.ts — see those files
// for the rationale on not hoisting it to a shared helper yet.
//
// Project RLS policy (20260529202445_add_project_rls): single `FOR ALL`
// policy `project_active_workspace`, USING + WITH CHECK both predicate on
// `"workspaceId" = current_setting('app.workspace_id', true)`. So:
//   * SELECT under workspace-A GUC hides B's project (USING).
//   * UPDATE on B's row from workspace-A GUC matches zero rows → P2025.
//   * INSERT with workspaceId=B from workspace-A GUC fails WITH CHECK →
//     SQLSTATE 42501 (the same denial code the no-INSERT-policy path on
//     workspace_membership produces — see multi-tenant-rls.test.ts).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface ProjectTenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  workspaceBId: string;
  projectAId: string;
  projectBId: string;
}

// Two independent tenants: user A owns workspace A with project A; user B
// owns workspace B with project B. Neither is a member of the other's
// workspace, and the projects are created via the service so the
// workspace context + identifier/slug derivation match production exactly.
// Setup runs as the superuser (BYPASSRLS) — that's fine; the assertions
// below are what runs as prodect_app and what RLS bites on.
async function makeProjectTenants(): Promise<ProjectTenantFixture> {
  const userA = await usersService.createUser({
    email: 'project-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Project Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'project-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Project Tenant B',
  });
  const a = await workspacesService.createWorkspace({
    name: 'Project Workspace A',
    ownerUserId: userA.id,
  });
  const b = await workspacesService.createWorkspace({
    name: 'Project Workspace B',
    ownerUserId: userB.id,
  });
  const projectA = await projectsService.createProject({
    workspaceId: a.workspace.id,
    actorUserId: userA.id,
    name: 'Alpha',
    identifier: 'ALPHA',
  });
  const projectB = await projectsService.createProject({
    workspaceId: b.workspace.id,
    actorUserId: userB.id,
    name: 'Bravo',
    identifier: 'BRAVO',
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    projectAId: projectA.id,
    projectBId: projectB.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally pins the user +
 * workspace GUCs the RLS policies read and (b) drops to the non-bypass
 * `prodect_app` role for the duration of the transaction. The role switch
 * is what makes RLS actually bite (the default superuser bypasses it). The
 * role reverts when the transaction ends.
 *
 * Local copy of the helper in tests/multi-tenant-rls.test.ts. The two
 * RLS suites each carry their own copy — follow the existing pattern.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('project RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero project rows', async () => {
    await makeProjectTenants();
    const rows = await asAppRole({}, (tx) => tx.project.findMany());
    expect(rows).toEqual([]);
  });

  it("with the workspace-A GUC bound, only A's project is visible — never B's", async () => {
    const fx = await makeProjectTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.project.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.projectAId]);
    expect(ids).not.toContain(fx.projectBId);
  });

  it("tenant A cannot SELECT tenant B's project by id", async () => {
    const fx = await makeProjectTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.project.findMany({ where: { id: fx.projectBId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('project RLS — write isolation', () => {
  it('UPDATE on a project not matching the active workspace GUC affects zero rows (P2025)', async () => {
    const fx = await makeProjectTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.project.update({
          where: { id: fx.projectBId },
          data: { name: 'Hijacked by A' },
        }),
      ),
    ).rejects.toMatchObject({
      // project_active_workspace USING hides B's row from A's UPDATE; the
      // WHERE matches zero rows, which Prisma raises as P2025 — exactly the
      // RLS-denied shape mirrored from multi-tenant-rls.test.ts.
      code: 'P2025',
    });

    // Sanity (as superuser): B's project name is untouched.
    const b = await db.project.findUnique({ where: { id: fx.projectBId } });
    expect(b?.name).toBe('Bravo');
  });

  it('INSERT with a workspaceId not matching the active GUC is denied (42501)', async () => {
    const fx = await makeProjectTenants();
    // project_active_workspace's WITH CHECK requires the new row's
    // workspaceId to equal current_setting('app.workspace_id'). A's GUC
    // is workspace A; attempting to insert into workspace B fails WITH
    // CHECK and Postgres raises insufficient_privilege (42501), which
    // the Prisma pg driver surfaces as a DriverAdapterError whose
    // underlying postgres `cause.code` is the SQLSTATE.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.project.create({
          data: {
            workspaceId: fx.workspaceBId,
            name: 'Smuggled',
            slug: 'smuggled',
            identifier: 'SMUG',
          },
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '42501' },
    });

    // Sanity (as superuser): no smuggled row landed in B's workspace.
    const leaked = await db.project.findFirst({
      where: { workspaceId: fx.workspaceBId, identifier: 'SMUG' },
    });
    expect(leaked).toBeNull();
  });
});

describe('project FK cascade (independent of RLS)', () => {
  // Cascades are FK-level and apply regardless of role, so this runs as
  // the default superuser. The cascade contract — deleting a workspace
  // removes its projects (and, once Story 1.4 lands the WorkItem table,
  // their work items too via the project → work-item FK) — is the
  // structural backstop behind hard workspace deletion. The same
  // invariant is also covered in tests/projects-service.test.ts, but
  // the RLS suite is the durable long-term home for project-table
  // structural invariants going forward.
  //
  // Forward-looking: when Story 1.4 introduces `work_item`, extend this
  // test to assert the work-item rows disappear too. Until then the
  // workspace → project arrow is the only level to exercise.

  it('db.workspace.delete cascades to all projects in the workspace', async () => {
    const owner = await usersService.createUser({
      email: 'project-cascade@example.com',
      password: 'hunter2hunter2',
      name: 'Project Cascade',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Cascade WS',
      ownerUserId: owner.id,
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'P1',
      identifier: 'PONE',
    });
    await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'P2',
      identifier: 'PTWO',
    });
    expect(await db.project.count({ where: { workspaceId: workspace.id } })).toBe(2);

    await db.workspace.delete({ where: { id: workspace.id } });

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.project.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});
