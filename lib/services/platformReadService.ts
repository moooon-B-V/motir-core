import 'server-only';

import type { PlatformEstateCountsDTO, PlatformOrganizationEstateDTO } from '@/lib/dto/platform';
import {
  toPlatformOrganizationSummaryDTO,
  toPlatformWorkspaceSummaryDTO,
} from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';

/**
 * The audited CROSS-TENANT READ authority — Story MOTIR-727 · MOTIR-730, and the
 * service the ADR's §3 layer table names first (`docs/decisions/platform-staff-auth.md`).
 *
 * Everything Story 10.1 renders about the estate below a single organization is
 * read here: the overview's counts (MOTIR-731) and the drill-down's tiers
 * (MOTIR-733). Nothing is rendered by this card.
 *
 * ---------------------------------------------------------------------------
 * WHAT EVERY METHOD DOES, IN ORDER
 * ---------------------------------------------------------------------------
 * 1. `requirePlatformStaff('support')` — MOTIR-2896's gate, called rather than
 *    re-implemented. It runs BEFORE any transaction opens, so a non-staff caller
 *    is refused with nothing read and nothing written. The `(admin)` layout also
 *    asserts it; §2 requires both, because the service check is what protects a
 *    future route handler, action or job that never passes through a layout.
 * 2. `withPlatformRead(principal, entry, …)` — binds `app.platform_staff` and
 *    INSERTs exactly one `platform_audit_log` row as the transaction's first
 *    statement. A read that throws rolls the row back with it; a read that
 *    commits cannot exist without one.
 * 3. The reads, through `platformEstateRepository` / `platformOrganizationRepository`
 *    — the only methods that carry no tenant filter. No tenant-scoped service or
 *    repository was changed to make them possible; the `platform_staff` SELECT
 *    arms (`20261001200000_platform_staff_estate_read_arms`) are what admit them.
 *
 * ONE AUDITED TRANSACTION PER METHOD CALL. A page that needs two of these reads
 * calls a method that returns both, rather than two methods — two calls would
 * write two rows for one page view (the argument `getOrganizationPage` makes).
 */

/** How many workspaces one organization read returns. A cap, with `hasMoreWorkspaces`. */
export const PLATFORM_ORG_WORKSPACE_LIMIT = 100;

export const platformReadService = {
  /**
   * The estate's four headline counts — organizations, workspaces, projects,
   * users — as four `count(*)` statements, never a row load (finding #57).
   *
   * Audited as an estate-wide read: `targetKind: 'platform'`, no target id.
   */
  async getEstateCounts(principal: PlatformPrincipal): Promise<PlatformEstateCountsDTO> {
    await requirePlatformStaff('support');

    return withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform', targetLabel: 'estate counts' },
      async (tx) => {
        // Sequential, not `Promise.all`: an interactive transaction is one
        // connection, and Prisma does not run statements on it concurrently.
        const organizations = await platformEstateRepository.countOrganizations(tx);
        const workspaces = await platformEstateRepository.countWorkspaces(tx);
        const projects = await platformEstateRepository.countProjects(tx);
        const users = await platformEstateRepository.countUsers(tx);
        return { organizations, workspaces, projects, users };
      },
    );
  },

  /**
   * One organization and the tiers beneath it: its member count and its
   * workspaces, each with project and member counts.
   *
   * A missing organization throws INSIDE the transaction, so the read leaves no
   * audit row — the trail records reads that happened, not ids somebody typed.
   *
   * @throws PlatformOrganizationNotFoundError when the id names no organization.
   */
  async getOrganizationEstate(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrganizationEstateDTO> {
    await requirePlatformStaff('support');

    return withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
      },
      async (tx) => {
        const organization = await platformOrganizationRepository.findOrganizationById(
          organizationId,
          tx,
        );
        if (!organization) throw new PlatformOrganizationNotFoundError(organizationId);

        const memberCount = await platformEstateRepository.countOrganizationMembers(
          organizationId,
          tx,
        );
        const rows = await platformEstateRepository.listWorkspacesForOrganization(
          organizationId,
          PLATFORM_ORG_WORKSPACE_LIMIT + 1,
          tx,
        );

        return {
          organization: toPlatformOrganizationSummaryDTO(organization),
          memberCount,
          workspaces: rows
            .slice(0, PLATFORM_ORG_WORKSPACE_LIMIT)
            .map(toPlatformWorkspaceSummaryDTO),
          hasMoreWorkspaces: rows.length > PLATFORM_ORG_WORKSPACE_LIMIT,
        };
      },
    );
  },
};
