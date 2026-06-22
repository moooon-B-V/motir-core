// The Motir commercial catalog — the "available paid prices for the UI" half of
// the billing surface (Story 8.1.6). Grounded ONE-TO-ONE in
// `docs/decisions/billing-tiering.md` §2/§3 (the locked tiering ADR) and the
// `design/billing/` panel-5 storefront. This is pure DISPLAY + CHECKOUT-routing
// config: it names each purchasable line, its USD price, and the Stripe price
// LOOKUP KEY the UI hands back to `startCheckout`. NO Stripe secret, no SDK — the
// open-core invariant (Stripe lives only in motir-ai).
//
// ── The lookup-key → Stripe `price_…` SEAM (read before wiring live checkout) ──
// The fields below carry the stable Stripe price LOOKUP KEYS (`pro_pool_annual`,
// `tracker_monthly`, …), the same identifiers `lib/billing/scaledTrackerState.ts`
// and the 8.1.4b webhook key off. The 8.1.5 motir-ai checkout endpoint, however,
// passes its `priceId` STRAIGHT into Stripe `line_items[].price`, which requires a
// concrete `price_…` id (contract.md §2.4 shows `"priceId": "price_123"`). The
// real `price_…` ids were provisioned in the Stripe sandbox (8.1.2 / MOTIR-1141)
// but are not recorded in code. So for LIVE checkout one of two things must hold,
// and is tracked as a seam (see the PR / the 8.1.5-side follow-up): EITHER the
// motir-ai checkout resolves a lookup key → Price (`prices.list({ lookup_keys })`),
// OR these keys are mapped to the sandbox `price_…` ids via config. Until then the
// lookup keys are the durable, catalog-stable identifier the rest of 8.1 uses.

export type BillingCadence = 'monthly' | 'annual';

/** One cadence's price point — the USD fee + the Stripe price lookup key. */
export interface CatalogPrice {
  /** Whole-USD recurring fee for this cadence (annual = the yearly total). */
  amountUsd: number;
  /** The Stripe price lookup key the UI hands to `startCheckout` (see the seam note). */
  priceLookupKey: string;
}

/** A Motir AI plan tier (the motir-ai `PlanTier`) as the storefront renders it. */
export interface AiPlanCatalogEntry {
  /** The `PlanTier.key` (matches the usage read's `tier.key`). */
  key: 'free' | 'starter' | 'standard' | 'pro' | 'max' | 'enterprise';
  /** Customer-facing name ("Starter", "Pro", …). */
  name: string;
  /** Monthly credit allotment for the tier (ADR §2). */
  monthlyCredits: number | null;
  /** The recommended/anchor tier (Pro) — accent-bordered in the storefront. */
  recommended: boolean;
  /**
   * The recurring prices, keyed by cadence. `null` for plans with no Stripe
   * object: Free (the one-time signup grant) and Enterprise (custom/invoiced).
   */
  prices: Record<BillingCadence, CatalogPrice> | null;
}

/** The Motir (seats / scaled-tracker) plan — per-seat, billed by membership count. */
export interface SeatPlanCatalogEntry {
  name: string;
  /** Per-seat prices by cadence (the `tracker_*` lookup keys). */
  prices: Record<BillingCadence, CatalogPrice>;
}

/** The one-time credit top-up bundle (`creditService.topUp`, `mode: 'payment'`). */
export interface CreditTopupCatalogEntry {
  /** Credits granted per purchased unit. */
  unitCredits: number;
  /** USD price per unit. */
  unitAmountUsd: number;
  priceLookupKey: string;
}

export interface BillingCatalog {
  /** ② Motir AI — the credit-plan ladder (ADR §2/§3). */
  aiPlans: AiPlanCatalogEntry[];
  /** ① Motir — the per-seat scaled-tracker plan (ADR §3). */
  seatPlan: SeatPlanCatalogEntry;
  /** The pay-as-you-go credit top-up (ADR §3). */
  creditTopup: CreditTopupCatalogEntry;
}

// The v1 catalog — the exact §3 numbers (USD; v1 seed values per the
// ModelCreditRate stance — tunable without a code change). Annual is the yearly
// total (~33% off the 12× monthly), the Stripe annual-default.
export const BILLING_CATALOG: BillingCatalog = {
  aiPlans: [
    { key: 'free', name: 'Free', monthlyCredits: 300, recommended: false, prices: null },
    {
      key: 'starter',
      name: 'Starter',
      monthlyCredits: 300,
      recommended: false,
      prices: {
        monthly: { amountUsd: 5, priceLookupKey: 'starter_pool_monthly' },
        annual: { amountUsd: 40, priceLookupKey: 'starter_pool_annual' },
      },
    },
    {
      key: 'standard',
      name: 'Standard',
      monthlyCredits: 2000,
      recommended: false,
      prices: {
        monthly: { amountUsd: 25, priceLookupKey: 'standard_pool_monthly' },
        annual: { amountUsd: 200, priceLookupKey: 'standard_pool_annual' },
      },
    },
    {
      key: 'pro',
      name: 'Pro',
      monthlyCredits: 8000,
      recommended: true, // the anchor tier; pro_pool_annual is Stripe's default Price
      prices: {
        monthly: { amountUsd: 75, priceLookupKey: 'pro_pool_monthly' },
        annual: { amountUsd: 600, priceLookupKey: 'pro_pool_annual' },
      },
    },
    {
      key: 'max',
      name: 'Max',
      monthlyCredits: 30000,
      recommended: false,
      prices: {
        monthly: { amountUsd: 150, priceLookupKey: 'max_pool_monthly' },
        annual: { amountUsd: 1200, priceLookupKey: 'max_pool_annual' },
      },
    },
    // Enterprise — custom/invoiced, no public Stripe object (tier set by staff).
    {
      key: 'enterprise',
      name: 'Enterprise',
      monthlyCredits: null,
      recommended: false,
      prices: null,
    },
  ],
  seatPlan: {
    name: 'Motir',
    prices: {
      monthly: { amountUsd: 5, priceLookupKey: 'tracker_monthly' },
      annual: { amountUsd: 40, priceLookupKey: 'tracker_annual' },
    },
  },
  creditTopup: { unitCredits: 1000, unitAmountUsd: 10, priceLookupKey: 'credit_topup' },
};

// Every lookup key a Checkout may legitimately start — the allow-list
// `startCheckout` validates against, so the boundary never forwards an arbitrary
// (or stale) price the UI didn't get from this catalog.
export const CHECKOUT_PRICE_LOOKUP_KEYS: ReadonlySet<string> = new Set<string>([
  ...BILLING_CATALOG.aiPlans.flatMap((p) =>
    p.prices ? [p.prices.monthly.priceLookupKey, p.prices.annual.priceLookupKey] : [],
  ),
  BILLING_CATALOG.seatPlan.prices.monthly.priceLookupKey,
  BILLING_CATALOG.seatPlan.prices.annual.priceLookupKey,
  BILLING_CATALOG.creditTopup.priceLookupKey,
]);

/** True when `key` is a price the catalog offers (the checkout allow-list). */
export function isKnownCheckoutPrice(key: string): boolean {
  return CHECKOUT_PRICE_LOOKUP_KEYS.has(key);
}
