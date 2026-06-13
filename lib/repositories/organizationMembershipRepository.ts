import {
  type Organization,
  type OrganizationMembership,
  type OrganizationRole,
  Prisma,
  type User,
} from '@prisma/client';
import { db } from '@/lib/db';

// A membership row joined with the slice of its user the cross-workspace member
// roster (6.10.5) renders. Kept here (not in the service) because the join shape
// is a data-access concern; the service maps it to a DTO.
export type OrgMembershipWithUser = OrganizationMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

// OrganizationMembership repository — single Prisma operations on the
// `organization_membership` join table (Story 6.10). Owns its own file (not
// nested under organizationRepository) because the primary entity it operates on
// is OrganizationMembership, not Organization. Mirrors
// `workspaceMembershipRepository`: writes require `tx`, reads that guard a write
// take `tx` so the RLS policy's org/user GUCs admit the row under the non-bypass
// `prodect_app` role. The membership-gating logic + the cross-workspace roster
// pagination live in `organizationsService` (6.10.4).

export const organizationMembershipRepository = {
  async findByOrgAndUser(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    return db.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  },

  /**
   * Same lookup as findByOrgAndUser, but inside the caller's transaction so the
   * organization_membership RLS policy (keyed off the per-transaction
   * `app.organization_id` / `app.user_id` GUCs) admits the row under the
   * non-bypass `prodect_app` role. Used by the 6.10.4 access gate, whose result
   * must be correct in production.
   */
  async findByOrgAndUserInTx(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership | null> {
    return tx.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  },

  /**
   * The organizations a user belongs to, ordered by membership.createdAt asc so
   * the auto-provisioned default org (6.10.4 signup flow) lands first in the
   * switcher list (6.10.5). Mirrors workspaceMembershipRepository.findWorkspacesByUser.
   */
  async findOrganizationsByUser(userId: string): Promise<Organization[]> {
    const rows = await db.organizationMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { organization: true },
    });
    return rows.map((r) => r.organization);
  },

  /**
   * Members of an organization joined with the user fields the roster renders,
   * ordered by membership.createdAt asc so the owner (first membership) lands
   * first. Takes `tx` because the organization_membership RLS policy reads the
   * per-transaction GUCs bound by the 6.10.4 org-context layer; outside that
   * transaction the policy sees NULL and returns zero rows under the non-bypass
   * app role. The PAGINATED cross-workspace roster (the at-scale read) is
   * assembled in the service (6.10.4) on top of this.
   */
  async findMembersByOrg(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgMembershipWithUser[]> {
    return tx.organizationMembership.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  /**
   * Count of memberships in an organization. Takes `tx` so a last-owner guard in
   * the service (6.10.4) can read the count and mutate in the same transaction,
   * preventing a TOCTOU race (mirrors workspaceMembershipRepository.countByWorkspace).
   */
  async countByOrg(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.organizationMembership.count({ where: { organizationId } });
  },

  /**
   * Count of OWNER memberships in an organization. Takes `tx` so the
   * last-owner guard in organizationsService (remove / demote) reads the count
   * and mutates in the SAME transaction — an org with zero owners is
   * unadministrable, so removing or demoting the last owner must be blocked
   * without a TOCTOU window.
   */
  async countOwnersByOrg(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.organizationMembership.count({
      where: { organizationId, role: 'owner' },
    });
  },

  /**
   * One keyset-paginated PAGE of an org's members joined with the user fields
   * the roster renders, ordered by (createdAt asc, id asc) so the owner (first
   * membership) leads and the order is stable across pages. Returns up to
   * `limit + 1` rows so the service can detect "is there a next page?" and
   * compute the next cursor without a second count. `cursorId` is the last
   * membership id of the previous page (Prisma `cursor` + `skip: 1`); omit it
   * for the first page. This is the at-scale read (finding #57) — a large org's
   * roster is NEVER loaded whole. Takes `tx` so the RLS policy's per-transaction
   * GUCs admit the rows.
   */
  async findMembersByOrgPage(
    organizationId: string,
    limit: number,
    cursorId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<OrgMembershipWithUser[]> {
    return tx.organizationMembership.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  async create(
    data: { organizationId: string; userId: string; role: OrganizationRole },
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership> {
    return tx.organizationMembership.create({ data });
  },

  async updateRole(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership> {
    return tx.organizationMembership.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    });
  },

  /**
   * Returns the deleted membership row, or null if no matching row existed
   * (treats "already gone" as a no-op rather than an error — the remove flow in
   * 6.10.5 relies on this, mirroring workspaceMembershipRepository.deleteByUserAndWorkspace).
   */
  async deleteByOrgAndUser(
    organizationId: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationMembership | null> {
    try {
      return await tx.organizationMembership.delete({
        where: { organizationId_userId: { organizationId, userId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },
};
