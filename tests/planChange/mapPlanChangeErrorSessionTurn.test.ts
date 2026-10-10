import { describe, expect, it } from 'vitest';
import { mapPlanChangeError } from '@/app/api/ai/plan-change/_errors';
import { PlanAgainNotAvailableError, PlanSessionPlanStaleError } from '@/lib/planChange/errors';
import { PlanNotEditableError, PlanRevisionInFlightError } from '@/lib/plans/errors';

// MOTIR-7945 — a turn over a waiting plan answers typed 409s, never a 500.

describe('mapPlanChangeError — the turn over a waiting plan', () => {
  it('maps a revision in flight with who holds it and until when', async () => {
    const until = new Date('2026-10-09T12:00:00Z');
    const res = mapPlanChangeError(new PlanRevisionInFlightError('p1', 'Motir', until))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'PLAN_REVISION_IN_FLIGHT',
      heldBy: 'Motir',
      expiresAt: until.toISOString(),
    });
  });

  it('maps a plan no longer editable with its status', async () => {
    const res = mapPlanChangeError(new PlanNotEditableError('p1', 'approved'))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_EDITABLE', status: 'approved' });
  });

  it('maps the stale outcome with its plan and finished cards', async () => {
    const cards = [{ id: 'w1', key: 'ACME-1', title: 'CSV', status: 'done', statusLabel: 'Done' }];
    const res = mapPlanChangeError(new PlanSessionPlanStaleError('p1', cards))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'PLAN_SESSION_PLAN_STALE',
      planId: 'p1',
      finishedCards: cards,
    });
  });

  it('maps a plan-again that is no longer available', async () => {
    const res = mapPlanChangeError(new PlanAgainNotAvailableError('superseded', 'p2'))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE',
      reason: 'superseded',
      latestPlanId: 'p2',
    });
  });
});
