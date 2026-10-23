import { beforeEach, vi } from 'vitest';
import { _resetAiPlanCache, aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { planCapsService } from '@/lib/services/planCapsService';
import { capsForPlanKey } from '@/lib/billing/planCaps';
import { BILLING_CATALOG } from '@/lib/billing/catalog';

// MOTIR-6909 — the fleet is paid-AI-plan only, so on a cloud build every
// admission first asks motir-ai for the org's subscription. Suites that test the
// POOL, the METER or the CHARGE — not the plan — call `grantPaidAiPlan()` at file
// scope so their orgs hold a paid plan without each one faking the subscription
// read. The plan gate's own behaviour is tested in `tests/ciFleet/aiPlanGate.test.ts`.
//
// MOTIR-9373 — admission also reads the plan's FIGURES (`planCapsService`), so
// the same stub answers them: the named plan key's REAL row from
// `capsForPlanKey`, never an invented one. The default is Max ×2, the top of the
// ladder (5 hosted runs at once). The caps' own behaviour is tested in
// `tests/services/planCapsService.test.ts`.
//
// A `beforeEach`, not a one-off spy, because most of these suites run
// `vi.restoreAllMocks()` in an `afterEach`.
export function grantPaidAiPlan(planKey = 'max_x2'): void {
  beforeEach(() => stubPaidAiPlan(planKey));
}

/** The spies themselves — for a test that runs `vi.restoreAllMocks()` mid-body
 *  and needs the plan back before its next press. */
export function stubPaidAiPlan(planKey = 'max_x2'): void {
  _resetAiPlanCache();
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  const caps = capsForPlanKey(planKey);
  if (!caps) throw new Error(`stubPaidAiPlan: the plan key ${planKey} has no caps row`);
  const planName = BILLING_CATALOG.aiPlans.find((plan) => plan.key === planKey)?.name ?? planKey;
  vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
    kind: 'capped',
    planKey,
    planName,
    caps,
  });
}
