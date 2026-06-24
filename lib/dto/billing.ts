import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { BillingCatalog } from '@/lib/billing/catalog';

// DTOs for the billing surfaces (Story 8.1). Defines EXACTLY what crosses the
// HTTP boundary — no Prisma model leaks. The inbound propagation route returns
// the confirmation DTO so motir-ai's coreClient (8.1.4d) can read back the
// persisted state; the org-facing billing status DTO feeds the 8.1.7 settings
// panel + storefront.

export interface ScaledTrackerStateDTO {
  organizationId: string;
  /** The persisted state, or `null` when no scaled-tracker subscription is set. */
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}

/** Confirmation of the AI-included-seat propagation (8.1.24 receiver). */
export interface AiIncludedSeatDTO {
  organizationId: string;
  aiIncludedSeat: boolean;
}

// ── The org-facing billing status (Story 8.1.6 → renders in 8.1.7) ──────────

/** What the actor may DO with billing (ADR §7: view = owner/admin, mutate = owner). */
export interface BillingAccessDTO {
  /** The actor's org role. */
  role: 'owner' | 'admin' | 'member';
  /** True only for an org OWNER — may start checkout / open portal / change plan. */
  canManageBilling: boolean;
}

/**
 * The Motir AI Stripe SUBSCRIPTION lifecycle (Subtask 8.1.13) — what the design's
 * panel 2 status `Pill` + panel 5 "renews {date}" render. Folded from motir-ai's
 * `GET /v1/stripe/subscription`. EVERY field is nullable: a free / never-transacted
 * org has `status: null` (no AI subscription yet), NOT an error.
 */
export interface MotirAiSubscriptionDTO {
  /** The Stripe subscription lifecycle (decision §5), or `null` = no subscription. */
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | null;
  /** ISO-8601 renewal date ("renews {date}"), or `null` before a period is known. */
  currentPeriodEnd: string | null;
  /** The subscribed Stripe Price, or `null`. */
  priceId: string | null;
  /** The tier the subscription resolves to, or `null` until the webhook binds one. */
  planTier: { key: string; name: string; monthlyCreditAllotment: number } | null;
}

/**
 * ② The Motir AI line — the org's AI plan over the boundary: the `PlanTier` +
 * balance folded from the `/v1/usage` read, plus the Stripe `subscription`
 * lifecycle (status `Pill` + renewal date, design panels 2/5) folded from the
 * 8.1.13 `/v1/stripe/subscription` read.
 */
export interface MotirAiBillingDTO {
  /** The active AI tier, or `null` before any ledger is provisioned. */
  tier: { key: string; name: string; monthlyCreditAllotment: number } | null;
  /** The current credit balance (allotment remainder + any top-up). */
  balance: number;
  /** The Stripe AI-subscription lifecycle (status + renewal); `status: null` = none. */
  subscription: MotirAiSubscriptionDTO;
}

/**
 * The org's billing status — the two billed lines + the catalog + access, cloud
 * only. The Motir (seat) line is the LOCAL scaled-tracker subscription (full
 * status + period end, read from the Organization); the Motir AI line is the
 * tier/balance from the usage read; `catalog` is the storefront's price list.
 */
export interface BillingStatusDTO {
  organizationId: string;
  access: BillingAccessDTO;
  /** The META org (moooon B.V.) — internal, unlimited, never billed. When true the
   *  page renders the "Internal plan" state instead of the storefront (no upgrade
   *  / checkout CTAs); the two billed lines below are not meaningful for it. */
  isMeta: boolean;
  /** ① Motir (seats): the scaled-tracker subscription, or `null` = free/unscaled. */
  motir: { scaledTrackerSubscription: ScaledTrackerSubscription | null };
  /** ② Motir AI: the credit plan tier + balance. */
  motirAi: MotirAiBillingDTO;
  /** The purchasable prices the storefront renders + checkout routes through. */
  catalog: BillingCatalog;
}

/** A started Stripe session — the hosted URL the client redirects to. */
export interface BillingSessionDTO {
  url: string;
}

/**
 * The members-page SEAT summary (Story 8.1.14, design/org-admin
 * members-billing) — the in-context seat/billing layer the org Members admin
 * renders for a SCALED org. `null` (the service returns it, not this shape)
 * means NO seat UI: a self-host build (`MOTIR_CLOUD` off), a free org (no
 * scaled-tracker subscription), or a canceled one — the members page is
 * UNCHANGED. This card RENDERS the seat state; it never writes Stripe (8.1.12
 * owns the seat-quantity sync). The seat COUNT is the org membership count, read
 * client-side from the roster total (the same source 8.1.12 syncs to Stripe), so
 * it tracks add/remove live; this DTO carries only the pricing + lifecycle the
 * count is priced against.
 */
export interface SeatSummaryDTO {
  /** Scaled-tracker lifecycle — only `active` / `past_due` reach the UI (a
   *  `canceled`/absent subscription resolves to `null`, the unchanged page). */
  status: 'active' | 'past_due';
  /** Billing cadence, derived from the subscription's `tracker_*` price id. */
  cadence: 'monthly' | 'annual';
  /** Per-seat fee for the active cadence (whole USD), from `BILLING_CATALOG`. */
  perSeatUsd: number;
  /** The monthly per-seat fee — feeds the "annual saves $X/yr" figure. */
  monthlyPerSeatUsd: number;
  /** The annual per-seat fee. */
  annualPerSeatUsd: number;
  /** Stripe `current_period_end` (unix epoch SECONDS) — the renewal the
   *  prorated add-charge / remove-credit copy targets. */
  currentPeriodEnd: number;
  /** True only for an org OWNER — may manage the seat plan (ADR §7). An admin
   *  manages membership but sees the seat band READ-ONLY (no manage CTA). */
  canManageBilling: boolean;
}
