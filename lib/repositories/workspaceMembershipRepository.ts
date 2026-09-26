import {
  type MemberRole,
  Prisma,
  type User,
  type Workspace,
  type WorkspaceMembership,
  type WorkspaceRole,
  type WorkspaceRoleDefinition,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// A membership row joined with the slice of its user the members list
// renders. Kept here (not in the service) because the join shape is a
// data-access concern; the service maps it to a DTO.
export type MembershipWithUser = WorkspaceMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

/** A membership with the workspace CUSTOM role it points at (or null for a built-in). */
export type MembershipWithRoleDefinition = WorkspaceMembership & {
  roleDefinition: WorkspaceRoleDefinition | null;
};

// WorkspaceMembership repository — single Prisma operations on the
// `workspace_membership` join table. Owns its own file (not nested under
// workspaceRepository) because the primary entity it operates on is
// WorkspaceMembership, not Workspace.

export const workspaceMembershipRepository = {
  /**
   * Same lookup as findByUserAndWorkspace, but inside the caller's
   * transaction so the membership_visible RLS policy (which keys off the
   * per-transaction app.user_id / app.workspace_id GUCs) admits the row under
   * the non-bypass motir_app role. Used by role-gated reads that MUST be
   * correct in production (e.g. workspacesService.getMemberRole → the 1.6.5
   * replay gate); the db-singleton variant above returns NULL under RLS when
   * no context is bound.
   */
  async findByUserAndWorkspaceInTx(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership | null> {
    return tx.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
  },

  /**
   * The membership WITH the workspace custom role it points at, in ONE round
   * trip (Story MOTIR-6168 · MOTIR-6457). The resolver (MOTIR-6459) needs both —
   * the role tier and, for a custom role, its stored key set — for every
   * permission check, so reading them apart would double the reads on the
   * hottest path in the product. Requires `tx`: both tables are RLS-gated.
   */
  async findByUserAndWorkspaceWithRoleDefinition(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MembershipWithRoleDefinition | null> {
    return tx.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      include: { roleDefinition: true },
    });
  },

  /**
   * Write a member's WORKSPACE ROLE — `workspace_role` and `role_definition_id`
   * together, in ONE statement (MOTIR-6457). THE ONLY WRITER of the two columns:
   * they move together (a custom role is `CUSTOM_WORKSPACE_ROLE_TIER` + its
   * pointer; a built-in is its value + NULL), and a second writer is how they
   * come apart. Which pairs are legal is the service's call; this writes what it
   * is given. Targets the row by the `(userId, workspaceId)` unique.
   */
  async setWorkspaceRole(
    userId: string,
    workspaceId: string,
    role: { workspaceRole: WorkspaceRole; roleDefinitionId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership> {
    return tx.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { workspaceRole: role.workspaceRole, roleDefinitionId: role.roleDefinitionId },
    });
  },

  /**
   * How many members of the workspace hold the MANAGER role — `workspace_role =
   * 'manager'` rows only; a NULL (not-yet-migrated) row is not counted, because
   * the mapping (MOTIR-6458) runs before any reader of this (MOTIR-6463).
   *
   * LOCKS those rows `FOR UPDATE`, because its reader is the last-Manager guard:
   * a count-then-write that, unlocked, lets two concurrent demotions of a
   * two-Manager workspace both read `2` and both commit, leaving none — the same
   * race `countByWorkspaceForUpdate` closes for the last-member guard. `ORDER BY
   * "id"` pins the lock order; Postgres forbids `count(*) … FOR UPDATE`, so the
   * ids are selected under the lock and counted here. `tx` is REQUIRED — the
   * lock lives only for its transaction, and the RLS policy needs its GUCs.
   */
  async countManagers(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workspace_membership"
      WHERE "workspaceId" = ${workspaceId} AND "workspace_role" = 'manager'
      ORDER BY "id"
      FOR UPDATE
    `;
    return rows.length;
  },

  /**
   * Workspaces the user belongs to, ordered by membership.createdAt asc
   * so the auto-created default workspace (Subtask 1.2.4) lands first in
   * the switcher list (Subtask 1.2.6).
   *
   * Takes a REQUIRED `tx` (MOTIR-2774) for the same reason its org-tier mirror
   * `organizationMembershipRepository.findOrganizationsByUser` does: `workspace_membership`
   * is policy-gated on `app.user_id`, and read off the `@/lib/db` singleton with nothing
   * bound the policy returns an EMPTY ARRAY AND RAISES NOTHING — so every surface that
   * lists "your workspaces" silently showed none.
   */
  async findWorkspacesByUser(userId: string, tx: Prisma.TransactionClient): Promise<Workspace[]> {
    const rows = await tx.workspaceMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
    return rows.map((r) => r.workspace);
  },

  /**
   * Count the user's memberships inside the caller's transaction. Used by
   * ensureDefaultWorkspace as the zero-membership gate; reads inside a
   * transaction take `tx` so the count reflects rows the same transaction
   * (and the row lock it holds) can see.
   */
  async countByUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workspaceMembership.count({ where: { userId } });
  },

  /**
   * The user's first membership (by createdAt asc) inside the caller's
   * transaction — the auto-created default lands first, so this returns
   * the "active by default" workspace. Includes the workspace row so the
   * service can build its DTO without a second round-trip.
   */
  async findFirstByUserWithWorkspace(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<(WorkspaceMembership & { workspace: Workspace }) | null> {
    return tx.workspaceMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
  },

  /**
   * The user's membership in a specific workspace, with the workspace row,
   * inside the caller's transaction. Used to resolve the active context
   * for a cookie-pinned workspace.
   */
  async findByUserAndWorkspaceWithWorkspace(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<(WorkspaceMembership & { workspace: Workspace }) | null> {
    return tx.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      include: { workspace: true },
    });
  },

  /**
   * Members of a workspace joined with the user fields the settings
   * Members card renders, ordered by membership.createdAt asc so the
   * owner (first membership) lands first. Takes `tx` because the
   * workspace_membership RLS policy reads the per-transaction GUCs set
   * by withWorkspaceContext — outside that transaction the policy sees
   * NULL and returns zero rows under the non-bypass app role.
   */
  async findMembersByWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MembershipWithUser[]> {
    return tx.workspaceMembership.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  /**
   * How many members a workspace has, WITHOUT locking anything — the read the
   * account-erasure impact preview (MOTIR-3699) uses to decide whether the
   * reader is a workspace's SOLE member (and so whether it goes with their
   * account or is a choice they can escape by inviting somebody).
   *
   * ⚠️ DELIBERATELY NOT {@link countByWorkspaceForUpdate}. That one exists to
   * serialize a read-derived WRITE; nothing has been decided at preview time, so
   * a lock here would take row locks on every workspace the reader belongs to
   * for a screen that only renders numbers. `tx` is REQUIRED all the same — the
   * `membership_visible_active_or_own` policy counts only the ACTIVE workspace's
   * rows plus the caller's own, so an unbound count would answer `1` for every
   * workspace and report the whole account as solely-owned.
   */
  async countByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workspaceMembership.count({ where: { workspaceId } });
  },

  /**
   * Count of memberships in a workspace, LOCKING those rows `FOR UPDATE` inside
   * the caller's transaction — the race-safe read the last-member guard in
   * workspacesService.removeMember uses (lock-before-read-derived-update,
   * CLAUDE.md § 4-layer). A plain same-transaction COUNT does NOT lock
   * the rows another transaction deletes, so two concurrent leaves of a
   * 2-member workspace could both see `count = 2`, both pass the guard, and both
   * delete → ZERO members (an orphaned, unreachable workspace). Locking the
   * membership rows serializes the racers: the second blocks until the first
   * commits, re-reads the reduced set, and correctly hits LastMemberError.
   *
   * `ORDER BY "id"` pins a deterministic lock order so the racers can't
   * deadlock; Postgres forbids `count(*) … FOR UPDATE`, so we SELECT the row ids
   * under the lock and count them in JS. `tx` REQUIRED — the lock lives only for
   * its transaction.
   */
  async countByWorkspaceForUpdate(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workspace_membership"
      WHERE "workspaceId" = ${workspaceId}
      ORDER BY "id"
      FOR UPDATE
    `;
    return rows.length;
  },

  /**
   * Memberships for a set of users across a set of workspaces, inside the
   * caller's transaction. Used by the Story 6.10 cross-workspace member roster
   * to answer "which of the org's workspaces does each member belong to?" in a
   * single round-trip (the service passes the org's workspace ids + the current
   * roster page's user ids). Returns the lean (userId, workspaceId) pairs the
   * roster needs — the workspace names are joined in the service from
   * workspaceRepository.listByOrganization. An empty id list short-circuits to
   * [] (the no-members / no-workspaces page makes the empty match explicit).
   */
  async findByWorkspaceIdsAndUserIds(
    workspaceIds: string[],
    userIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Pick<WorkspaceMembership, 'userId' | 'workspaceId'>[]> {
    if (workspaceIds.length === 0 || userIds.length === 0) return [];
    return tx.workspaceMembership.findMany({
      where: { workspaceId: { in: workspaceIds }, userId: { in: userIds } },
      select: { userId: true, workspaceId: true },
    });
  },

  /**
   * The workspace's OWNER membership — the oldest `role: 'owner'` row (a
   * workspace is born with exactly one owner at creation; `orderBy createdAt
   * asc` pins a deterministic pick should role changes ever produce more than
   * one). Used by Story 6.12's public-submit path as the deterministic "intake
   * reporter": a cross-org public submitter is NOT a workspace member, but
   * `createWorkItem` requires the reporter to BE one (`assertReporterMember`),
   * so the owner stands in as `reporterId` while the real submitter rides
   * `submittedByUserId` (the 6.11.4 seam). Read-only → the `db` singleton
   * (optional `tx` for a caller already inside a transaction). Returns null only
   * for a workspace with no owner (an invariant violation the caller handles).
   */
  async findOwnerByWorkspace(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership | null> {
    const client = tx ?? dbRead;
    return client.workspaceMembership.findFirst({
      where: { workspaceId, role: 'owner' },
      orderBy: { createdAt: 'asc' },
    });
  },

  async create(
    data: { userId: string; workspaceId: string; role: MemberRole },
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership> {
    return tx.workspaceMembership.create({ data });
  },

  /**
   * Set (or clear, with null) the member's active project. Targets the row
   * by the (userId, workspaceId) unique so a member's active project is
   * scoped to the workspace it lives in. The service asserts membership and
   * that the project belongs to the workspace before calling this; the FK's
   * onDelete: SetNull is the structural backstop if the project later goes.
   */
  async setActiveProject(
    userId: string,
    workspaceId: string,
    projectId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership> {
    return tx.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { activeProjectId: projectId },
    });
  },

  /**
   * Returns the deleted membership row, or null if no matching row
   * existed (treats "already gone" as a no-op rather than an error —
   * the Leave / Remove flows in the settings UI rely on this).
   */
  async deleteByUserAndWorkspace(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership | null> {
    try {
      return await tx.workspaceMembership.delete({
        where: { userId_workspaceId: { userId, workspaceId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },

  /**
   * Drop every workspace membership this user holds — the erasure sweep's
   * membership arm (MOTIR-3702).
   *
   * ⚠️ IT RUNS AFTER THE ERASURE TRANSACTION, NOT INSIDE IT, and the reason is
   * a gate rather than a preference. The sweep's next act is to delete the
   * workspaces the reader is the only member of, through
   * `workspacesService.deleteWorkspaceForErasure` — which asserts, under a lock,
   * that the reader's workspace membership is the workspace's ONLY one
   * (MOTIR-6309). Removing the memberships before the delete makes the delete
   * refuse, leaving a workspace standing that DECISION 3 says goes with the
   * account.
   *
   * So the memberships are the LAST thing erasure removes, and the sole-
   * membership ones are usually gone by then anyway — the workspace delete
   * cascades them away, which is why this is a `deleteMany` rather than a
   * per-row delete.
   */
  async deleteAllByUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.workspaceMembership.deleteMany({ where: { userId } });
    return count;
  },
};
