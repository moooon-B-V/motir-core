import {
  type MemberRole,
  Prisma,
  type ProjectMembership,
  type ProjectRoleDefinition,
  type User,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';

// A project-membership row joined with the slice of its user the members list
// renders. Kept here (not in the service) because the join shape is a
// data-access concern; the service maps it to a DTO. Mirrors
// `MembershipWithUser` on workspaceMembershipRepository.
//
// ⚠️ IT ALSO CARRIES THE CUSTOM ROLE (MOTIR-2485), and it has to. A membership's
// `role` column is a TIER, and for a member on a custom role that tier is always
// `CUSTOM_ROLE_TIER` (`member`) — so a members list built from `role` alone would
// draw every custom-role holder as a Member and be silently WRONG about the one
// thing the row is there to say. The name is joined in the SAME query rather than
// looked up per row: the list read is one round trip, and it stays one.
export type ProjectMembershipWithUser = ProjectMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
  /** The custom role this membership points at, or null when it names a built-in. */
  roleDefinition: Pick<ProjectRoleDefinition, 'id' | 'name'> | null;
};

// A membership joined with the CUSTOM role it points at, if any (Story
// MOTIR-2257 · MOTIR-2470). `roleDefinition` is null for every membership that
// names a built-in through `role`. The resolution reads this shape so the
// membership and its permission set arrive in one round trip.
export type ProjectMembershipWithRoleDefinition = ProjectMembership & {
  roleDefinition: ProjectRoleDefinition | null;
};

// ProjectMembership repository — single Prisma operations on the
// `project_membership` join table (Story 6.4). Owns its own file (not nested
// under projectRepository) because the primary entity is ProjectMembership,
// not Project. Writes require `tx`; reads that guard a write inside a
// transaction also take `tx` so the project_membership RLS policy (which keys
// off the per-transaction `app.workspace_id` GUC bound by withWorkspaceContext)
// admits the rows under the non-bypass motir_app role.

export const projectMembershipRepository = {
  /**
   * The user's membership in a specific project, or null. Optionally takes
   * `tx` when the caller is inside a withWorkspaceContext transaction — required
   * under the non-bypass motir_app role so the RLS policy's workspace GUC is
   * bound (outside it the policy hides every row). Used by the project-admin
   * gate and the role/remove guards.
   */
  async findByUserAndProject(
    userId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectMembership | null> {
    const client = tx ?? db;
    return client.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
    });
  },

  /**
   * The user's membership in a project WITH the custom role it points at, in
   * ONE query (Story MOTIR-2257 · Subtask MOTIR-2470). The read behind
   * `projectAccessService.resolveInputs`: a `findUnique` with an `include` is a
   * single Prisma operation and a single round trip, so a caller inside a
   * transaction gets the membership and its role definition on ONE snapshot,
   * under ONE binding of the `app.workspace_id` GUC that both tables' RLS
   * policies read.
   *
   * `roleDefinition` is null when the membership names a BUILT-IN through
   * `role` — which is every membership until somebody authors a role.
   */
  async findByUserAndProjectWithRoleDefinition(
    userId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectMembershipWithRoleDefinition | null> {
    const client = tx ?? db;
    return client.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: { roleDefinition: true },
    });
  },

  /**
   * The user's memberships across a SET of projects, in one query — backs the
   * browsable-projects filter (Subtask 6.4.6), which decides `canBrowse` over a
   * whole workspace's projects without an N+1 per-project round-trip. Optionally
   * takes `tx` for the same RLS-GUC reason as `findByUserAndProject`. Returns
   * only the rows that exist (a project the user has no membership in is simply
   * absent — the caller treats that as `projectRole = null`).
   */
  async findByUserAndProjects(
    userId: string,
    projectIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectMembership[]> {
    if (projectIds.length === 0) return [];
    const client = tx ?? db;
    return client.projectMembership.findMany({
      where: { userId, projectId: { in: projectIds } },
    });
  },

  /**
   * One membership joined with its user slice, inside the caller's transaction.
   * Used to build the `ProjectMemberDTO` returned by add/set-role without a
   * second round-trip. Same RLS-GUC requirement as findMembersByProject.
   */
  async findByUserAndProjectWithUser(
    userId: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembershipWithUser | null> {
    return tx.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        roleDefinition: { select: { id: true, name: true } },
      },
    });
  },

  /**
   * Members of a project joined with the user fields the Members panel renders,
   * ordered by createdAt asc (the first-added member lands first). Takes `tx`
   * because the project_membership RLS policy reads the per-transaction
   * workspace GUC — outside the transaction the policy returns zero rows under
   * the non-bypass app role.
   */
  async findMembersByProject(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembershipWithUser[]> {
    return tx.projectMembership.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        roleDefinition: { select: { id: true, name: true } },
      },
    });
  },

  /**
   * Count the project's admin memberships inside the caller's transaction.
   * Backs the last-admin guard on remove / set-role: the count and the
   * subsequent write run in one transaction so two concurrent removals can't
   * both observe count > 1 and strand the project with zero admins.
   */
  async countAdmins(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.projectMembership.count({ where: { projectId, role: 'admin' } });
  },

  /**
   * How many of the project's members hold each role — ONE grouped read, not one
   * count per role (Subtask MOTIR-2439). Backs the `3 members` the Roles &
   * permissions list row draws beside every role. Only roles with at least one
   * member come back; zero-filling belongs to the mapper, which knows the full
   * role set. Optionally takes `tx` for the same RLS-GUC reason as
   * `findByUserAndProject` — the project_membership policy keys off the
   * per-transaction `app.workspace_id` GUC, so outside a `withWorkspaceContext`
   * transaction the non-bypass role sees zero rows.
   */
  async countByRole(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ role: MemberRole; count: number }[]> {
    const client = tx ?? db;
    const groups = await client.projectMembership.groupBy({
      by: ['role'],
      where: { projectId },
      _count: { _all: true },
    });
    return groups.map((group) => ({ role: group.role, count: group._count._all }));
  },

  /**
   * How many of the project's members hold each CUSTOM role — one grouped read
   * over `role_definition_id`, the custom-role counterpart of `countByRole`
   * (Story MOTIR-2257 · MOTIR-2467). Two grouped reads together cover the whole
   * catalog for MOTIR-2478's list, never one query per role.
   *
   * Rows with a NULL pointer (every membership on a built-in) are excluded —
   * they are `countByRole`'s. Only definitions with at least one holder come
   * back; zero-filling belongs to the mapper, which knows the full role set.
   *
   * Also the pre-check for `delete`: the service calls it inside the deleting
   * transaction to learn the affected count before it refuses (the number the
   * `RoleInUseError` and the confirmation dialog carry).
   */
  async countByRoleDefinition(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ roleDefinitionId: string; count: number }[]> {
    const client = tx ?? db;
    const groups = await client.projectMembership.groupBy({
      by: ['roleDefinitionId'],
      where: { projectId, roleDefinitionId: { not: null } },
      _count: { _all: true },
    });
    return groups
      .filter((group): group is typeof group & { roleDefinitionId: string } =>
        Boolean(group.roleDefinitionId),
      )
      .map((group) => ({ roleDefinitionId: group.roleDefinitionId, count: group._count._all }));
  },

  // ─────────────────────────────────────────────────────────────────────────
  // THE PAIRED-COLUMN WRITERS (Story MOTIR-2257 · Subtask MOTIR-2467)
  //
  // ⚠️ `role` and `roleDefinitionId` MOVE TOGETHER, and these two methods are
  // the ONLY write paths for `role_definition_id` in the codebase. Neither
  // column is writable alone:
  //
  //   * `role` keeps deciding which built-in TIER a membership sits at — that
  //     is what `levelGrants` in `lib/permissions/resolve.ts` subtracts from on
  //     a `limited` / `private` project;
  //   * `roleDefinitionId` decides WHAT that tier grants.
  //
  // So a membership on a custom role carries `role = CUSTOM_ROLE_TIER`
  // (`member`), never a stale leftover value — which is why `resolve.ts` needs
  // no custom-role branch in `levelGrants` at all, and why the access level
  // takes NOTHING away from a custom role: it grants exactly what it lists.
  // Writing one column without the other is what would break that, and the only
  // way to do it is to add a third writer. Don't.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Put one membership on a role — custom or built-in — writing BOTH columns in
   * the SAME statement.
   *
   *   * a CUSTOM role: pass its id and `CUSTOM_ROLE_TIER`; the pointer is set
   *     and `role` becomes that tier;
   *   * a BUILT-IN role: pass `roleDefinitionId: null` and the built-in; the
   *     pointer is cleared and `role` becomes it.
   *
   * Targets the (userId, projectId) unique. Throws P2025 if no such membership
   * exists — the service reads the membership first inside the same tx, so this
   * is belt + suspenders.
   */
  async setRoleDefinition(
    userId: string,
    projectId: string,
    assignment: { roleDefinitionId: string | null; role: MemberRole },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembership> {
    return tx.projectMembership.update({
      where: { userId_projectId: { userId, projectId } },
      data: { roleDefinitionId: assignment.roleDefinitionId, role: assignment.role },
    });
  },

  /**
   * Move EVERY membership currently on `fromRoleDefinitionId` onto a
   * destination, writing both columns in the same statement — the bulk half of
   * the delete-with-reassign, run inside the service's one transaction so the
   * move and the delete can never half-happen.
   *
   * The destination is another custom role (`{ roleDefinitionId, role:
   * CUSTOM_ROLE_TIER }`) or a built-in (`{ roleDefinitionId: null, role: the
   * built-in }`).
   * Returns the number of memberships moved.
   */
  async reassignRoleDefinition(
    fromRoleDefinitionId: string,
    destination: { roleDefinitionId: string | null; role: MemberRole },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.projectMembership.updateMany({
      where: { roleDefinitionId: fromRoleDefinitionId },
      data: { roleDefinitionId: destination.roleDefinitionId, role: destination.role },
    });
    return result.count;
  },

  async create(
    data: { workspaceId: string; projectId: string; userId: string; role: MemberRole },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembership> {
    return tx.projectMembership.create({ data });
  },

  /**
   * Bulk-insert memberships, skipping any (userId, projectId) that already
   * exists. Backs the go-private seeding: when a project flips to `private` we
   * enroll every current workspace member as a `member`, but rows that already
   * exist (e.g. an admin) keep their role untouched. Returns the count created.
   */
  async createManySkipDuplicates(
    data: Array<{ workspaceId: string; projectId: string; userId: string; role: MemberRole }>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const result = await tx.projectMembership.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  // ⚠️ `updateRole` USED TO LIVE HERE AND WAS DELETED BY MOTIR-2485, deliberately.
  // It wrote `role` and left `role_definition_id` alone — which was harmless
  // while the pointer did not exist, and became a live bug the moment it did: a
  // member on a custom role "demoted" to `viewer` through it would keep the
  // pointer, so the resolution would go on handing them their custom role's
  // permissions while every screen said Viewer. `setRoleDefinition` is the
  // replacement and writes BOTH columns; its only cost is that a caller must say
  // what happens to the pointer, which is exactly the thing that must not be
  // forgotten. Do not reintroduce a single-column writer.

  /**
   * Delete a membership, returning the deleted row or null when no matching
   * row existed (treats "already gone" as an idempotent no-op, mirroring
   * workspaceMembershipRepository.deleteByUserAndWorkspace).
   */
  async deleteByUserAndProject(
    userId: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembership | null> {
    try {
      return await tx.projectMembership.delete({
        where: { userId_projectId: { userId, projectId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },
};
