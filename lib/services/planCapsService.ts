import { capsForPlanKey, type PlanCaps } from '@/lib/billing/planCaps';
import { _resetOrgPlanCache, readOrgPlan } from '@/lib/services/orgPlanReader';

// THE PLAN-CAPS LOOKUP (Story MOTIR-9363 · MOTIR-9372) — ONE call answers what an
// organisation's AI plan lets it run on Motir's fleets at once. The figures are
// `lib/billing/planCaps.ts`'s; the direction they come from is the fleet-capacity
// decision record MOTIR-9357, which replaces `fleet-per-org-pool.md` §2's flat
// 500-container pool with per-plan figures.
//
// The read is the paid-plan gate's (`orgPlanReader`): exempt before any remote
// read, 30-second cache, `unknown` never cached. Whether the org may spend at all
// stays the GATE's question, asked first by every door; this answers only HOW
// MUCH. So a canceled subscription whose `planTier` is still present still yields
// its figures, and the gate refuses it first.
//
// The answer is a discriminated union, so no caller can read a number without
// first handling the two non-numeric cases:
//   * `capped`       — the plan's four figures, and `planName` as motir-ai sends
//                      it, which is what a refusal or a deferral names.
//   * `exempt`       — Motir's own organisations, and a build with no billing.
//   * `plan_unknown` — FAIL CLOSED: the org row, the subscription or its plan
//                      tier could not be read, or the key has no row. The key is
//                      CARRIED, never replaced by a plausible default.

export type PlanCapsAnswer =
  | { kind: 'capped'; planKey: string; planName: string; caps: PlanCaps }
  | { kind: 'exempt' }
  | { kind: 'plan_unknown'; planKey: string | null };

export const planCapsService = {
  /** What this organisation's plan lets it run at once. Never throws. */
  async capsFor(organizationId: string): Promise<PlanCapsAnswer> {
    const read = await readOrgPlan(organizationId);
    if (read.kind === 'exempt') return { kind: 'exempt' };
    if (read.kind === 'unknown') return { kind: 'plan_unknown', planKey: null };

    const tier = read.subscription.planTier;
    if (!tier) return { kind: 'plan_unknown', planKey: null };
    const caps = capsForPlanKey(tier.key);
    if (!caps) {
      console.error('[planCapsService] the plan key has no caps row — refusing (fail-closed)', {
        organizationId,
        planKey: tier.key,
      });
      return { kind: 'plan_unknown', planKey: tier.key };
    }
    return { kind: 'capped', planKey: tier.key, planName: tier.name, caps };
  },
};

/** Test seam: forget every cached read (shared with the paid-plan gate). */
export function _resetPlanCapsCache(): void {
  _resetOrgPlanCache();
}
