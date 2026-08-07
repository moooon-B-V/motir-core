import { Prisma, type ProjectRepoCollaborator } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Single Prisma operations on `project_repository_collaborator` — ONE person's
// access to ONE repository Motir made (Story MOTIR-1775 · MOTIR-1910).
//
// Its own leaf rather than more methods on `projectRepoRepository`, per the
// repository-name-matches-the-ENTITY rule: these rows are a different entity from
// the repository set they hang off, and filing them under the parent is exactly
// the `workspaceMembership`-in-`workspaceRepository` mistake CLAUDE.md names.
//
// Writes require `tx` (the compile-time guarantee they run in a transaction);
// reads take `tx` where they guard a write, and use the `db` singleton where they
// do not. No business logic and no transactions — those belong in
// `projectRepoAccessService`.
//
// Every path runs under an active workspace context, so the RLS policy's
// `app.workspace_id` GUC gates the rows; the `workspaceId` argument is the
// belt-and-suspenders app-level scope.

/** The row shape a write takes — everything except the generated id/stamps. */
export interface ProjectRepoCollaboratorWrite {
  githubLogin: string;
  permission: ProjectRepoCollaborator['permission'];
  invitedAt: Date | null;
  acceptedAt: Date | null;
  invitationUrl: string | null;
}

export const projectRepoCollaboratorRepository = {
  /** Every collaborator record on ONE repository row. */
  async listByProjectRepo(
    projectRepoId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectRepoCollaborator[]> {
    const client = tx ?? db;
    return client.projectRepoCollaborator.findMany({
      where: { projectRepoId, workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every collaborator record across a whole SET of repository rows — one query
   * for the team matrix.
   *
   * The team surface is N members × M repositories, so reading per row would be M
   * round-trips to build one table. An empty `projectRepoIds` short-circuits
   * rather than issuing an `IN ()`, which is the honest answer for a project whose
   * set has no established rows yet.
   */
  async listByProjectRepoIds(
    projectRepoIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectRepoCollaborator[]> {
    if (projectRepoIds.length === 0) return [];
    const client = tx ?? db;
    return client.projectRepoCollaborator.findMany({
      where: { projectRepoId: { in: projectRepoIds }, workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * ONE person's record on ONE repository, LOCKED for update.
   *
   * `SELECT … FOR UPDATE` because every write through this leaf is READ-DERIVED —
   * the service reads the current stamps to decide whether to stamp `acceptedAt`,
   * and two concurrent invites of the same member (a double-submit, or a member
   * pressing invite while an all-members pass runs) would otherwise both read the
   * pre-write state. Raw SQL because Prisma has no `FOR UPDATE`; it returns the
   * ids the caller needs and nothing more, since the caller re-reads through the
   * upsert anyway.
   *
   * Returns null when no record exists yet — which is the common first-invite
   * case, and is NOT a lock failure: there is no row to lock, and the unique index
   * on `(project_repository_id, user_id)` is what serialises the concurrent
   * CREATE that follows.
   */
  async findForUpdate(
    projectRepoId: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<ProjectRepoCollaborator, 'id' | 'invitedAt' | 'acceptedAt'> | null> {
    const rows = await tx.$queryRaw<
      Pick<ProjectRepoCollaborator, 'id' | 'invitedAt' | 'acceptedAt'>[]
    >`
      SELECT "id" AS "id", "invited_at" AS "invitedAt", "accepted_at" AS "acceptedAt"
      FROM "project_repository_collaborator"
      WHERE "project_repository_id" = ${projectRepoId}
        AND "user_id" = ${userId}
        AND "workspace_id" = ${workspaceId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Create or update ONE person's record on ONE repository.
   *
   * An upsert keyed on the `(projectRepoId, userId)` unique index, which is what
   * makes a retry after a crash between the GitHub call and the write converge on
   * one record instead of a second invitation for the same account. The caller
   * decides what `acceptedAt` should be (it is monotonic — see the service), so
   * this leaf writes exactly what it is given and interprets nothing.
   */
  async upsert(
    key: { projectRepoId: string; userId: string; workspaceId: string },
    data: ProjectRepoCollaboratorWrite,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoCollaborator> {
    return tx.projectRepoCollaborator.upsert({
      where: {
        projectRepoId_userId: { projectRepoId: key.projectRepoId, userId: key.userId },
      },
      create: {
        workspace: { connect: { id: key.workspaceId } },
        projectRepo: { connect: { id: key.projectRepoId } },
        user: { connect: { id: key.userId } },
        ...data,
      },
      update: data,
    });
  },

  /** Stamp ONE record accepted, and drop the invitation URL with it — the pending
   *  invitation ceases to exist the moment it is accepted, so a link left behind
   *  would point at a 404. */
  async markAccepted(
    id: string,
    acceptedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRepoCollaborator> {
    return tx.projectRepoCollaborator.update({
      where: { id },
      data: { acceptedAt, invitationUrl: null },
    });
  },
};
