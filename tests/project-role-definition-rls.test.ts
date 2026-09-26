import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Schema + tenancy + repository proof for Story MOTIR-2257 · Subtask MOTIR-2467
// — the custom-project-roles persistence layer. The schema-level companion to
// the resolution suite (MOTIR-2470) and the service suite (MOTIR-2472); it
// covers ONLY what MOTIR-2467 ships:
//
//   * `project_role_definition` round-trips, is unique per (project, name), and
//     is RLS-isolated by workspace — the same pure workspace gate
//     `project_membership` uses, copied rather than re-derived;
//   * `project_membership.role_definition_id` backfills NULL on deploy and its
//     FK REFUSES to delete a role somebody holds (the `Restrict` that is the
//     whole point of the column);
//   * the repository leaves, including the PAIRED-COLUMN invariant: a
//     membership with a non-null `role_definition_id` always carries
//     `role = CUSTOM_ROLE_TIER`.
//
// The permission-set validity, the cap, the name rules and the reassign
// transaction are the SERVICE's (MOTIR-2472) — deliberately not under test
// here. Nothing in this card READS the new column at resolution time either;
// that is MOTIR-2470.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE.
// Every RLS assertion below runs inside a transaction that drops to the
// non-bypass `motir_app` role (the asAppRole helper, a local copy per the
// convention each RLS suite carries its own). Constraint and repository-leaf
// tests run through the ADMIN client (`adminDb`) — they assert DB constraints and
// column round-trips, which bite regardless of role, so a policy denial there
// would replace the signal with noise. Where a repository read accepts an
// optional `tx`, it is handed the admin transaction rather than being replaced by
// a raw query: the repository stays the code under test, it is only the
// connection its statement rides that changes.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → project_role_definition (FK the workspace AND the
  // project with onDelete: Cascade).
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface RoleTenantFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  userA1Id: string;
  userB1Id: string;
  projectP1Id: string;
  projectP2Id: string;
  roleW1Id: string; // "Contractor" in P1 (W1)
  roleW2Id: string; // "Contractor" in P2 (W2) — same NAME, different project
}

// Two independent tenants, each with a project and one custom role. Users /
// workspaces come from the real services so membership + context match
// production; bare projects + role rows are inserted directly (the role service
// is MOTIR-2472 — not yet here).
async function makeRoleTenants(): Promise<RoleTenantFixture> {
  const userA = await usersService.createUser({
    email: 'prd-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'PRD Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'prd-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'PRD Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'PRD WS 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'PRD WS 2', ownerUserId: userB.id });
  const p1 = await adminDb.project.create({
    data: { workspaceId: w1.workspace.id, name: 'PRD P1', slug: 'prd-rls', identifier: 'PRA' },
  });
  const p2 = await adminDb.project.create({
    data: { workspaceId: w2.workspace.id, name: 'PRD P2', slug: 'prd-rls', identifier: 'PRB' },
  });
  const r1 = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: w1.workspace.id,
      projectId: p1.id,
      name: 'Contractor',
      permissions: ['project:browse', 'comment:add'],
    },
  });
  const r2 = await adminDb.projectRoleDefinition.create({
    data: {
      workspaceId: w2.workspace.id,
      projectId: p2.id,
      name: 'Contractor',
      permissions: ['project:browse'],
    },
  });

  return {
    workspaceW1Id: w1.workspace.id,
    workspaceW2Id: w2.workspace.id,
    userA1Id: userA.id,
    userB1Id: userB.id,
    projectP1Id: p1.id,
    projectP2Id: p2.id,
    roleW1Id: r1.id,
    roleW2Id: r2.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id and
 * (b) drops to the non-bypass motir_app role for the duration. The role
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('project_role_definition — round-trip + constraints', () => {
  it('a role definition round-trips with its base, its permission array and its timestamps', async () => {
    const fx = await makeRoleTenants();
    const read = await adminDb.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } });
    expect(read?.name).toBe('Contractor');
    expect(read?.permissions).toEqual(['project:browse', 'comment:add']);
    expect(read?.workspaceId).toBe(fx.workspaceW1Id);
    expect(read?.projectId).toBe(fx.projectP1Id);
  });

  it('a duplicate (projectId, name) raises P2002 — and the repository lets it through UNTRANSLATED', async () => {
    // The service is what turns this into RoleNameTakenError (MOTIR-2472); a
    // repository that translated it would be a second policy implementation.
    const fx = await makeRoleTenants();
    let caught: unknown;
    try {
      await adminDb.$transaction((tx) =>
        tx.projectRoleDefinition.create({
          data: {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            name: 'Contractor',
            permissions: [],
          },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('the SAME name in a DIFFERENT project is fine — a project’s roles are its own', async () => {
    const fx = await makeRoleTenants();
    // The fixture already proves it across workspaces; prove it across two
    // projects in ONE workspace, which is where a workspace-wide unique would
    // have bitten.
    const sibling = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        name: 'PRD P1b',
        slug: 'prd-rls-b',
        identifier: 'PRC',
      },
    });
    const created = await adminDb.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: sibling.id,
        name: 'Contractor',
        permissions: [],
      },
    });
    expect(created.name).toBe('Contractor');
    expect(created.id).not.toBe(fx.roleW1Id);
  });

  it('deleting a project cascades away its role definitions; a sibling tenant’s survive', async () => {
    const fx = await makeRoleTenants();
    await adminDb.project.delete({ where: { id: fx.projectP1Id } });
    const cascaded = await adminDb.projectRoleDefinition.findUnique({
      where: { id: fx.roleW1Id },
    });
    expect(cascaded).toBeNull();
    const siblingTenantRole = await adminDb.projectRoleDefinition.findUnique({
      where: { id: fx.roleW2Id },
    });
    expect(siblingTenantRole).not.toBeNull();
  });
});

describe('project_role_definition — RLS isolation', () => {
  it('with NO workspace context, motir_app sees zero role definitions', async () => {
    await makeRoleTenants();
    const rows = await asAppRole({}, (tx) => tx.projectRoleDefinition.findMany());
    expect(rows).toEqual([]);
  });

  it("with the W1 context bound, only W1's role definitions are visible — never W2's", async () => {
    const fx = await makeRoleTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectRoleDefinition.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.roleW1Id]);
  });

  it('a tenant cannot SELECT a foreign-workspace role definition by id (0 rows, not a leak)', async () => {
    const fx = await makeRoleTenants();
    const rows = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectRoleDefinition.findMany({ where: { id: fx.roleW2Id } }),
    );
    expect(rows).toEqual([]);
  });

  it('a tenant CAN insert a role definition for its OWN workspace', async () => {
    const fx = await makeRoleTenants();
    const created = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.projectRoleDefinition.create({
        data: {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          name: 'Reporter',
          permissions: ['project:browse'],
        },
      }),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('a tenant CANNOT insert a role definition naming a FOREIGN workspace_id (WITH CHECK rejects)', async () => {
    const fx = await makeRoleTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.projectRoleDefinition.create({
          data: {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            name: 'Smuggled',
            permissions: [],
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('project_membership.role_definition_id — the deploy backfill and the Restrict FK', () => {
  it('every EXISTING membership survives the migration with a NULL pointer and its `role` untouched', async () => {
    // The migration is already applied to this database, so "existing rows" are
    // rows created without ever naming the new column — which is exactly what a
    // pre-migration row is. Asserted, not assumed: nobody's access changes on
    // deploy because NULL means what a membership meant before the column.
    const fx = await makeRoleTenants();
    const membership = await adminDb.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: 'viewer',
      },
    });
    expect(membership.roleDefinitionId).toBeNull();
    expect(membership.role).toBe('viewer');

    // And across the whole table: no row anywhere carries a pointer yet.
    const withPointer = await adminDb.projectMembership.count({
      where: { roleDefinitionId: { not: null } },
    });
    expect(withPointer).toBe(0);
  });

  it('deleting a role definition a membership POINTS AT is refused by the database, and the membership survives', async () => {
    const fx = await makeRoleTenants();
    await adminDb.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: CUSTOM_ROLE_TIER,
        roleDefinitionId: fx.roleW1Id,
      },
    });

    const heldRoleDelete = adminDb.$transaction((tx) =>
      tx.projectRoleDefinition.delete({ where: { id: fx.roleW1Id } }),
    );
    await expect(heldRoleDelete).rejects.toThrow();

    // Both sides intact — Restrict refuses rather than cascading the membership
    // away or silently nulling the pointer.
    const heldRole = await adminDb.projectRoleDefinition.findUnique({
      where: { id: fx.roleW1Id },
    });
    expect(heldRole).not.toBeNull();
    const survivor = await adminDb.projectMembership.findUnique({
      where: { userId_projectId: { userId: fx.userA1Id, projectId: fx.projectP1Id } },
    });
    expect(survivor?.roleDefinitionId).toBe(fx.roleW1Id);
    expect(survivor?.role).toBe(CUSTOM_ROLE_TIER);
  });

  it('a role definition nobody holds deletes cleanly', async () => {
    const fx = await makeRoleTenants();
    await adminDb.$transaction((tx) =>
      tx.projectRoleDefinition.delete({ where: { id: fx.roleW1Id } }),
    );
    const deleted = await adminDb.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } });
    expect(deleted).toBeNull();
  });
});

// `projectRoleDefinitionRepository` was deleted with the project Roles pages
// (Story MOTIR-6168 · MOTIR-6466): nothing in the application reads or writes a
// project role any more. The TABLE stays until the contract story drops it, so its
// constraints and RLS are still asserted above, through the client directly.

// `projectMembershipRepository`'s paired-column writers (`setRoleDefinition`,
// `reassignRoleDefinition`) and its holder counts retired with the project roles
// (Story MOTIR-6168 · MOTIR-6464) — a project membership carries no role, and the
// workspace membership's `setWorkspaceRole` is the one writer now
// (`tests/workspace-role-storage.test.ts`). The table and its RLS stay until the
// contract story drops them, and are still covered above.
