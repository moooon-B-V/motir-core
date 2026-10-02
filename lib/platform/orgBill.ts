import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';

/**
 * THIS MONTH'S BILL for the operator's read-only Billing tab (Story MOTIR-727 ·
 * MOTIR-7289, design D9) — composed from the same status the tenant's own billing
 * page reads, so the two never disagree.
 *
 * Two kinds of line, kept apart on purpose:
 *   - MONEY lines — what Stripe charges on the recurring invoice: the Motir seats
 *     (members × the catalog seat price for the subscription's cadence) and the
 *     Motir AI plan fee (the tier's catalog price for its cadence). They sum to the
 *     total, in integer CENTS, so no float ever reaches a money figure.
 *   - CREDIT lines — CI past the pool, web search and agents: spend DRAWN FROM the
 *     credit pool, not a separate charge. Shown in credits, never added to the money
 *     total (a credit was already paid for when it was bought).
 */

export interface OrgBillMoneyLine {
  key: 'seats' | 'aiPlan';
  /** e.g. `{ seats: 48, unitCents: 500, cadence: 'monthly' }`. */
  basis: { seats?: number; credits?: number; unitCents?: number; cadence: 'monthly' | 'annual' };
  amountCents: number;
}

export interface OrgBillCreditLine {
  key: 'ci' | 'search' | 'agents';
  /** Null when the figure could not be read — never a zero. */
  credits: number | null;
}

export interface OrgBill {
  money: OrgBillMoneyLine[];
  credits: OrgBillCreditLine[];
  totalCents: number;
  /** ISO — the next recurring charge, the earliest renewal among the money lines. */
  chargeDate: string | null;
}

const cents = (usd: number) => Math.round(usd * 100);

function aiCadence(priceId: string | null): 'monthly' | 'annual' | null {
  if (!priceId) return null;
  for (const plan of BILLING_CATALOG.aiPlans) {
    if (!plan.prices) continue;
    if (plan.prices.monthly.priceLookupKey === priceId) return 'monthly';
    if (plan.prices.annual.priceLookupKey === priceId) return 'annual';
  }
  return /annual/.test(priceId) ? 'annual' : /monthly/.test(priceId) ? 'monthly' : null;
}

export function buildOrgBill(
  status: Omit<BillingStatusDTO, 'access'>,
  memberCount: number,
): OrgBill {
  const money: OrgBillMoneyLine[] = [];
  const renewals: string[] = [];

  const tracker = status.motir.scaledTrackerSubscription;
  if (tracker && (tracker.status === 'active' || tracker.status === 'past_due')) {
    const cadence = tracker.priceId === 'tracker_annual' ? 'annual' : 'monthly';
    const unitCents = cents(BILLING_CATALOG.seatPlan.prices[cadence].amountUsd);
    // A paid AI plan bundles one seat (8.1.22): it is not billed again here.
    const seats = Math.max(0, memberCount - (status.motir.aiIncludedSeat ? 1 : 0));
    money.push({
      key: 'seats',
      basis: { seats, unitCents, cadence },
      amountCents: seats * unitCents,
    });
    renewals.push(new Date(tracker.currentPeriodEnd * 1000).toISOString());
  }

  const sub = status.motirAi.subscription;
  const tierKey = sub.planTier?.key ?? status.motirAi.tier?.key ?? null;
  const plan = BILLING_CATALOG.aiPlans.find((p) => p.key === tierKey);
  const cadence = aiCadence(sub.priceId);
  if (
    plan?.prices &&
    cadence &&
    (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due')
  ) {
    money.push({
      key: 'aiPlan',
      basis: { credits: plan.allotment?.credits, cadence },
      amountCents: cents(plan.prices[cadence].amountUsd),
    });
    if (sub.currentPeriodEnd) renewals.push(sub.currentPeriodEnd);
  }

  const agents = status.agents.spend;
  return {
    money,
    credits: [
      { key: 'ci', credits: status.ci.chargedCredits ?? null },
      { key: 'search', credits: status.search ? status.search.monthSpend : null },
      {
        key: 'agents',
        credits: agents ? agents.machineMonthSpend + agents.storageMonthSpend : null,
      },
    ],
    totalCents: money.reduce((sum, l) => sum + l.amountCents, 0),
    chargeDate: renewals.sort()[0] ?? null,
  };
}
