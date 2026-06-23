// The MINIMAL, member-safe AI entitlement read that drives the AI-boundary
// paywall (Subtask 8.1.8). It is deliberately DISTINCT from the owner/admin-gated
// `BillingStatusDTO` (8.1.6): the paywall must render its right variant for EVERY
// org member — including a plain member who gets the "ask an owner" state — so
// this carries only what the upsell needs (is AI blocked, can the actor buy, is
// it a paid plan or a never-bought tier-gate, the org name + tier for the copy),
// never the financial detail (payment method, invoices, catalog) the settings
// panel shows.
export interface AiAccessDTO {
  /**
   * Whether the paywall applies AT ALL. False on a self-hosted build (no
   * `MOTIR_CLOUD` → AI is reached via the self-hoster's own connection, never
   * metered) and when there is no resolvable org context. When false the paywall
   * never renders, whatever else this carries.
   */
  applicable: boolean;
  /** The org the upsell acts on (copy + the upgrade link); null when !applicable. */
  organizationId: string | null;
  /** The org's display name for the paywall copy ("The {org} organization …"). */
  organizationName: string | null;
  /**
   * True only for an org OWNER — may start checkout / change plan. Drives the
   * owner ("Upgrade") vs member ("ask your owner") paywall variant (ADR §7).
   */
  canManageBilling: boolean;
  /**
   * The org holds a PAID Motir AI plan (Stripe `active` / `past_due`). Splits the
   * "out of credits" paywall (paid plan, allotment exhausted) from the tier-gate
   * (never bought AI). `trialing` / `canceled` / none are NOT paid.
   */
  hasPaidAiPlan: boolean;
  /** Current AI credit balance; ≤ 0 means AI is exhausted/unavailable right now. */
  balance: number;
  /** The active tier's display name (copy: "this month's {n} {tier} credits"). */
  tierName: string | null;
  /** The active tier's monthly allotment (copy: "all of this month's {n} credits"). */
  tierAllotment: number | null;
  /**
   * ISO-8601 date the allotment renews (the paid plan's Stripe period end), or
   * null when there is no paid subscription. Drives the out-of-credits "Renews
   * {date}" note (design panel 7a).
   */
  renewsAt: string | null;
}
