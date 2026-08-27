import type { AccountDeletionRequest, Organization, Workspace } from '@/generated/prisma/client';
import type {
  AccountDeletionRequestDTO,
  ErasureBlockingOrganizationDTO,
  ErasureWorkspaceDTO,
} from '@/lib/dto/accountErasure';

// Prisma → DTO conversion for the account-erasure impact preview (Story 8.4 ·
// Subtask MOTIR-3699).
//
// The preview is mostly NUMBERS, which need no mapping — these two functions
// exist for the rows it names. Both project to the narrowest shape the ledger
// renders, which is the point rather than a formality: an erasure ledger is
// rendered to somebody who is about to lose the rows it lists, and returning the
// whole Prisma model would put a workspace's `subtaskPrMergeMode` and an
// organization's billing columns on a confirmation screen that has no use for
// them.

/** A workspace as the ledger names it — id (for a link) and name. */
export function toErasureWorkspaceDTO(workspace: Workspace): ErasureWorkspaceDTO {
  return { id: workspace.id, name: workspace.name };
}

/**
 * The blocking organization, with the member COUNT the pane shows beside its
 * name — *"you are the only owner of an organization N other people belong
 * to"*. The count is supplied by the caller because it is a separate bound read,
 * not a column on the row.
 */
export function toBlockingOrganizationDTO(
  organization: Organization,
  memberCount: number,
): ErasureBlockingOrganizationDTO {
  return { id: organization.id, name: organization.name, memberCount };
}

/**
 * One account-deletion request → the shape the pane and the banner render
 * (Story 8.4 · Subtask MOTIR-3700).
 *
 * Drops `completedAt` and the audit columns deliberately: a reader looking at
 * this row is either waiting out a window or has just cancelled one, and
 * `completedAt` is the sweep's bookkeeping (MOTIR-3702). Nothing on the surface
 * renders it, so nothing in the DTO carries it.
 */
export function toAccountDeletionRequestDTO(
  request: AccountDeletionRequest,
): AccountDeletionRequestDTO {
  return {
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    erasureDueAt: request.erasureDueAt.toISOString(),
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
  };
}
