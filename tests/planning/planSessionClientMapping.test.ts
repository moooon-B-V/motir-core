import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { startCopiedSession, submitPlanChange } from '@/lib/planning/planChangeClient';
import {
  PlanAgainNotAvailableClientError,
  PlanSessionPlanDecidedClientError,
  PlanSessionPlanStaleClientError,
  finishedCardsOf,
} from '@/lib/planning/planSessionClientErrors';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { carriesWaitingPlan } from '@/lib/planning/sessionCarry';

// THE CLIENT HALF OF THE CARRY'S WIRE (Story MOTIR-7928 · MOTIR-7933's top-up). The
// overlay's hook narrows on these classes and follows them — it never renders a
// code — so the mapping from a 409 body to a class, and the request each call
// sends, are asserted here at the one seam the component suites stub away.

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => fetchMock.mockReset());

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

const sentBody = () => JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);

describe('startCopiedSession', () => {
  it('without options posts the copy alone (the shipped copy door)', async () => {
    answer(200, { id: 'new' });
    await startCopiedSession('src');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ai/plan-change/session');
    expect(sentBody()).toEqual({ copyFrom: 'src' });
  });

  it('with a turn posts the carry: body, answer flag and anchor', async () => {
    answer(200, { id: 'new', takenBack: true });
    const out = await startCopiedSession('src', {
      body: 'Go on',
      isAnswer: true,
      anchorKey: 'K-1',
    });
    expect(sentBody()).toEqual({
      copyFrom: 'src',
      body: 'Go on',
      isAnswer: true,
      anchorKey: 'K-1',
    });
    expect(out.takenBack).toBe(true);
  });

  it('maps a decided refusal to its typed error', async () => {
    answer(409, { code: 'PLAN_SESSION_PLAN_DECIDED', planId: 'p1', planStatus: 'approved' });
    const err = await startCopiedSession('src', { body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanSessionPlanDecidedClientError);
    expect(err).toMatchObject({ status: 409, planId: 'p1', planStatus: 'approved' });
  });

  it('a decided refusal with no plan fields reads nulls, never undefined', async () => {
    answer(409, { code: 'PLAN_SESSION_PLAN_DECIDED' });
    const err = await startCopiedSession('src', { body: 'x' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ planId: null, planStatus: null });
  });
});

describe('submitPlanChange', () => {
  it('posts planAgainOf only when given', async () => {
    answer(200, { planId: 'p', jobId: 'j' });
    await submitPlanChange('s1');
    expect(sentBody()).toEqual({ sessionId: 's1' });
    answer(200, { planId: 'p2', jobId: 'j2' });
    await submitPlanChange('s1', undefined, { planAgainOf: 'stale' });
    expect(sentBody()).toEqual({ sessionId: 's1', planAgainOf: 'stale' });
  });

  it('maps the stale outcome with its finished cards', async () => {
    answer(409, {
      code: 'PLAN_SESSION_PLAN_STALE',
      planId: 'p1',
      finishedCards: [{ id: 'w1', key: 'A-1', title: 'T', status: 'done', statusLabel: 'Done' }],
    });
    const err = await submitPlanChange('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanSessionPlanStaleClientError);
    expect(err).toMatchObject({
      planId: 'p1',
      finishedCards: [{ id: 'w1', key: 'A-1', title: 'T', status: 'done', statusLabel: 'Done' }],
    });
  });

  it('a stale body with no plan id reads an empty id and no cards', async () => {
    answer(409, { code: 'PLAN_SESSION_PLAN_STALE' });
    const err = await submitPlanChange('s1').catch((e: unknown) => e);
    expect(err).toMatchObject({ planId: '', finishedCards: [] });
  });

  it('maps plan-again-not-available with the plan to follow', async () => {
    answer(409, {
      code: 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE',
      reason: 'already_accepted',
      latestPlanId: 'p9',
    });
    const err = await submitPlanChange('s1', undefined, { planAgainOf: 'p1' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanAgainNotAvailableClientError);
    expect(err).toMatchObject({ reason: 'already_accepted', latestPlanId: 'p9' });
  });

  it('plan-again-not-available with no fields reads superseded and no plan', async () => {
    answer(409, { code: 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE' });
    const err = await submitPlanChange('s1').catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'superseded', latestPlanId: null });
  });

  it('any other code stays the generic client error', async () => {
    answer(409, { code: 'PLAN_REVISION_IN_FLIGHT' });
    const err = await submitPlanChange('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanEditsClientError);
    expect(err).not.toBeInstanceOf(PlanSessionPlanStaleClientError);
    expect((err as PlanEditsClientError).code).toBe('PLAN_REVISION_IN_FLIGHT');
  });
});

describe('finishedCardsOf', () => {
  it('keeps only rows with an id and a key, and fills the rest with empty text', () => {
    expect(finishedCardsOf(undefined)).toEqual([]);
    expect(finishedCardsOf('nope')).toEqual([]);
    expect(
      finishedCardsOf([null, { id: 'w1' }, { key: 'A-2' }, { id: 'w3', key: 'A-3', title: 5 }]),
    ).toEqual([{ id: 'w3', key: 'A-3', title: '', status: '', statusLabel: '' }]);
  });
});

describe('carriesWaitingPlan', () => {
  const ended = {
    endedAt: '2026-10-09T00:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    pendingPlanId: 'p1',
  } as unknown as PlanChangeSessionDto;

  it('holds for the starter of an ended conversation whose plan waits', () => {
    expect(carriesWaitingPlan(ended, false)).toBe(true);
  });

  it.each([
    ['no session', null, false],
    ['read-only', ended, true],
    ['open', { ...ended, endedAt: null }, false],
    ['a guide session', { ...ended, origin: 'guide' }, false],
    ['another member', { ...ended, startedByViewer: false }, false],
    ['no waiting plan', { ...ended, pendingPlanId: null }, false],
  ])('not for %s', (_name, session, readOnly) => {
    expect(carriesWaitingPlan(session as PlanChangeSessionDto | null, readOnly as boolean)).toBe(
      false,
    );
  });
});
