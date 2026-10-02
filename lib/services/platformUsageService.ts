import 'server-only';

import type { Organization } from '@/generated/prisma/client';
import {
  getPlatformUsageOrgs,
  type RawPlatformUsageOrgs,
  type RawSpendRow,
  type SpendListSort,
} from '@/lib/ai/motirAiClient';
import type { PlatformTenantListDTO, PlatformTenantSpendRowDTO } from '@/lib/dto/platform';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { SPEND_CATEGORIES } from '@/lib/platform/spend';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';

/**
 * The console's SPEND LISTS (Story MOTIR-727 · MOTIR-7287) — motir-ai's platform
 * rollup holds the figures, motir-core holds the names; this joins them under the
 * audited platform read.
 *
 * ⚠️ ONE AUDIT ROW PER VIEW, AND NO HTTP INSIDE THE TRANSACTION. motir-ai's request
 * deadline (30 s) outlives an interactive transaction (5 s), so the remote read
 * never runs inside `withPlatformRead`. That leaves two orders, one per case:
 *   - NO FILTER: read motir-ai first, then ONE audited read names the rows.
 *   - A FILTER: ONE audited read resolves the name/slug to organizations — whose
 *     names it then already holds — and motir-ai is read narrowed to their ids.
 *     The filter narrows BEFORE the remote read, never after a page of it.
 * motir-ai unreachable is `unavailable: true`, never a throw; the view is audited
 * either way.
 */

/** One page of the Tenants list. */
export const TENANT_LIST_PAGE = 50;
/** How many organizations a filter may resolve to; past it, the operator narrows it. */
export const TENANT_FILTER_LIMIT = 200;
/** The filter's shortest useful query, as the org lookup it replaces had it. */
export const TENANT_FILTER_MIN_LENGTH = 2;

export const TENANT_LIST_SORTS: readonly SpendListSort[] = ['cost', 'charged', ...SPEND_CATEGORIES];

export function parseTenantSort(raw: string | null | undefined): SpendListSort {
  return TENANT_LIST_SORTS.includes(raw as SpendListSort) ? (raw as SpendListSort) : 'cost';
}

type Named = Pick<Organization, 'id' | 'name' | 'slug' | 'isMeta' | 'internalBilling'>;

function toRow(row: RawSpendRow, org: Named | null): PlatformTenantSpendRowDTO {
  return {
    organization: org
      ? {
          id: org.id,
          name: org.name,
          slug: org.slug,
          isMeta: org.isMeta,
          internalBilling: org.internalBilling,
        }
      : row.entityId === 'platform'
        ? null
        : {
            id: row.entityId,
            name: row.entityId,
            slug: null,
            isMeta: false,
            internalBilling: false,
          },
    credits: row.credits,
    indexingSeconds: row.indexingSeconds,
    chargedCredits: row.chargedCredits,
    costMicroUsd: row.costMicroUsd,
  };
}

async function readOrgs(
  query: Parameters<typeof getPlatformUsageOrgs>[0],
): Promise<RawPlatformUsageOrgs | null> {
  try {
    return await getPlatformUsageOrgs(query);
  } catch {
    return null;
  }
}

export const platformUsageService = {
  /**
   * The Tenants list (design D10): the estate total over ALL organizations, then
   * one row per organization for `period`, sorted by `sort`, keyset-paged.
   */
  async listTenants(
    principal: PlatformPrincipal,
    input: { period: string; sort: SpendListSort; filter?: string | null; cursor?: string | null },
  ): Promise<PlatformTenantListDTO> {
    await requirePlatformStaff('support');
    const filter = (input.filter ?? '').trim();
    const filtering = filter.length >= TENANT_FILTER_MIN_LENGTH;
    const base = { period: input.period, sort: input.sort, filter: filtering ? filter : '' };
    const remoteQuery = {
      period: input.period,
      sort: input.sort,
      limit: TENANT_LIST_PAGE,
      cursor: input.cursor ?? null,
    };
    const audit = {
      action: 'estate.read' as const,
      targetKind: 'platform' as const,
      targetLabel: `tenants ${input.period}${filtering ? ` "${filter}"` : ''}`,
    };

    if (filtering) {
      // The filter narrows FIRST — one audited read of motir-core's own table.
      const matches = await withPlatformRead(principal, audit, (tx) =>
        platformOrganizationRepository.searchOrganizations(filter, TENANT_FILTER_LIMIT + 1, tx),
      );
      const capped = matches.length > TENANT_FILTER_LIMIT;
      const kept = matches.slice(0, TENANT_FILTER_LIMIT);
      const byId = new Map<string, Named>(kept.map((o) => [o.id, o]));
      const page = await readOrgs({ ...remoteQuery, coreOrganizationIds: kept.map((o) => o.id) });
      if (!page)
        return {
          ...base,
          estate: null,
          rows: [],
          nextCursor: null,
          filterCapped: capped,
          unavailable: true,
        };
      return {
        ...base,
        estate: toRow(page.estate, null),
        rows: page.items.map((r) => toRow(r, byId.get(r.entityId) ?? null)),
        nextCursor: page.nextCursor,
        filterCapped: capped,
        unavailable: false,
      };
    }

    const page = await readOrgs(remoteQuery);
    const orgs = await withPlatformRead(principal, audit, (tx) =>
      platformOrganizationRepository.findOrganizationsByIds(
        page ? page.items.map((r) => r.entityId) : [],
        tx,
      ),
    );
    if (!page)
      return {
        ...base,
        estate: null,
        rows: [],
        nextCursor: null,
        filterCapped: false,
        unavailable: true,
      };
    const byId = new Map<string, Named>(orgs.map((o) => [o.id, o]));
    return {
      ...base,
      estate: toRow(page.estate, null),
      rows: page.items.map((r) => toRow(r, byId.get(r.entityId) ?? null)),
      nextCursor: page.nextCursor,
      filterCapped: false,
      unavailable: false,
    };
  },
};
