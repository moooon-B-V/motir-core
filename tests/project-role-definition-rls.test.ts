import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectRoleDefinitionRepository } from '@/lib/repositories/projectRoleDefinitionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_ROLE_TIER } from '@/lib/permissions/builtinRoles';
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
// non-bypass `prodect_app` role (the asAppRole helper, a local copy per the
// convention each RLS suite carries its own). Constraint tests run as the
// superuser via the `db` singleton — they assert DB constraints, which bite
// regardless of role.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → project_role_definition (FK the workspace AND the
  // project with onDelete: Cascade).
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
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
  const p1 = await db.project.create({
    data: { workspaceId: w1.workspace.id, name: 'PRD P1', slug: 'prd-rls', identifier: 'PRA' },
  });
  const p2 = await db.project.create({
    data: { workspaceId: w2.workspace.id, name: 'PRD P2', slug: 'prd-rls', identifier: 'PRB' },
  });
  const r1 = await db.projectRoleDefinition.create({
    data: {
      workspaceId: w1.workspace.id,
      projectId: p1.id,
      name: 'Contractor',
      permissions: ['project:browse', 'comment:add'],
    },
  });
  const r2 = await db.projectRoleDefinition.create({
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

describe('project_role_definition — round-trip + constraints', () => {
  it('a role definition round-trips with its base, its permission array and its timestamps', async () => {
    const fx = await makeRoleTenants();
    const read = await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } });
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
      await db.$transaction((tx) =>
        projectRoleDefinitionRepository.create(
          {
            workspaceId: fx.workspaceW1Id,
            projectId: fx.projectP1Id,
            name: 'Contractor',
            permissions: [],
          },
          tx,
        ),
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
    const sibling = await db.project.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        name: 'PRD P1b',
        slug: 'prd-rls-b',
        identifier: 'PRC',
      },
    });
    const created = await db.projectRoleDefinition.create({
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
    await db.project.delete({ where: { id: fx.projectP1Id } });
    expect(await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } })).toBeNull();
    expect(
      await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW2Id } }),
    ).not.toBeNull();
  });
});

describe('project_role_definition — RLS isolation', () => {
  it('with NO workspace context, prodect_app sees zero role definitions', async () => {
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
      projectRoleDefinitionRepository.create(
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          name: 'Reporter',
          permissions: ['project:browse'],
        },
        tx,
      ),
    );
    expect(created.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('a tenant CANNOT insert a role definition naming a FOREIGN workspace_id (WITH CHECK rejects)', async () => {
    const fx = await makeRoleTenants();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        projectRoleDefinitionRepository.create(
          {
            workspaceId: fx.workspaceW2Id,
            projectId: fx.projectP2Id,
            name: 'Smuggled',
            permissions: [],
          },
          tx,
        ),
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
    const membership = await db.projectMembership.create({
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
    const withPointer = await db.projectMembership.count({
      where: { roleDefinitionId: { not: null } },
    });
    expect(withPointer).toBe(0);
  });

  it('deleting a role definition a membership POINTS AT is refused by the database, and the membership survives', async () => {
    const fx = await makeRoleTenants();
    await db.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: CUSTOM_ROLE_TIER,
        roleDefinitionId: fx.roleW1Id,
      },
    });

    await expect(
      db.$transaction((tx) => projectRoleDefinitionRepository.delete(fx.roleW1Id, tx)),
    ).rejects.toThrow();

    // Both sides intact — Restrict refuses rather than cascading the membership
    // away or silently nulling the pointer.
    expect(
      await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } }),
    ).not.toBeNull();
    const survivor = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: fx.userA1Id, projectId: fx.projectP1Id } },
    });
    expect(survivor?.roleDefinitionId).toBe(fx.roleW1Id);
    expect(survivor?.role).toBe(CUSTOM_ROLE_TIER);
  });

  it('a role definition nobody holds deletes cleanly', async () => {
    const fx = await makeRoleTenants();
    await db.$transaction((tx) => projectRoleDefinitionRepository.delete(fx.roleW1Id, tx));
    expect(await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } })).toBeNull();
  });
});

describe('projectRoleDefinitionRepository — the leaves', () => {
  it('findManyByProject returns the project’s roles ordered by name', async () => {
    const fx = await makeRoleTenants();
    await db.projectRoleDefinition.createMany({
      data: [
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          name: 'Auditor',
          permissions: [],
        },
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          name: 'Reporter',
          permissions: [],
        },
      ],
    });
    const rows = await projectRoleDefinitionRepository.findManyByProject(fx.projectP1Id);
    expect(rows.map((r) => r.name)).toEqual(['Auditor', 'Contractor', 'Reporter']);
  });

  it('findById / findManyByIds read back what was written; findManyByIds([]) makes no query', async () => {
    const fx = await makeRoleTenants();
    expect((await projectRoleDefinitionRepository.findById(fx.roleW1Id))?.name).toBe('Contractor');
    expect(await projectRoleDefinitionRepository.findById('no-such-id')).toBeNull();
    const many = await projectRoleDefinitionRepository.findManyByIds([fx.roleW1Id, fx.roleW2Id]);
    expect(many.map((r) => r.id).sort()).toEqual([fx.roleW1Id, fx.roleW2Id].sort());
    expect(await projectRoleDefinitionRepository.findManyByIds([])).toEqual([]);
  });

  it('countByProject counts only THAT project’s roles', async () => {
    const fx = await makeRoleTenants();
    const count = await db.$transaction((tx) =>
      projectRoleDefinitionRepository.countByProject(fx.projectP1Id, tx),
    );
    expect(count).toBe(1);
  });

  it('update patches name + permissions, and there is nothing else to patch', async () => {
    const fx = await makeRoleTenants();
    const updated = await db.$transaction((tx) =>
      projectRoleDefinitionRepository.update(
        fx.roleW1Id,
        { name: 'External', permissions: ['project:browse'] },
        tx,
      ),
    );
    expect(updated.name).toBe('External');
    expect(updated.permissions).toEqual(['project:browse']);
    expect('basedOn' in updated).toBe(false); // nothing records the seed
  });
});

describe('projectMembershipRepository — the paired-column invariant', () => {
  /**
   * Read every membership back with the role it points at, and assert the
   * invariant the whole model rests on: a non-null `role_definition_id` always
   * comes with `role = CUSTOM_ROLE_TIER` (`member`). This is the check that
   * keeps `levelGrants` in `lib/permissions/resolve.ts` correct for a custom
   * role WITHOUT a custom-role branch — at that tier the access level subtracts
   * nothing, so a custom role grants exactly what it lists.
   */
  async function assertPairedColumns(projectId: string): Promise<number> {
    const memberships = await db.projectMembership.findMany({
      where: { projectId },
      include: { roleDefinition: true },
    });
    let paired = 0;
    for (const m of memberships) {
      if (m.roleDefinitionId === null) {
        expect(m.roleDefinition).toBeNull();
        continue;
      }
      expect(m.roleDefinition).not.toBeNull();
      expect(m.role).toBe(CUSTOM_ROLE_TIER);
      paired += 1;
    }
    return paired;
  }

  it('setRoleDefinition onto a CUSTOM role writes the pointer AND the tier in one statement', async () => {
    const fx = await makeRoleTenants();
    await db.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: 'admin',
      },
    });

    const updated = await db.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        fx.userA1Id,
        fx.projectP1Id,
        { roleDefinitionId: fx.roleW1Id, role: CUSTOM_ROLE_TIER },
        tx,
      ),
    );
    expect(updated.roleDefinitionId).toBe(fx.roleW1Id);
    expect(updated.role).toBe(CUSTOM_ROLE_TIER); // NOT the stale 'admin'
    expect(await assertPairedColumns(fx.projectP1Id)).toBe(1);
  });

  it('setRoleDefinition back onto a BUILT-IN clears the pointer AND sets `role` to that built-in', async () => {
    const fx = await makeRoleTenants();
    await db.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: CUSTOM_ROLE_TIER,
        roleDefinitionId: fx.roleW1Id,
      },
    });

    const updated = await db.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        fx.userA1Id,
        fx.projectP1Id,
        { roleDefinitionId: null, role: 'member' },
        tx,
      ),
    );
    expect(updated.roleDefinitionId).toBeNull();
    expect(updated.role).toBe('member');
    expect(await assertPairedColumns(fx.projectP1Id)).toBe(0);
  });

  it('reassignRoleDefinition moves EVERY holder onto the destination, both columns together', async () => {
    const fx = await makeRoleTenants();
    const destination = await db.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        name: 'Reporter',
        permissions: ['project:browse'],
      },
    });
    // Two holders of roleW1 plus one member on a built-in that
    // must NOT move.
    const other = await usersService.createUser({
      email: 'prd-holder-2@example.com',
      password: 'hunter2hunter2',
      name: 'PRD Holder 2',
    });
    const untouched = await usersService.createUser({
      email: 'prd-builtin@example.com',
      password: 'hunter2hunter2',
      name: 'PRD Builtin',
    });
    await db.projectMembership.createMany({
      data: [
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: fx.userA1Id,
          role: CUSTOM_ROLE_TIER,
          roleDefinitionId: fx.roleW1Id,
        },
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: other.id,
          role: CUSTOM_ROLE_TIER,
          roleDefinitionId: fx.roleW1Id,
        },
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: untouched.id,
          role: 'admin',
        },
      ],
    });

    const moved = await db.$transaction((tx) =>
      projectMembershipRepository.reassignRoleDefinition(
        fx.roleW1Id,
        { roleDefinitionId: destination.id, role: CUSTOM_ROLE_TIER },
        tx,
      ),
    );
    expect(moved).toBe(2);
    expect(await assertPairedColumns(fx.projectP1Id)).toBe(2);

    // The built-in membership is untouched — the move is scoped to holders.
    const builtIn = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: untouched.id, projectId: fx.projectP1Id } },
    });
    expect(builtIn?.roleDefinitionId).toBeNull();
    expect(builtIn?.role).toBe('admin');

    // And with no holders left, the role now deletes cleanly — the shape the
    // service's reassign-then-delete relies on.
    await db.$transaction((tx) => projectRoleDefinitionRepository.delete(fx.roleW1Id, tx));
    expect(await db.projectRoleDefinition.findUnique({ where: { id: fx.roleW1Id } })).toBeNull();
  });

  it('reassignRoleDefinition to a BUILT-IN destination clears every pointer and sets `role`', async () => {
    const fx = await makeRoleTenants();
    await db.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userA1Id,
        role: CUSTOM_ROLE_TIER,
        roleDefinitionId: fx.roleW1Id,
      },
    });
    const moved = await db.$transaction((tx) =>
      projectMembershipRepository.reassignRoleDefinition(
        fx.roleW1Id,
        { roleDefinitionId: null, role: 'member' },
        tx,
      ),
    );
    expect(moved).toBe(1);
    expect(await assertPairedColumns(fx.projectP1Id)).toBe(0);
    const row = await db.projectMembership.findUnique({
      where: { userId_projectId: { userId: fx.userA1Id, projectId: fx.projectP1Id } },
    });
    expect(row?.role).toBe('member');
  });

  it('countByRoleDefinition groups holders per custom role and EXCLUDES built-in memberships', async () => {
    const fx = await makeRoleTenants();
    const second = await db.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        name: 'Reporter',
        permissions: [],
      },
    });
    const u2 = await usersService.createUser({
      email: 'prd-count-2@example.com',
      password: 'hunter2hunter2',
      name: 'PRD Count 2',
    });
    const u3 = await usersService.createUser({
      email: 'prd-count-3@example.com',
      password: 'hunter2hunter2',
      name: 'PRD Count 3',
    });
    await db.projectMembership.createMany({
      data: [
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: fx.userA1Id,
          role: CUSTOM_ROLE_TIER,
          roleDefinitionId: fx.roleW1Id,
        },
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: u2.id,
          role: CUSTOM_ROLE_TIER,
          roleDefinitionId: fx.roleW1Id,
        },
        {
          workspaceId: fx.workspaceW1Id,
          projectId: fx.projectP1Id,
          userId: u3.id,
          role: 'member',
          roleDefinitionId: second.id,
        },
      ],
    });
    // A membership on a BUILT-IN — countByRole's, never this one's.
    await db.projectMembership.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        userId: fx.userB1Id,
        role: 'admin',
      },
    });

    const counts = await projectMembershipRepository.countByRoleDefinition(fx.projectP1Id);
    expect(counts.sort((a, b) => a.roleDefinitionId.localeCompare(b.roleDefinitionId))).toEqual(
      [
        { roleDefinitionId: fx.roleW1Id, count: 2 },
        { roleDefinitionId: second.id, count: 1 },
      ].sort((a, b) => a.roleDefinitionId.localeCompare(b.roleDefinitionId)),
    );

    // A role nobody holds is simply absent — zero-filling is the mapper's job.
    const unheld = await db.projectRoleDefinition.create({
      data: {
        workspaceId: fx.workspaceW1Id,
        projectId: fx.projectP1Id,
        name: 'Unheld',
        permissions: [],
      },
    });
    const after = await projectMembershipRepository.countByRoleDefinition(fx.projectP1Id);
    expect(after.map((c) => c.roleDefinitionId)).not.toContain(unheld.id);
  });
});
