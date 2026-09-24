import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGateAlreadyDecidedError } from '@/lib/approvalGates/errors';
import {
  PlanNotDecidableYetError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// Route-level transport test for POST /api/plans/[id]/decline (MOTIR-6038). The
// SERVICE half — a `planned` plan is declined through its gate, a `generating` /
// `stale` one is a plain write — is proved against a real Postgres in
// `tests/approvalGates/planDecisionEntrances.test.ts`. What the ROUTE owns is the
// press it forwards and the mapping of the door's refusals, so this mocks only the
// session boundary and the one service it calls.

const ctx = {
  current: null as { userId: string; workspaceId: string; projectId?: string } | null,
};
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('./helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctx.current,
}));

const declinePlan = vi.fn();
vi.mock('@/lib/services/planDecisionService', () => ({
  planDecisionService: { decline: (...args: unknown[]) => declinePlan(...args) },
}));

const { POST } = await import('@/app/api/plans/[id]/decline/route');

function callDecline(planId: string, body?: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost:3000/api/plans/${planId}/decline`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: planId }) },
  );
}

afterEach(() => {
  vi.clearAllMocks();
  ctx.current = null;
});

describe('POST /api/plans/[id]/decline — through the decide door (MOTIR-6038)', () => {
  it('forwards the stamp and the note the reader sent', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    declinePlan.mockResolvedValue({ id: 'plan_1', status: 'declined' });

    const res = await callDecline('plan_1', { stamp: 'v1.abc', noteMd: 'not now' });

    expect(res.status).toBe(200);
    expect(declinePlan).toHaveBeenCalledWith(
      { planId: 'plan_1', stamp: 'v1.abc', noteMd: 'not now', source: 'api' },
      ctx.current,
    );
  });

  it('a discard with no body forwards no stamp', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    declinePlan.mockResolvedValue({ id: 'plan_1', status: 'declined' });
    await callDecline('plan_1');
    expect(declinePlan.mock.calls[0]![0]).toMatchObject({ stamp: null, noteMd: null });
  });

  it('maps the door’s refusals: held, already decided and not decidable yet are 409s', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    declinePlan.mockRejectedValueOnce(
      new PlanRevisionInFlightError('plan_1', null, new Date('2026-09-23T12:00:00.000Z')),
    );
    const held = await callDecline('plan_1', { stamp: 's' });
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: 'PLAN_REVISION_IN_FLIGHT', heldBy: null });

    declinePlan.mockRejectedValueOnce(
      new ApprovalGateAlreadyDecidedError('gate_1', 'declined', 'u2', new Date()),
    );
    expect((await callDecline('plan_1', { stamp: 's' })).status).toBe(409);

    declinePlan.mockRejectedValueOnce(new PlanNotDecidableYetError('plan_1'));
    const notYet = await callDecline('plan_1');
    expect(notYet.status).toBe(409);
    expect(((await notYet.json()) as { code: string }).code).toBe('PLAN_NOT_DECIDABLE_YET');
  });

  it('keeps its own arms: not found 404, not in status 409, a hidden project 404 / 403', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    declinePlan.mockRejectedValueOnce(new PlanNotFoundError('plan_gone'));
    expect((await callDecline('plan_gone')).status).toBe(404);
    declinePlan.mockRejectedValueOnce(
      new PlanNotInExpectedStatusError('plan_1', 'approved', 'planned, stale or generating'),
    );
    expect((await callDecline('plan_1')).status).toBe(409);
    declinePlan.mockRejectedValueOnce(new ProjectAccessDeniedError('p1', 'browse'));
    expect((await callDecline('plan_1')).status).toBe(404);
    declinePlan.mockRejectedValueOnce(new ProjectAccessDeniedError('p1', 'edit'));
    expect((await callDecline('plan_1')).status).toBe(403);
  });

  it('an unrecognised error propagates, and no session is a 401 before the service', async () => {
    ctx.current = { userId: 'u1', workspaceId: 'ws1' };
    declinePlan.mockRejectedValueOnce(new Error('boom'));
    await expect(callDecline('plan_1')).rejects.toThrow('boom');
    ctx.current = null;
    expect((await callDecline('plan_1')).status).toBe(401);
    expect(declinePlan).toHaveBeenCalledTimes(1);
  });
});
