import { organizationsService } from '@/lib/services/organizationsService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { isOrgOwnerRole } from '@/lib/organizations/roles';
import { createCheckoutSession, createPortalSession, getOrgUsage } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import { BILLING_CATALOG, isKnownCheckoutPrice } from '@/lib/billing/catalog';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  UnknownBillingPriceError,
} from '@/lib/billing/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { BillingSessionDTO, BillingStatusDTO } from '@/lib/dto/billing';

// The OPEN-CORE side of billing (Story 8.1.6). motir-core holds NO ledger and NO
// Stripe key (the open-core invariant): it READS the org's plan over the boundary
// and INITIATES Stripe sessions through motir-ai (8.1.5), which owns the SDK and
// the secret. This service is the email.ts-style leaf-client pattern the
// aiUsageService already established — it (1) REUSES the 6.10.4 org gate
// (`resolveOrgAccess`), (2) enforces the ADR §7 permission split (viewing billing
// is owner/admin; every MUTATION is OWNER-ONLY), and (3) enforces the ADR §6
// CLOUD-ONLY gate (`MOTIR_CLOUD`) so a self-hosted build has no billing at all.
//
// The two billed products (ADR §1) read from two stores: ① Motir (seats) is the
// LOCAL `Organization.scaledTrackerSubscription` (written by 8.1.4c); ② Motir AI
// is the `PlanTier` + balance folded from the existing `/v1/usage` read. The
// Stripe AI-subscription lifecycle (status + renewal) needs a motir-ai read 8.1.5
// did not ship — a seam carried in the DTO comment, not faked here.

interface OrgActorInput {
  organizationId: string;
  actorUserId: string;
}

// The org-settings billing surface the Stripe redirects (success / cancel /
// portal-return) come back to. 8.1.7 owns the final route; this is the area the
// design names (`app/(authed)/settings/organization/billing`).
function billingPagePath(): string {
  return '/settings/organization/billing';
}

function billingPageUrl(query?: string): string {
  return `${resolveBaseUrlTrimmed()}${billingPagePath()}${query ?? ''}`;
}

export const billingService = {
  /**
   * The org's billing status — the two billed lines + the catalog (Story 8.1.6).
   * Cloud-only (BillingNotAvailableError → 404 off-cloud). VIEW is owner/admin;
   * a plain member gets BillingForbiddenError (→ 403, the routed-to-owner state).
   * Throws OrganizationNotFoundError (→ 404) for a non-member (the no-leak rule),
   * and lets a motir-ai failure propagate as a MotirAiError (→ the route's 502).
   */
  async getBillingStatus(input: OrgActorInput): Promise<BillingStatusDTO> {
    if (!isCloudBilling()) throw new BillingNotAvailableError();

    // (1) Gate — reuse the 6.10.4 org access check (404 for a non-member); VIEW
    // requires owner/admin (ADR §7), so a plain member is forbidden.
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!access.isOrgAdmin) {
      throw new BillingForbiddenError('Viewing billing requires an org owner or admin.');
    }

    // (2) ① Motir (seats) — the LOCAL scaled-tracker subscription (8.1.4c). Read
    // under the org context so the membership/org RLS admits the self-read.
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => organizationRepository.findByIdInTx(input.organizationId, tx),
    );
    const scaledTrackerSubscription =
      (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;

    // (3) ② Motir AI — fold the tier + balance from the existing usage read (the
    // card's blessed path). A motir-ai outage throws a MotirAiError the route maps
    // to 502 (the design's "couldn't load billing" state), never a fake zero.
    const usage = await getOrgUsage({ coreOrganizationId: input.organizationId, scope: 'org' });

    return {
      organizationId: input.organizationId,
      access: { role: access.role, canManageBilling: isOrgOwnerRole(access.role) },
      motir: { scaledTrackerSubscription },
      motirAi: { tier: usage.tier, balance: usage.balance },
      catalog: BILLING_CATALOG,
    };
  },

  /**
   * Start a Stripe Checkout Session for a selected catalog price, returning the
   * hosted URL to redirect to. Cloud-only; OWNER-ONLY (ADR §7). Validates the
   * price against the catalog allow-list before touching the boundary.
   */
  async startCheckout(
    input: OrgActorInput & { priceLookupKey: string },
  ): Promise<BillingSessionDTO> {
    await this.assertOwnerForMutation(input);

    if (!isKnownCheckoutPrice(input.priceLookupKey)) {
      throw new UnknownBillingPriceError(input.priceLookupKey);
    }

    // NOTE the catalog seam (lib/billing/catalog.ts): the boundary's `priceId` is
    // the Stripe price lookup key; motir-ai resolves it to the concrete Price.
    return createCheckoutSession({
      coreOrganizationId: input.organizationId,
      priceId: input.priceLookupKey,
      successUrl: billingPageUrl('?checkout=success'),
      cancelUrl: billingPageUrl('?checkout=cancel'),
    });
  },

  /**
   * Open a Stripe Billing Portal session, returning its short-lived URL. Cloud-
   * only; OWNER-ONLY. A 404 from motir-ai (the org has no Stripe customer yet)
   * surfaces as a MotirAiJobNotFoundError the route maps via the boundary path.
   */
  async openPortal(input: OrgActorInput): Promise<BillingSessionDTO> {
    await this.assertOwnerForMutation(input);

    return createPortalSession({
      coreOrganizationId: input.organizationId,
      returnUrl: billingPageUrl(),
    });
  },

  /**
   * Shared mutation gate: cloud-on + the actor is the org OWNER (ADR §7 — every
   * billing mutation is owner-only; an admin's view access does NOT extend to
   * mutations). Throws BillingNotAvailableError (404) / OrganizationNotFoundError
   * (404, non-member) / BillingForbiddenError (403, non-owner).
   */
  async assertOwnerForMutation(input: OrgActorInput): Promise<void> {
    if (!isCloudBilling()) throw new BillingNotAvailableError();
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!isOrgOwnerRole(access.role)) {
      throw new BillingForbiddenError('Managing billing is limited to the organization owner.');
    }
  },
};
