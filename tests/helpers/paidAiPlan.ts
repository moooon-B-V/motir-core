import { beforeEach, vi } from 'vitest';
import { _resetAiPlanCache, aiPlanGateService } from '@/lib/services/aiPlanGateService';

// MOTIR-6909 — the fleet is paid-AI-plan only, so on a cloud build every
// admission first asks motir-ai for the org's subscription. Suites that test the
// POOL, the METER or the CHARGE — not the plan — call `grantPaidAiPlan()` at file
// scope so their orgs hold a paid plan without each one faking the subscription
// read. The plan gate's own behaviour is tested in `tests/ciFleet/aiPlanGate.test.ts`.
//
// A `beforeEach`, not a one-off spy, because most of these suites run
// `vi.restoreAllMocks()` in an `afterEach`.
export function grantPaidAiPlan(): void {
  beforeEach(stubPaidAiPlan);
}

/** The spy itself — for a test that runs `vi.restoreAllMocks()` mid-body and
 *  needs the plan back before its next press. */
export function stubPaidAiPlan(): void {
  _resetAiPlanCache();
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
}
