import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlanApproveTimedOutError,
  PlanHasNoProposalsError,
  PlanNotFoundError,
} from '@/lib/plans/errors';

// Route-level transport test for POST /api/plans/[id]/approve — the P2028 arm
// (MOTIR-3396).
//
// The SERVICE half (batching the edge pass, the raised budget, the typed error's
// own shape) is proved against a real Postgres in
// `tests/integration/plans/approveTransactionBudget.test.ts`. What the ROUTE owns
// is the mapping, and the mapping is the part that failed in production: an
// approve that exhausted its transaction budget fell through every arm to the
// bare `throw err` and reached the caller as a 500 with an empty body. So this
// file asserts the status and the payload, and it mocks only the two boundaries
// the node test env cannot supply with no cookies — the same exception the
// sibling route suites take.

const ctx = {
  current: null as { userId: string; workspaceId: string; projectId?: string } | null,
};
// MOTIR-3653 / MOTIR-3648 — every route and route group now resolves the 2FA
// hold first. This suite is about this route's own gates, so the policy answers
// "nobody is asking", which is the state each case below was written in.
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('./helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);

vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctx.current,
}));
// next-intl's server helper needs a request-scoped i18n config the node test env
// has no request for; echo the key (the route uses it only for the
// provisional-project-name placeholder, which no case here depends on).
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const approvePlan = vi.fn();
vi.mock('@/lib/services/plansService', () => ({
  plansService: { approvePlan: (...args: unknown[]) => approvePlan(...args) },
}));

const { POST } = await import('@/app/api/plans/[id]/approve/route');

function callApprove(planId: string): Promise<Response> {
  return POST(
    new Request(`http://localhost:3000/api/plans/${planId}/approve`, { method: 'POST' }),
    {
      params: Promise.resolve({ id: planId }),
    },
  );
}

afterEach(() => {
  vi.clearAllMocks();
  ctx.current = null;
});

describe('POST /api/plans/[id]/approve — a transaction timeout is a 503, not a bare 500', () => {
  it('maps PlanApproveTimedOutError to 503 and names the plan AND its item count', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    approvePlan.mockRejectedValue(new PlanApproveTimedOutError('plan_xyz', 15));

    const res = await callApprove('plan_xyz');

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('PLAN_APPROVE_TIMED_OUT');
    expect(body.planId).toBe('plan_xyz');
    // The actionable part: "too large for one transaction" only helps if the
    // response says how large, so the count is a FIELD, not just prose.
    expect(body.itemCount).toBe(15);
    expect(String(body.error)).toContain('Nothing was created');
  });

  it('leaves every other arm alone — a missing plan is still a 404', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    approvePlan.mockRejectedValue(new PlanNotFoundError('plan_gone'));

    const res = await callApprove('plan_gone');
    expect(res.status).toBe(404);
  });

  it('an unrecognised error still propagates — the new arm widened nothing', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    approvePlan.mockRejectedValue(new Error('boom'));

    await expect(callApprove('plan_x')).rejects.toThrow('boom');
  });

  it('no session is still a 401 before the service is reached', async () => {
    ctx.current = null;
    const res = await callApprove('plan_x');
    expect(res.status).toBe(401);
    expect(approvePlan).not.toHaveBeenCalled();
  });
});

// MOTIR-4146 — the plan holds NOTHING, so there is nothing to approve.
//
// The SERVICE half (the refusal itself, and that the row stays `planned`) is
// proved against a real Postgres in
// `tests/integration/plans/emptyPlanIsNotApprovable.test.ts`. What the ROUTE
// owns is the status, and it is the same lesson every arm in this file records:
// a refusal with no arm reaches the caller as a bare 500 with an empty body,
// which reads as *something is broken* and gets the button pressed again.
describe('POST /api/plans/[id]/approve — an EMPTY plan is a 409', () => {
  it('maps PlanHasNoProposalsError to 409 and carries its code', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    approvePlan.mockRejectedValue(new PlanHasNoProposalsError('plan_empty'));

    const res = await callApprove('plan_empty');

    // 409 rather than 400: nothing about the REQUEST is malformed. The plan is
    // in a state approve cannot act on — the same reading `PLAN_NOT_IN_
    // EXPECTED_STATUS` gets one arm above.
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('PLAN_HAS_NO_PROPOSALS');
    expect(body.planId).toBe('plan_empty');
  });
});
