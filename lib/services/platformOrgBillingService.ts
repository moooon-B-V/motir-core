import 'server-only';

import { getBillingHistory } from '@/lib/ai/motirAiClient';
import type { RawBillingHistoryResponse } from '@/lib/ai/types';
import { isCloudBilling } from '@/lib/billing/availability';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { PlatformOrganizationDetailDTO } from '@/lib/dto/platform';
import { toPlatformOrganizationDetailDTO } from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { buildOrgBill, type OrgBill } from '@/lib/platform/orgBill';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { assembleBillingStatus } from '@/lib/services/billingService';

/**
 * The org page's BILLING & PLANS tab (Story MOTIR-727 · MOTIR-7289, design D9) —
 * what the org's owner sees on their own billing page, READ-ONLY for an operator.
 *
 * ⚠️ READ-ONLY BY CONSTRUCTION. This service has one method and it reads: the
 * tenant page's status assembly (`assembleBillingStatus` — the same reads, so the
 * two surfaces never disagree) and nothing that starts a checkout, opens a portal,
 * changes a plan or syncs a seat. Changing a tenant's billing is Story 10.3.
 *
 * ⚠️ THE TENANT GATE IS NOT WIDENED. `billingService.getBillingStatus` still
 * requires an owner or admin of THAT org; the operator reaches another org's
 * billing only here — behind `requirePlatformStaff` and ONE audited
 * `withPlatformRead` (`estate.read`, the org named) — and the remote reads run after
 * it, outside the transaction.
 */

/**
 * The PAYMENT & INVOICES slot (MOTIR-7292, design D9), filled from motir-ai's
 * read-only Stripe billing history (MOTIR-7304) — motir-core holds no Stripe
 * client by design. Every amount is integer CENTS, so no float reaches a money
 * figure; `month` is the invoice's `YYYY-MM` in UTC.
 */
export type BillingHistorySlot =
  | {
      state: 'connected';
      paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
      invoices: {
        id: string;
        month: string;
        status: string;
        amountCents: number;
        currency: string;
      }[];
    }
  /** The org has no Stripe customer. */
  | { state: 'none' }
  /** motir-ai or Stripe could not be read; the rest of the tab still renders. */
  | { state: 'unavailable' };

export type PlatformOrgBillingDTO =
  | { enabled: false; organization: PlatformOrganizationDetailDTO }
  | {
      enabled: true;
      organization: PlatformOrganizationDetailDTO;
      memberCount: number;
      /** The tenant status without its `access` (the operator holds no org role); null = could not be read. */
      status: Omit<BillingStatusDTO, 'access'> | null;
      bill: OrgBill | null;
      billingHistory: BillingHistorySlot;
    };

export const platformOrgBillingService = {
  async getOrgBilling(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrgBillingDTO> {
    await requirePlatformStaff('support');

    const local = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
        targetLabel: 'billing',
      },
      async (tx) => {
        const org = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
        const memberCount = await platformEstateRepository.countOrganizationMembers(
          organizationId,
          tx,
        );
        return { org, memberCount };
      },
    );
    const organization = toPlatformOrganizationDetailDTO(local.org);
    if (!isCloudBilling()) return { enabled: false, organization };

    let status: Omit<BillingStatusDTO, 'access'> | null = null;
    try {
      // The operator holds no org role: `access` is filled for the shared assembly
      // and dropped here, so nothing downstream can read it as a capability.
      const { access: _access, ...rest } = await assembleBillingStatus(local.org, organizationId, {
        role: 'member',
        canManageBilling: false,
      });
      status = rest;
    } catch {
      status = null;
    }
    return {
      enabled: true,
      organization,
      memberCount: local.memberCount,
      status,
      bill: status ? buildOrgBill(status, local.memberCount) : null,
      billingHistory: await readBillingHistory(organizationId),
    };
  },
};

/**
 * The Payment & invoices slot from motir-ai's billing history, read after the
 * audited transaction like the tab's other remote reads. An answer with no payment
 * method and no invoice is an org with no Stripe customer (`none`); a throw is
 * `unavailable`, so the card says so while the rest of the tab renders.
 */
async function readBillingHistory(organizationId: string): Promise<BillingHistorySlot> {
  let history: RawBillingHistoryResponse;
  try {
    history = await getBillingHistory({ coreOrganizationId: organizationId });
  } catch {
    return { state: 'unavailable' };
  }
  if (!history.paymentMethod && history.invoices.length === 0) return { state: 'none' };
  return {
    state: 'connected',
    paymentMethod: history.paymentMethod,
    invoices: history.invoices.map((inv) => ({
      id: inv.id,
      month: inv.createdAt.slice(0, 7),
      status: inv.status,
      amountCents: inv.amountCents,
      currency: inv.currency,
    })),
  };
}
