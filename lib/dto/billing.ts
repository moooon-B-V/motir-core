import { z } from 'zod';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { BillingCatalog } from '@/lib/billing/catalog';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import type { SearchSpendDTO } from '@/lib/dto/aiUsage';

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
  /** The META org (moooon B.V.) — internal, never billed, every cap lifted.
   *
   *  ⚠️ WHAT IT DRIVES, as of MOTIR-4818: the EXEMPT variant of each of panel 2's
   *  two lines — the `.pill-exempt` chip and its banner in place of the tier
   *  chip, the caps block, the seat calculator and both checkout CTAs. It does
   *  NOT suppress the page: an org with `isMeta: false` — paying, free, OR
   *  `internalBilling` — renders the storefront unchanged
   *  (`design/billing/design-notes.md` § AMENDMENT 2026-09-07).
   *
   *  It used to say the page renders an "Internal plan" state INSTEAD of the
   *  storefront. That early return was deleted by MOTIR-4572 and the sentence
   *  outlived it — which is how a reader arrives at the wrong fix. */
  isMeta: boolean;
  /** Whether the org is charged exactly like a CUSTOMER and then made whole —
   *  every debit lands and is paired, in the same transaction, with an
   *  offsetting credit (`Organization.internalBilling`, MOTIR-4565;
   *  `docs/decisions/internal-billing-classification.md` §2).
   *
   *  ⚠️ IT CHANGES NO FIGURE ON THIS DTO, and that is the whole point. Every
   *  line, every state and every number above and below is computed exactly as
   *  it is for a paying org — this field says only WHICH KIND of org the reader
   *  is looking at, so the surface can draw a chip. It is a second field beside
   *  `isMeta` rather than a widening of it because the two mean opposite things:
   *  that one suppresses, this one charges and credits. */
  internalBilling: boolean;
  /** ① Motir (seats): the scaled-tracker subscription, or `null` = free/unscaled. */
  motir: {
    scaledTrackerSubscription: ScaledTrackerSubscription | null;
    /** True when a PAID Motir AI plan bundles 1 Motir seat → caps lifted, first
     *  seat included (8.1.22). The SeatsView surfaces the included seat from this. */
    aiIncludedSeat: boolean;
  };
  /** ② Motir AI: the credit plan tier + balance. */
  motirAi: MotirAiBillingDTO;
  /**
   * ③ Motir CI (MOTIR-1903, ADR `ci-minutes-allowance.md` §7.1): the CI-minutes
   * entitlement — used vs included this period, how the pool was derived, the
   * reset date, and the credits the overage drew, DISTINCT from AI's spend.
   *
   * NOT nullable, and deliberately so. `ciAllowanceService.getEntitlementState`
   * already models "no CI here" as a real value (`applicable: false`,
   * `state: 'bypassed'` — off-cloud, no provisioning org, or the META org), so
   * the panel switches on a field that is always present. An optional field
   * would invite the always-null wiring that renders nothing while every test
   * stays green.
   */
  ci: CiEntitlementStateDTO;
  /**
   * ④ Motir Search (MOTIR-4334, `motir-gateway` `docs/decisions/motir-search-channel.md`
   * §4.4 · motir-ai `docs/credit-model.md` §4b): the FOURTH billed line — what the
   * org has spent on web search, DISTINCT from AI's spend and from CI's.
   *
   * It comes off the `getOrgUsage` call this service ALREADY makes, so there is no
   * second request; `usage.balance` and `usage.tier` above come from the same read.
   *
   * ⚠️ NULLABLE, and for the OPPOSITE reason `ci` is not. `ci` is not nullable
   * because `ciAllowanceState` models "no CI here" as a real value. Search has no
   * such state to model — §5 of the ADR decides an out-of-credit org goes into
   * overdraft and search refuses nothing, so there is no paused, bypassed or
   * not-applicable arm to carry. What CAN happen is the boundary not reporting the
   * block at all (a rolling deploy), and `null` is exactly that: FIGURES
   * UNAVAILABLE, never zero spend. The panel must render the two differently.
   */
  search: SearchSpendDTO | null;
  /**
   * The Agents line (MOTIR-6920, `docs/decisions/agent-instance-storage.md` §6,
   * `design/billing/design-notes.md` "Delta 2026-09-29"): this month's machine
   * and storage credits for the org's agents, off the same `getOrgUsage` read.
   */
  agents: AgentsBillingDTO;
  /** The purchasable prices the storefront renders + checkout routes through. */
  catalog: BillingCatalog;
}

/** This month's agent credits, by kind. */
export interface AgentSpendDTO {
  machineMonthSpend: number;
  storageMonthSpend: number;
}

export interface AgentsBillingDTO {
  /**
   * `null` = FIGURES UNAVAILABLE (the boundary did not report `agentMachine` /
   * `agentStorage`), never zero spend — the `search` rule, applied here.
   */
  spend: AgentSpendDTO | null;
  /**
   * Whether the org may run agents at all: a paid AI plan (`active` /
   * `past_due`), or a meta / internal-billing org, which §5 of the record lets
   * through the agent limits. False draws the "Agents need a paid AI plan" note.
   */
  hasPaidAiPlan: boolean;
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

// ── Enterprise requests (Story MOTIR-7602 · Subtask MOTIR-7605) ─────────────
//
// What the Enterprise card's Contact-sales form sends, and the org's view of the
// request it sent. The value lists are RUNTIME constants so the form can render
// its choices without importing the Prisma client, and the input schema below
// refuses anything outside them.

export const ENTERPRISE_AGENT_PATHS = ['hosted', 'own', 'both'] as const;
export const ENTERPRISE_AUTONOMIES = ['autonomous_lead', 'volume_only', 'unsure'] as const;
export const ENTERPRISE_START_WHENS = [
  'now',
  'within_month',
  'within_quarter',
  'exploring',
] as const;
export const ENTERPRISE_TEAM_SIZES = [
  'size_1_10',
  'size_11_50',
  'size_51_200',
  'size_201_plus',
] as const;

export type EnterpriseAgentPathValue = (typeof ENTERPRISE_AGENT_PATHS)[number];
export type EnterpriseAutonomyValue = (typeof ENTERPRISE_AUTONOMIES)[number];
export type EnterpriseStartWhenValue = (typeof ENTERPRISE_START_WHENS)[number];
export type EnterpriseTeamSizeValue = (typeof ENTERPRISE_TEAM_SIZES)[number];

/** Upper bounds on the free-form answers — generous, but not unbounded. */
export const ENTERPRISE_REQUEST_LIMITS = {
  maxCardsPerDay: 100_000,
  maxParallelAgents: 10_000,
  maxContactLength: 320,
  maxNoteLength: 4_000,
} as const;

const optionalCount = (max: number) => z.number().int().min(1).max(max).nullable().optional();

/**
 * The Contact-sales body. Every answer is optional EXCEPT the note; an enum
 * answer outside its set, a non-integer or out-of-range count, or an empty note
 * is refused. `contact` absent or blank means "use my account email" — the
 * service fills it in.
 */
export const enterpriseRequestInputSchema = z
  .object({
    cardsPerDay: optionalCount(ENTERPRISE_REQUEST_LIMITS.maxCardsPerDay),
    parallelAgents: optionalCount(ENTERPRISE_REQUEST_LIMITS.maxParallelAgents),
    agentPath: z.enum(ENTERPRISE_AGENT_PATHS).nullable().optional(),
    autonomy: z.enum(ENTERPRISE_AUTONOMIES).nullable().optional(),
    startWhen: z.enum(ENTERPRISE_START_WHENS).nullable().optional(),
    teamSize: z.enum(ENTERPRISE_TEAM_SIZES).nullable().optional(),
    contact: z
      .string()
      .trim()
      .max(ENTERPRISE_REQUEST_LIMITS.maxContactLength)
      .nullable()
      .optional(),
    note: z.string().trim().min(1).max(ENTERPRISE_REQUEST_LIMITS.maxNoteLength),
  })
  .strict();

export type EnterpriseRequestInput = z.infer<typeof enterpriseRequestInputSchema>;

/**
 * Where an open request stands, in the org's words. Staff's `new` reads
 * "received" and `contacted` "in conversation"; the org never sees `won` /
 * `lost` as such — a closed request is simply no longer open.
 */
export type EnterpriseRequestOrgStatus = 'received' | 'in_conversation' | 'offer_sent' | 'closed';

/** The org-visible view of one Enterprise request. No price, ever. */
export interface EnterpriseRequestDTO {
  id: string;
  status: EnterpriseRequestOrgStatus;
  /** ISO-8601. */
  createdAt: string;
  cardsPerDay: number | null;
  parallelAgents: number | null;
  agentPath: EnterpriseAgentPathValue | null;
  autonomy: EnterpriseAutonomyValue | null;
  startWhen: EnterpriseStartWhenValue | null;
  teamSize: EnterpriseTeamSizeValue | null;
  contact: string;
  note: string;
  /** Who sent it, as the org reads it (the user's name, else their email);
   *  null once the sender's account is gone. The read-only view's "by …". */
  requestedByName: string | null;
}

/**
 * What the Contact-sales form shows read-only beside the person's answers
 * (MOTIR-7607): read server-side, never trusted from the client. `null` from
 * the service when the viewer cannot send a request (off-cloud, or no
 * `manageBilling`), so the page passes nothing for the form to show.
 */
export interface EnterpriseRequestFormContextDTO {
  /** The org's connected repositories — `project_repository` rows across its workspaces. */
  repositoryCount: number;
}
