import { type Organization, type Prisma } from '@/generated/prisma/client';

/**
 * Cross-tenant ORGANIZATION access for the operator console — the platform
 * tier's repository layer for the org level (`docs/decisions/platform-staff-auth.md`
 * §3, Story MOTIR-4337 · MOTIR-4565).
 *
 * The sibling of `platformUserRepository`, and it follows that file's rules
 * rather than restating them:
 *
 * ⚠️ EVERY METHOD TAKES `tx` AS A REQUIRED PARAMETER, READS INCLUDED. The only
 * thing that opens a platform transaction is `withPlatformRead`, and the only
 * thing that writes the audit row is opening one — so requiring `tx` makes an
 * untrailed cross-tenant read a compile error rather than a review finding.
 *
 * ⚠️ AND UNLIKE `user`, THIS TABLE HAS RLS. `organization` runs FORCE ROW LEVEL
 * SECURITY, and until `20260905120000_organization_internal_billing` not one of
 * its eight policies mentioned `app.platform_staff`. That is why these methods
 * could not have shipped a day earlier: a read from this tier would have
 * returned ZERO ROWS and raised nothing, which the caller reads as "no such
 * org". The two arms that migration adds — a SELECT arm and an UPDATE arm, both
 * on `app.platform_staff` — are what make this file answer at all, and they are
 * the reason its methods must never be called on the `db` singleton.
 *
 * ⚠️ NO TENANT FILTER, deliberately. These methods see every organization Motir
 * hosts. What confines them is that they are reachable only from
 * `lib/services/platform*Service.ts`, each of whose public methods takes a
 * `PlatformPrincipal` and re-asserts the degree ladder.
 */
export const platformOrganizationRepository = {
  /**
   * Find organizations by name or slug, newest first.
   *
   * The same case-insensitive two-column `contains` the account lookup uses, for
   * the same reason: what an operator actually holds is half a name out of a
   * support message or a slug out of a URL. Not indexed and not meant to be —
   * the console is used by a handful of humans a few times a day, and a trigram
   * index on the tenancy root would be a write cost on every signup.
   *
   * `take` is a hard cap rather than a page: the answer to "too many matches" is
   * a narrower query, not a pager an operator scrolls through reading every
   * tenant Motir has.
   */
  async searchOrganizations(
    query: string,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<Organization[]> {
    return tx.organization.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { slug: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },

  /** One organization by id, or null. */
  async findOrganizationById(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id: organizationId } });
  },

  /**
   * Lock the organization row and return its CURRENT classification.
   *
   * ⚠️ THE LOCK IS THE POINT, not the read. Classifying is a read-derived write:
   * whether to write at all depends on the state read a moment earlier, because
   * setting the value it already has is a refusal rather than a no-op. Without
   * `FOR UPDATE` two operators acting on one org during the same conversation
   * both read "not classified", both write, and the audit log carries two
   * classifications of one org while only one of them describes a change that
   * happened. `CLAUDE.md`'s repository rule names exactly this case, and
   * `platformUserRepository.lockSuspensionState` is the shipped precedent.
   *
   * Returns `null` when the id names no organization, so the caller can tell
   * "gone" from "not classified" without a second read.
   */
  async lockInternalBilling(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ internalBilling: boolean } | null> {
    const rows = await tx.$queryRaw<{ internal_billing: boolean }[]>`
      SELECT "internal_billing" FROM "organization" WHERE "id" = ${organizationId} FOR UPDATE
    `;
    const row = rows[0];
    return row ? { internalBilling: row.internal_billing } : null;
  },

  /** Set or clear the internal-billing classification. */
  async setInternalBilling(
    organizationId: string,
    internalBilling: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({
      where: { id: organizationId },
      data: { internalBilling },
    });
  },
};
