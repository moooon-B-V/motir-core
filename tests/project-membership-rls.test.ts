import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from './helpers/db';

// Schema + tenancy proof for Story 6.4 · Subtask 6.4.2 — the project-access
// data model. This is the schema-level companion to the future enforcement
// suite (6.4.8); it covers ONLY what 6.4.2 ships:
//   * `project.accessLevel` defaults to `open` (the no-lockout backfill);
//   * `workspace_membership.role` is now the `member_role` enum, and the
//     founder mapping (owner) round-trips as a value;
//   * `project_membership` round-trips + is RLS-isolated by workspace
//     (the same pure workspace gate `workflow_status` / `project` use);
//   * the `[userId, projectId]` uniqueness + the FK cascade on project delete.
//
// The browse/edit POLICY (canBrowse/canEdit per access level × role) is 6.4.3 —
// NOT under test here.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE.
// Every RLS assertion below runs inside a transaction that drops to the
// non-bypass `prodect_app` role (the asAppRole helper, a local copy per the
// convention each RLS suite carries its own); it binds the same app.workspace_id
// GUC withWorkspaceContext binds, then reverts at txn end. Constraint tests
// (uniqueness, cascade, defaults) run as the superuser via the `db` singleton —
// they assert DB constraints, which bite regardless of role.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → project_membership (all FK the workspace with
  // onDelete: Cascade), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface MembershipTenantFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  userA1Id: string; // member of W1
  userB1Id: string; // member of W2
  projectP1Id: string; // in W1
  projectP2Id: string; // in W2
  membershipW1Id: string; // userA1 on P1 (W1)
  membershipW2Id: string; // userB1 on P2 (W2)
}

// Two independent tenants, each with a project and one project membership.
// Users / workspaces are built via the real services so membership + context
// match production; bare projects + memberships are inserted directly (the
// membership service is 6.4.4 — not yet here).
async function makeMembershipTenants(): Promise<MembershipTenantFixture> {
  const userA = await usersService.createUser({
    email: 'pm-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'PM Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'pm-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'PM Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'PM WS 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'PM WS 2', ownerUserId: userB.id });
  // BARE projects (db insert, NOT projectsService.createProject) so the
  // auto-seeded default workflow/board don't clutter the fixture — this suite
  // controls the exact rows under test.
  const p1 = await db.project.create({
    data: { workspaceId: w1.workspace.id, name: 'PM P1', slug: 'pm-rls', identifier: 'PMR' },
  });
  const p2 = await db.project.create({
    data: { workspaceId: w2.workspace.id, name: 'PM P2', slug: 'pm-rls', identifier: 'PMR' },
  });
  const m1 = await db.projectMembership.create({
    data: { workspaceId: w1.workspace.id, projectId: p1.id, userId: userA.id, role: 'admin' },
  });
  const m2 = await db.projectMembership.create({
    data: { workspaceId: w2.workspace.id, projectId: p2.id, userId: userB.id, role: 'member' },
  });

  return {
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    userA1Id: userA.id,
    userB1Id: userB.id,
    projectP1Id: p1.id,
    projectP2Id: p2.id,
    membershipW1Id: m1.id,
    membershipW2Id: m2.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id and
 * (b) drops to the non-bypass prodect_app role for the duration. The role
 * switch is what makes RLS bite; it reverts at txn end.
 */
async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('project.accessLevel — default', () => {
  it('a project created without an explicit accessLevel defaults to `open` (no-lockout backfill)', async () => {
    const user = await usersService.createUser({
      email: 'pm-default@example.com',
      password: 'hunter2hunter2',
      name: 'PM Default',
    });
    const ws = await workspacesService.createWorkspace({
      name: 'PM Default WS',
      ownerUserId: user.id,
    });
    const project = await db.project.create({
      data: { workspaceId: ws.workspace.id, name: 'Defaulted', slug: 'def', identifier: 'DEF' },
    });
    expect(project.accessLevel).toBe('open');
  });

  it('accessLevel accepts the full Jira-mirrored set (open / limited / private)', async () => {
    const user = await usersService.createUser({
      email: 'pm-levels@example.com',
      password: 'hunter2hunter2',
      name: 'PM Levels',
    });
    const ws = await workspacesService.createWorkspace({
      name: 'PM Levels WS',
      ownerUserId: user.id,
    });
    const priv = await db.project.create({
      data: {
        workspaceId: ws.workspace.id,
        name: 'Private',
        slug: 'priv',
        identifier: 'PRV',
        accessLevel: 'private',
      },
    });
    expect(priv.accessLevel).toBe('private');
    const updated = await db.project.update({
      where: { id: priv.id },
      data: { accessLevel: 'limited' },
    });
    expect(updated.accessLevel).toBe('limited');
  });
});

describe('workspace_membership.role — member_role enum', () => {
  it('the workspace founder is seeded with the `owner` role (the migration-aware mapping, value-level)', async () => {
    const user = await usersService.createUser({
      email: 'pm-owner@example.com',
      password: 'hunter2hunter2',
      name: 'PM Owner',
    });
    const ws = await workspacesService.createWorkspace({
      name: 'PM Owner WS',
      ownerUserId: user.id,
    });
    const membership = await db.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: ws.workspace.id } },
    });
    expect(membership?.role).toBe('owner');
  });
});

describe('project_membership — round-trip + role default', () => {
  it('a project membership round-trips, defaulting role to `member`', async () => {
    const user = await usersService.createUser({
      email: 'pm-roundtrip@example.com',
      password: 'hunter2hunter2',
      name: 'PM Roundtrip',
    });
    const ws = await workspacesService.createWorkspace({
      name: 'PM Roundtrip WS',
      ownerUserId: user.id,
    });
    const project = await db.project.create({
      data: { workspaceId: ws.workspace.id, name: 'RT', slug: 'rt', identifier: 'RTP' },
    });
    const created = await db.projectMembership.create({
      data: { workspaceId: ws.workspace.id, projectId: project.id, userId: user.id },
    });
    expect(created.role).toBe('member'); // column default
    const read = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: user.id, projectId: project.id } },
    });
    expect(read?.id).toBe(created.id);
  });
});

describe('project_membership — RLS read isolation', () => {
  it('with NO context, prodect_app sees zero project_membership rows', async () => {
    await makeMembershipTenants();
    const rows = await asAppRole({}, (tx) => tx.projectMembership.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context bound, only W1's memberships are visible — never W2's", async () => {
    const fx = await makeMembershipTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectMembership.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.membershipW1Id]);
    expect(ids).not.toContain(fx.membershipW2Id);
  });

  it('a tenant cannot SELECT a foreign-workspace membership (cross-workspace read returns 0 rows)', async () => {
    const fx = await makeMembershipTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectMembership.findMany({ where: { id: fx.membershipW2Id } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('project_membership — RLS write isolation (WITH CHECK)', () => {
  it('a tenant can INSERT a membership for its OWN workspace', async () => {
    const fx = await makeMembershipTenants();
    // userB1 is a foreign user, but they are added to W1's project P1 under the
    // W1 context — the row's workspace_id is W1, so WITH CHECK admits it.
    const created = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectMembership.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: fx.userB1Id,
          role: 'viewer',
        },
      }),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
    expect(created.role).toBe('viewer');
  });

  it('a tenant CANNOT INSERT a membership carrying a FOREIGN workspaceId (WITH CHECK rejects)', async () => {
    const fx = await makeMembershipTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.projectMembership.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            userId: fx.userA1Id,
            role: 'member',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('project_membership — constraints', () => {
  it('duplicate (userId, projectId) is rejected', async () => {
    const fx = await makeMembershipTenants();
    // fx already added userA1 to P1.
    await expect(
      db.projectMembership.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: fx.userA1Id,
          role: 'member',
        },
      }),
    ).rejects.toThrow();
  });

  it('deleting a project cascades away its memberships', async () => {
    const fx = await makeMembershipTenants();
    await db.project.delete({ where: { id: fx.projectP1Id } });
    const remaining = await db.projectMembership.findMany({
      where: { projectId: fx.projectP1Id },
    });
    expect(remaining).toEqual([]);
    // W2's membership is untouched.
    const w2 = await db.projectMembership.findUnique({ where: { id: fx.membershipW2Id } });
    expect(w2?.id).toBe(fx.membershipW2Id);
  });

  it('deleting a user cascades away their project memberships', async () => {
    const fx = await makeMembershipTenants();
    await db.user.delete({ where: { id: fx.userA1Id } });
    const remaining = await db.projectMembership.findMany({ where: { userId: fx.userA1Id } });
    expect(remaining).toEqual([]);
  });
});
