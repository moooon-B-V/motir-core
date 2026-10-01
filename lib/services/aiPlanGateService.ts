import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { getOrgSubscription } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';

// THE PAID-AI-PLAN GATE (Story MOTIR-6906 · MOTIR-6909) —
// `docs/decisions/fleet-per-org-pool.md`: the fleet is paid-AI-plan only.
//
// ONE question, asked at every door that spends Motir's fleet: *does this
// organisation hold a paid monthly AI plan?* Motir Studio asks it before it
// creates a hosted repository (`projectRepoProvisioningService.establishSet`), and
// fleet admission asks it before it counts the org's pool (the CI, index and
// hosted-agent gates). The agent lane's create and wake (MOTIR-6918) ask it too,
// which is why the answer for Motir's own organisations is decided HERE, once.
//
// ── THE THREE ANSWERS ───────────────────────────────────────────────────────
//   `true`      — a paid plan: a Stripe subscription whose status grants the
//                 monthly allotment (`PAID_AI_SUBSCRIPTION_STATUSES`), OR one of
//                 Motir's own organisations (below), OR a self-hosted build, which
//                 has no billing at all (`isCloudBilling`, ADR billing-tiering §6).
//   `false`     — no paid plan. The doors refuse `ai_plan_required`.
//   `'unknown'` — the plan could not be read (motir-ai unreachable, or the org
//                 row). The doors refuse too — `plan_unknown` at establish, a
//                 deferral at admission — and NEVER fall through: a guessed "yes"
//                 is a free fleet for whoever motir-ai cannot see.
//
// ⚠️ MOTIR'S OWN ORGANISATIONS PASS WITHOUT A REMOTE READ. `isMeta` (moooon B.V.)
// and `internalBilling` (an internal org) are answered `true` from the org's own
// row, BEFORE motir-ai is asked — so neither is ever refused, and neither can be
// failed closed by an unreachable motir-ai (the product owner, 2026-09-29: "meta
// org and internal org have no limit", MOTIR-6902). Neither flag gains a meaning
// here: `isMeta` is already exempt from the AI paywall (`hasAiEntitlement`), and
// `internalBilling` orgs are charged like customers and offset
// (`internal-billing-classification.md`). This gate only reads them.

/**
 * A paid Motir AI plan = a live Stripe subscription that grants the monthly
 * allotment (billing decision §5). `trialing` (the one-time free grant),
 * `canceled` (dropped to free) and "no subscription" are NOT paid.
 *
 * The ONE copy of this list. `billingService.getAiAccess` derives its
 * `hasPaidAiPlan` through {@link isPaidAiSubscriptionStatus} so the panel and the
 * fleet can never disagree about who has paid.
 */
const PAID_AI_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'past_due']);

export function isPaidAiSubscriptionStatus(status: string | null): boolean {
  return status !== null && PAID_AI_SUBSCRIPTION_STATUSES.has(status);
}

export type PaidAiPlanAnswer = boolean | 'unknown';

/**
 * How long one answer is reused. Admission asks per container, and a burst of
 * one org's CI is hundreds of containers in seconds, so without a cache every one
 * of them would pay a round trip to motir-ai for an answer that changes when a
 * person buys or cancels a plan. Short, so a lapse takes effect within a minute;
 * `'unknown'` is never cached, so recovery is immediate.
 */
const PLAN_CACHE_TTL_MS = 30_000;

const planCache = new Map<string, { answer: boolean; expiresAt: number }>();

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const aiPlanGateService = {
  /** Does this organisation hold a paid monthly AI plan? See the module header
   *  for the three answers. Never throws. */
  async hasPaidAiPlan(organizationId: string): Promise<PaidAiPlanAnswer> {
    if (!isCloudBilling()) return true;

    const cached = planCache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.answer;

    // Motir's own organisations, from their own row — before any remote read.
    let exempt: boolean;
    try {
      const org = await withOrgServiceWriteContext(organizationId, (tx) =>
        organizationRepository.findByIdInTx(organizationId, tx),
      );
      if (!org) {
        console.error('[aiPlanGateService] the organization row could not be found', {
          organizationId,
        });
        return 'unknown';
      }
      exempt = org.isMeta || org.internalBilling;
    } catch (err) {
      console.error('[aiPlanGateService] could not read the organization', {
        organizationId,
        detail: detailOf(err),
      });
      return 'unknown';
    }
    if (exempt) return remember(organizationId, true);

    try {
      const subscription = await getOrgSubscription({ coreOrganizationId: organizationId });
      return remember(organizationId, isPaidAiSubscriptionStatus(subscription.status));
    } catch (err) {
      console.error('[aiPlanGateService] could not read the AI plan — refusing (fail-closed)', {
        organizationId,
        detail: detailOf(err),
      });
      return 'unknown';
    }
  },
};

function remember(organizationId: string, answer: boolean): boolean {
  planCache.set(organizationId, { answer, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
  return answer;
}

/** Test seam: forget every cached answer. */
export function _resetAiPlanCache(): void {
  planCache.clear();
}

/** The words each door's refusal carries (`fleet-per-org-pool.md` §4). */
export const AI_PLAN_REQUIRED_ESTABLISH_MESSAGE =
  'Motir-hosted repositories need a paid AI plan (Standard, Pro, Max or Enterprise). Upgrade your AI plan to create one here.';
export const AI_PLAN_REQUIRED_ADMISSION_DETAIL =
  "This organization has no paid AI plan, so its CI does not run on Motir's runners.";
export const PLAN_UNKNOWN_ESTABLISH_MESSAGE =
  "Motir could not read this organization's AI plan just now, so no repository was created. Try again in a moment.";
export const PLAN_UNKNOWN_ADMISSION_DETAIL =
  "Motir could not read this organization's AI plan, so the job waits until it can.";
