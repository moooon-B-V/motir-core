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

// ── The org-facing billing status (Story 8.1.6 → renders in 8.1.7) ──────────

/** What the actor may DO with billing (ADR §7: view = owner/admin, mutate = owner). */
export interface BillingAccessDTO {
  /** The actor's org role. */
  role: 'owner' | 'admin' | 'member';
  /** True only for an org OWNER — may start checkout / open portal / change plan. */
  canManageBilling: boolean;
}

/**
 * ② The Motir AI line — the org's AI plan as the boundary can read it TODAY: the
 * `PlanTier` + balance, folded from the existing `/v1/usage` read (the 8.1.6 card's
 * blessed "fold subscription/tier into the usage read" path). The Stripe AI
 * SUBSCRIPTION lifecycle (status `Pill` + renewal date the design panel 2/5 want)
 * needs a motir-ai subscription-READ endpoint that 8.1.5 did not ship — tracked as
 * a seam (the 8.1.7 follow-up), so this DTO carries the tier+balance, not those.
 */
export interface MotirAiBillingDTO {
  /** The active AI tier, or `null` before any ledger is provisioned. */
  tier: { key: string; name: string; monthlyCreditAllotment: number } | null;
  /** The current credit balance (allotment remainder + any top-up). */
  balance: number;
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
