import type { Prisma } from '@/generated/prisma/client';
import { roleMigrationReportRepository } from '@/lib/repositories/roleMigrationReportRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readReachRole } from '@/lib/workspaces/membershipGate';
import { NotAMemberError, WorkspaceRoleForbiddenError } from '@/lib/workspaces/errors';
import { toRoleMigrationEntryDTO } from '@/lib/mappers/workspaceMappers';
import type { RoleMigrationPageDTO } from '@/lib/dto/workspaces';

// roleMigrationReportService — the Managers-only read of who the move to
// workspace roles changed, and why (Story MOTIR-6168 · MOTIR-6465). The rows are
// written by the migrations (MOTIR-6458 / MOTIR-6461); the application reads a
// page of the OPEN ones and dismisses one at a time.
//
// ⚠️ MANAGERS ONLY, on the server. The report names what each person held before
// — every project role — which a Member has no business reading about a
// colleague. A non-Manager is refused (403), a non-member is not-found (404).

/** The notice's page size (the card's acceptance criterion: pages at 20). */
export const ROLE_MIGRATION_PAGE_SIZE = 20;

async function assertManager(
  actorUserId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const role = await readReachRole(actorUserId, workspaceId, tx);
  if (!role) throw new NotAMemberError(actorUserId, workspaceId);
  if (role !== 'manager') throw new WorkspaceRoleForbiddenError(actorUserId, workspaceId);
}

export const roleMigrationReportService = {
  /** One page of the workspace's open report rows, newest first, with the open total. */
  async listOpen(
    workspaceId: string,
    actorUserId: string,
    cursor?: string | null,
  ): Promise<RoleMigrationPageDTO> {
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await assertManager(actorUserId, workspaceId, tx);
      const page = await roleMigrationReportRepository.listOpenByWorkspace(
        workspaceId,
        { cursor: cursor ?? null, limit: ROLE_MIGRATION_PAGE_SIZE },
        tx,
      );
      const total = await roleMigrationReportRepository.countOpenByWorkspace(workspaceId, tx);
      return {
        entries: page.rows.map(toRoleMigrationEntryDTO),
        total,
        nextCursor: page.nextCursor,
      };
    });
  },

  /**
   * The first page for the Members page, or `null` for a reader who is not a
   * Manager — the notice is simply absent for them, so the page asks once and
   * never branches on a refusal.
   */
  async firstPageForViewer(
    workspaceId: string,
    actorUserId: string,
  ): Promise<RoleMigrationPageDTO | null> {
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const role = await readReachRole(actorUserId, workspaceId, tx);
      if (role !== 'manager') return null;
      const page = await roleMigrationReportRepository.listOpenByWorkspace(
        workspaceId,
        { limit: ROLE_MIGRATION_PAGE_SIZE },
        tx,
      );
      const total = await roleMigrationReportRepository.countOpenByWorkspace(workspaceId, tx);
      return {
        entries: page.rows.map(toRoleMigrationEntryDTO),
        total,
        nextCursor: page.nextCursor,
      };
    });
  },

  /**
   * Dismiss one open row of THIS workspace. Idempotent: a row already dismissed,
   * or one belonging to another workspace, answers `false` and changes nothing.
   */
  async dismiss(workspaceId: string, actorUserId: string, entryId: string): Promise<boolean> {
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      await assertManager(actorUserId, workspaceId, tx);
      return roleMigrationReportRepository.dismiss(entryId, tx, workspaceId);
    });
  },
};
