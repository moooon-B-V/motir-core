'use server';

import { requirePlatformStaff } from '@/lib/platform/auth';
import { parseSpendPeriod } from '@/lib/platform/spend';
import type { PlatformTenantListDTO } from '@/lib/dto/platform';
import { parseTenantSort, platformUsageService } from '@/lib/services/platformUsageService';

/**
 * The Tenants list's SHOW MORE (MOTIR-7287): the next keyset page for the same
 * period, sort and filter. Each call is a read like the page's own — gated and
 * audited once by `platformUsageService.listTenants`.
 */
export async function loadMoreTenants(input: {
  period: string;
  sort: string;
  filter: string;
  cursor: string;
}): Promise<PlatformTenantListDTO> {
  const principal = await requirePlatformStaff('support');
  return platformUsageService.listTenants(principal, {
    period: parseSpendPeriod(input.period),
    sort: parseTenantSort(input.sort),
    filter: input.filter,
    cursor: input.cursor,
  });
}
