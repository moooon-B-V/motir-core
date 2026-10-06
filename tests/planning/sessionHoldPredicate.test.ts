import { describe, expect, it } from 'vitest';
import { planHoldFor, sessionHoldFor } from '@/lib/plans/planHold';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';

// THE TWO ARMS OF THE HOLD (Story MOTIR-7630 · MOTIR-7640; AMENDMENT 21 §1 and
// AMENDMENT 23 §5), as pure predicates — every input that frees a card, and the
// one shape of each that holds it.

const NOW = new Date('2026-07-27T12:00:00.000Z');
const LATER = new Date('2026-07-27T13:00:00.000Z');
const EARLIER = new Date('2026-07-27T11:00:00.000Z');

describe('planHoldFor — an undecided plan holds its card', () => {
  const lock = { planId: 'plan-1', expiresAt: LATER };

  it('holds a Planning card whose plan is undecided', () => {
    expect(
      planHoldFor({ itemStatus: PLANNING_STATUS_KEY, lock, planStatus: 'planned', now: NOW }),
    ).toEqual({ held: true, planId: 'plan-1', planStatus: 'planned' });
  });

  it('frees a card that is not at Planning, has no plan lock, or names no plan status', () => {
    expect(planHoldFor({ itemStatus: 'todo', lock, planStatus: 'planned', now: NOW })).toEqual({
      held: false,
    });
    expect(
      planHoldFor({ itemStatus: PLANNING_STATUS_KEY, lock: null, planStatus: 'planned', now: NOW }),
    ).toEqual({ held: false });
    expect(
      planHoldFor({
        itemStatus: PLANNING_STATUS_KEY,
        lock: { planId: null, expiresAt: LATER },
        planStatus: 'planned',
        now: NOW,
      }),
    ).toEqual({ held: false });
    expect(
      planHoldFor({ itemStatus: PLANNING_STATUS_KEY, lock, planStatus: null, now: NOW }),
    ).toEqual({ held: false });
  });

  it('a DECIDED plan never holds, and an expired `generating` lease does not', () => {
    expect(
      planHoldFor({ itemStatus: PLANNING_STATUS_KEY, lock, planStatus: 'declined', now: NOW }),
    ).toEqual({ held: false });
    expect(
      planHoldFor({
        itemStatus: PLANNING_STATUS_KEY,
        lock: { planId: 'plan-1', expiresAt: EARLIER },
        planStatus: 'generating',
        now: NOW,
      }),
    ).toEqual({ held: false });
  });
});

describe('sessionHoldFor — an OPEN session holds its card (AMENDMENT 23 §5)', () => {
  it('holds while the session is open, whatever its lease', () => {
    expect(
      sessionHoldFor({
        itemStatus: PLANNING_STATUS_KEY,
        lockSessionId: 's1',
        sessionEndedAt: null,
      }),
    ).toEqual({ held: true, sessionId: 's1' });
  });

  it('frees once it ends, when the session is gone, off Planning, or on a plan’s lock', () => {
    const free = { held: false };
    expect(
      sessionHoldFor({ itemStatus: PLANNING_STATUS_KEY, lockSessionId: 's1', sessionEndedAt: NOW }),
    ).toEqual(free);
    expect(
      sessionHoldFor({
        itemStatus: PLANNING_STATUS_KEY,
        lockSessionId: 's1',
        sessionEndedAt: undefined,
      }),
    ).toEqual(free);
    expect(
      sessionHoldFor({ itemStatus: 'in_progress', lockSessionId: 's1', sessionEndedAt: null }),
    ).toEqual(free);
    expect(
      sessionHoldFor({
        itemStatus: PLANNING_STATUS_KEY,
        lockSessionId: null,
        sessionEndedAt: null,
      }),
    ).toEqual(free);
  });
});
