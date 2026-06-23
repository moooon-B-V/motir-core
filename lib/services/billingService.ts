import { organizationsService } from '@/lib/services/organizationsService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { isOrgOwnerRole } from '@/lib/organizations/roles';
import {
  createCheckoutSession,
  createPortalSession,
  getOrgSubscription,
  getOrgUsage,
  setSeatQuantity,
  type SeatQuantityResult,
} from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import { BILLING_CATALOG, isKnownCheckoutPrice, type BillingCadence } from '@/lib/billing/catalog';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  UnknownBillingPriceError,
} from '@/lib/billing/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { BillingSessionDTO, BillingStatusDTO, SeatSummaryDTO } from '@/lib/dto/billing';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// A paid Motir AI plan = a live Stripe subscription that grants the monthly
// allotment (decision §5). `trialing` (the one-time free grant), `canceled`
// (dropped to free) and "no subscription" are NOT paid — they take the tier-gate
// paywall ("AI is a paid feature"), not the out-of-credits one.
const PAID_AI_SUBSCRIPTION_STATUSES = new Set(['active', 'past_due']);

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
// is the `PlanTier` + balance folded from the `/v1/usage` read, plus the Stripe
// subscription lifecycle (status + renewal) folded from the 8.1.13
// `/v1/stripe/subscription` read (the seam 8.1.5 did not ship, now landed).

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

    // (3) ② Motir AI — fold the tier + balance from the usage read AND the Stripe
    // subscription lifecycle (status + renewal) from the 8.1.13 subscription read,
    // so 8.1.7 renders the status `Pill` + "renews {date}". Both are over the
    // boundary; a motir-ai outage throws a MotirAiError the route maps to 502 (the
    // design's "couldn't load billing" state), never a fake zero. The subscription
    // read returns an EMPTY shape (status: null) for a free org — not an error.
    const [usage, subscription] = await Promise.all([
      getOrgUsage({ coreOrganizationId: input.organizationId, scope: 'org' }),
      getOrgSubscription({ coreOrganizationId: input.organizationId }),
    ]);

    return {
      organizationId: input.organizationId,
      access: { role: access.role, canManageBilling: isOrgOwnerRole(access.role) },
      isMeta: org?.isMeta ?? false,
      motir: { scaledTrackerSubscription },
      motirAi: { tier: usage.tier, balance: usage.balance, subscription },
      catalog: BILLING_CATALOG,
    };
  },

  /**
   * The members-page SEAT summary (Story 8.1.14) — the in-context seat/billing
   * layer the org Members admin renders for a SCALED org. Returns `null` (→ NO
   * seat UI, the unchanged members page) for the three gated-out cases:
   *   • a self-host build (`MOTIR_CLOUD` off — ADR §6),
   *   • a non-owner/admin actor (the no-leak default; the members page already
   *     forbids non-admins, so this is belt-and-braces),
   *   • a free or `canceled` org (no scaled-tracker subscription).
   * When scaled+`active`/`past_due`, returns the pricing (from `BILLING_CATALOG`),
   * cadence (from the `tracker_*` price id), renewal (`currentPeriodEnd`) and the
   * owner-only `canManageBilling` flag. This is a pure READ — it never writes
   * Stripe (8.1.12 owns the seat-quantity sync); the seat COUNT is the membership
   * count, read client-side from the roster total.
   */
  async getSeatSummary(input: OrgActorInput): Promise<SeatSummaryDTO | null> {
    if (!isCloudBilling()) return null;

    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!access.isOrgAdmin) return null;

    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => organizationRepository.findByIdInTx(input.organizationId, tx),
    );
    const sub = (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;
    // Free (null) or a wound-down (`canceled`) subscription → the page is unchanged.
    if (!sub || sub.status === 'canceled') return null;

    const cadence: BillingCadence = sub.priceId === 'tracker_annual' ? 'annual' : 'monthly';
    const seatPrices = BILLING_CATALOG.seatPlan.prices;
    return {
      status: sub.status,
      cadence,
      perSeatUsd: seatPrices[cadence].amountUsd,
      monthlyPerSeatUsd: seatPrices.monthly.amountUsd,
      annualPerSeatUsd: seatPrices.annual.amountUsd,
      currentPeriodEnd: sub.currentPeriodEnd,
      canManageBilling: isOrgOwnerRole(access.role),
    };
  },

  /**
   * The MEMBER-SAFE AI entitlement read that drives the 8.1.8 paywall. Unlike
   * `getBillingStatus` (owner/admin VIEW gate), this admits ANY org member —
   * because the paywall must render its variant for everyone, and a plain member
   * gets the "ask an owner" state rather than a 403. It exposes only the upsell's
   * needs (blocked? can-buy? paid-plan vs tier-gate? org name + tier), never the
   * financial detail.
   *
   * - Off-cloud (`MOTIR_CLOUD=false`) → `applicable: false`: a self-host build is
   *   uncapped and never metered, so there is no paywall. The caller renders
   *   nothing.
   * - On cloud → verifies org membership (`resolveOrgAccess`; a non-member throws
   *   OrganizationNotFoundError, the no-leak rule), then folds the AI tier +
   *   balance (usage read) and the Stripe subscription lifecycle into the entitlement.
   *   A motir-ai outage propagates as a MotirAiError (the route degrades to
   *   "not applicable" so a transient boundary blip never flashes a false gate).
   */
  /**
   * The AI entitlement for the actor's ACTIVE PROJECT context (the form the AI
   * entry points have — they hold a `ProjectContext`, not an org id). Resolves
   * the workspace's org RLS-aware (the same seam aiChatService uses) then folds
   * the entitlement. Off-cloud short-circuits BEFORE any read.
   */
  async getAiAccessForContext(input: {
    actorUserId: string;
    workspaceId: string;
  }): Promise<AiAccessDTO> {
    if (!isCloudBilling()) return notApplicableAiAccess();
    const organizationId = await resolveOrganizationId(input.actorUserId, input.workspaceId);
    return this.getAiAccess({ actorUserId: input.actorUserId, organizationId });
  },

  async getAiAccess(input: OrgActorInput): Promise<AiAccessDTO> {
    if (!isCloudBilling()) return notApplicableAiAccess();

    // Membership gate ONLY (any role) — NOT the owner/admin VIEW gate. Owner vs
    // member just selects the paywall variant (canManageBilling), never access.
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );

    const [org, usage, subscription] = await Promise.all([
      withOrgContext({ userId: input.actorUserId, organizationId: input.organizationId }, (tx) =>
        organizationRepository.findByIdInTx(input.organizationId, tx),
      ),
      getOrgUsage({ coreOrganizationId: input.organizationId, scope: 'org' }),
      getOrgSubscription({ coreOrganizationId: input.organizationId }),
    ]);

    // The META org (moooon B.V.) is exempt from the AI paywall: `applicable:
    // false` makes the upsell never render (the same shape as a self-host build —
    // useAiAccess only blocks when `applicable === true`). The motir-ai credit
    // gate is bypassed in parallel (the org's `isMeta` rides the job envelope).
    if (org?.isMeta) return notApplicableAiAccess();

    return {
      applicable: true,
      organizationId: input.organizationId,
      organizationName: org?.name ?? null,
      canManageBilling: isOrgOwnerRole(access.role),
      hasPaidAiPlan:
        subscription.status !== null && PAID_AI_SUBSCRIPTION_STATUSES.has(subscription.status),
      balance: usage.balance,
      tierName: usage.tier?.name ?? null,
      tierAllotment: usage.tier?.monthlyCreditAllotment ?? null,
      renewsAt: subscription.currentPeriodEnd,
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

  /**
   * Resync an org's scaled-tracker Stripe seat `quantity` to its current
   * active-member count (Subtask 8.1.12). The background half of the
   * membership → seat-quantity sync: the `system.billing-seat-sync` Inngest job
   * calls this after an org-membership add/remove commits (best-effort enqueue
   * via `enqueueScaledTrackerSeatSync`), so a failed Stripe call NEVER rolls back
   * or blocks the membership change.
   *
   * Has no actor — it runs as a background job — so it reads the org + member
   * count under `withSystemContext`. Gated twice: off-cloud there is no billing
   * (no-op), and only an org whose `scaledTrackerSubscription.status === 'active'`
   * has seats to bill (every other org is a no-op — the read is cheap).
   *
   * The quantity is the recomputed count read HERE, at run time — an ABSOLUTE
   * target, never a delta. Combined with the endpoint's idempotent skip-if-equal,
   * this makes the sync converge with no drift under concurrent membership writes
   * (rapid adds can't double-count: each job re-derives the live committed count,
   * and the last membership change's job always reads the final count) AND makes
   * this method itself the reconcile primitive — re-running it re-derives truth.
   */
  async syncScaledTrackerSeatQuantity(organizationId: string): Promise<SeatQuantityResult> {
    // Off-cloud there is no billing at all — nothing to bill is the honest shape.
    if (!isCloudBilling()) return { applied: false, outcome: 'no_active_tracker_subscription' };

    const { isScaledActive, memberCount } = await withSystemContext(async (tx) => {
      const org = await organizationRepository.findByIdInTx(organizationId, tx);
      const scaled = (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;
      const count = await organizationMembershipRepository.countByOrg(organizationId, tx);
      return { isScaledActive: scaled?.status === 'active', memberCount: count };
    });

    // Only an active scaled-tracker org has seats to bill; everything else is a
    // benign no-op (a free org, a past_due/canceled one — its caps are already
    // handled by the webhook flag, not the seat count).
    if (!isScaledActive) return { applied: false, outcome: 'no_active_tracker_subscription' };

    return setSeatQuantity({ coreOrganizationId: organizationId, quantity: memberCount });
  },
};

// Resolve the active workspace's organization id — RLS-aware (the workspace
// policy admits the self-read under the non-bypass app role). Mirrors
// aiChatService.resolveOrganizationId so the AI paywall reads the SAME org the
// AI jobs are metered against.
async function resolveOrganizationId(actorUserId: string, workspaceId: string): Promise<string> {
  return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
    const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
    if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
    return workspace.organizationId;
  });
}

// The "no paywall here" entitlement — a self-host build (or any non-cloud
// context). Every flag is inert so the client renders nothing.
function notApplicableAiAccess(): AiAccessDTO {
  return {
    applicable: false,
    organizationId: null,
    organizationName: null,
    canManageBilling: false,
    hasPaidAiPlan: false,
    balance: 0,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
  };
}
