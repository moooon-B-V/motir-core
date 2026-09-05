import type { Prisma } from '@/generated/prisma/client';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';

/**
 * THE OWNING ORGANISATION OF A WORKSPACE — the one read every git-mirror writer
 * needs after MOTIR-4649 (Story MOTIR-4669).
 *
 * A repository is connected ONCE, to the ORGANISATION, and `github_repo` /
 * `github_installation` now carry `organization_id` for it. Nothing in either
 * write path has an organisation in hand — they are handed a workspace — so this
 * is the resolution, in one place rather than four.
 *
 * ⚠️ IT THROWS RATHER THAN RETURNING NULL, and that is the whole reason it is a
 * function instead of an inline read. `workspace.organizationId` is NOT NULL, so
 * a workspace that exists always has one; the only way to get nothing back is a
 * workspace id that names no row, which is a caller error. Returning null there
 * would let a mirror row be written with a null tenancy — the exact state the
 * column's nullability exists to permit for ONE row (the shared provisioning
 * installation) and for no other.
 *
 * Read-only reference data, so it needs no transaction of its own; it takes the
 * caller's `tx` so it is scoped by the same context the write runs in.
 */
export async function resolveOrganizationId(
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
  if (!workspace) {
    throw new Error(
      `Cannot resolve an organisation for workspace ${workspaceId}: no such workspace`,
    );
  }
  return workspace.organizationId;
}
