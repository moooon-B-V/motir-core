import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('@/lib/repositories/planChangeSessionRepository', () => ({
  planChangeSessionRepository: { findById: (...a: unknown[]) => findById(...a) },
}));

import {
  failureRecordFrom,
  parseJobWalkStop,
  parseWalkPosition,
  reasonCodeFromError,
} from '@/lib/planChange/failureRecord';
import { classifyFailedWaitingTurn } from '@/lib/planChange/failedWaitingTurn';
import { toResumeFormOf } from '@/lib/planChange/toResumeForm';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';

// The PURE rules of Story MOTIR-7905 that its integration gate (MOTIR-7919) reaches only through
// whole chains: the failure record's parsing and mapping, what a turn on a failed session does,
// which To resume form a session takes, and the planning-session gate handler's refusals.

describe('failureRecord — parsing never throws, mapping is total', () => {
  it('reads a well-formed walkStop and a malformed one as null', () => {
    expect(
      parseJobWalkStop({ phase: 'lay', target: null, depth: 0, reasonCode: 'internal' }),
    ).toMatchObject({ phase: 'lay', target: null });
    expect(parseJobWalkStop(undefined)).toBeNull();
    expect(parseJobWalkStop(null)).toBeNull();
    expect(parseJobWalkStop({ phase: 'nonsense' })).toBeNull();
  });

  it('reads a walk_position frame, and anything malformed as null', () => {
    expect(parseWalkPosition({ phase: 'author', target: 'planItem:x', depth: 2 })).toEqual({
      phase: 'author',
      target: 'planItem:x',
      depth: 2,
    });
    expect(parseWalkPosition({ phase: 'author' })).toBeNull();
  });

  it.each([
    ['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits'],
    ['MOTIR_AI_UNAUTHORIZED', 'token_expired'],
    ['MOTIR_AI_UNAVAILABLE', 'model_unavailable'],
    ['MOTIR_AI_JOB_FAILED', 'model_unavailable'],
    ['MOTIR_AI_BAD_REQUEST', 'model_unavailable'],
    ['SOMETHING_NEW', 'internal'],
  ])('maps %s to %s', (code, reason) => {
    expect(reasonCodeFromError({ code })).toBe(reason);
  });
  it('maps a missing error to internal', () => {
    expect(reasonCodeFromError(null)).toBe('internal');
    expect(reasonCodeFromError(undefined)).toBe('internal');
  });

  const NOW = new Date('2026-10-10T10:00:00.000Z');
  it('takes the stop from walkStop, else the last position, else null', () => {
    const walkStop = {
      phase: 'author' as const,
      target: 'planItem:a',
      targetTitle: 'A',
      depth: 1,
      reasonCode: 'rate_limited',
      detail: 'slow',
    };
    const position = { phase: 'lay' as const, target: 'planItem:p', targetTitle: 'P', depth: 0 };
    expect(
      failureRecordFrom({
        failedJobId: 'j',
        now: NOW,
        walkStop,
        lastPosition: position,
        error: null,
      }),
    ).toMatchObject({
      failureReason: 'rate_limited',
      failureStopPhase: 'author',
      failureStopRef: 'planItem:a',
      failureStopTitle: 'A',
      failureDetail: 'slow',
    });
    expect(
      failureRecordFrom({
        failedJobId: 'j',
        now: NOW,
        walkStop: null,
        lastPosition: position,
        error: { code: 'MOTIR_AI_UNAVAILABLE', message: 'gateway 503' },
      }),
    ).toMatchObject({
      failureReason: 'model_unavailable',
      failureStopPhase: 'lay',
      failureDetail: 'gateway 503',
    });
    expect(
      failureRecordFrom({
        failedJobId: 'j',
        now: NOW,
        walkStop: null,
        lastPosition: null,
        error: null,
      }),
    ).toMatchObject({
      failureReason: 'internal',
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
      failureDetail: null,
    });
  });

  it('an unrecognised walkStop reason falls back to the mapped error, and the detail is capped', () => {
    const record = failureRecordFrom({
      failedJobId: 'j',
      now: NOW,
      walkStop: {
        phase: 'lay',
        target: null,
        depth: 0,
        reasonCode: 'weird',
        detail: 'x'.repeat(5000),
      },
      lastPosition: null,
      error: { code: 'MOTIR_AI_OUT_OF_CREDITS' },
    });
    expect(record.failureReason).toBe('out_of_credits');
    expect(record.failureDetail!.length).toBeLessThan(5000);
  });
});

describe('classifyFailedWaitingTurn — what a turn on a failed session does', () => {
  const plan = (
    id: string,
    status: 'generating' | 'planned' | 'stale',
    sourceJobId: string | null,
    at: number,
  ) => ({ id, status, sourceJobId, createdAt: new Date(at) });

  it('is not_failed on any session that is not failed-waiting', () => {
    expect(classifyFailedWaitingTurn({ waiting: 'open', failedJobId: null, plans: [] })).toBe(
      'not_failed',
    );
  });
  it('refuses to Resume when a resumable failed walk exists, even beside a waiting plan', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'j1',
        plans: [plan('a', 'planned', 'j0', 1), plan('b', 'generating', 'j1', 2)],
      }),
    ).toBe('refuse_resume');
  });
  it('continues when the most recent undecided plan is planned or stale', () => {
    for (const status of ['planned', 'stale'] as const) {
      expect(
        classifyFailedWaitingTurn({
          waiting: 'failed',
          failedJobId: 'j1',
          plans: [plan('a', status, 'j0', 1)],
        }),
      ).toBe('continue');
    }
  });
  it('breaks a createdAt tie by id, and refuses to Resume when no shape matches', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'j1',
        plans: [plan('a', 'planned', null, 5), plan('b', 'stale', null, 5)],
      }),
    ).toBe('continue');
    expect(classifyFailedWaitingTurn({ waiting: 'failed', failedJobId: 'j1', plans: [] })).toBe(
      'refuse_resume',
    );
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: null,
        plans: [plan('g', 'generating', 'j1', 1)],
      }),
    ).toBe('refuse_resume');
  });
});

describe('toResumeFormOf — which To resume form a session takes', () => {
  const p = (id: string, status: 'generating' | 'planned' | 'stale', at: number) => ({
    id,
    status,
    createdAt: new Date(at),
  });
  const open = { endedAt: null, endReason: null };
  const endedFailed = { endedAt: new Date(), endReason: 'failed' };

  it('a failed walk, with and without a waiting plan beside it', () => {
    expect(toResumeFormOf(open, [p('g', 'generating', 2)])).toEqual({
      form: 'failed_walk',
      entryPlanId: 'g',
      waitingPlanId: null,
    });
    expect(toResumeFormOf(open, [p('w', 'planned', 1), p('g', 'generating', 2)])).toEqual({
      form: 'failed_walk',
      entryPlanId: 'g',
      waitingPlanId: 'w',
    });
  });
  it('a failure beside a waiting plan; a session with nothing undecided takes no form', () => {
    expect(toResumeFormOf(open, [p('w', 'stale', 1)])?.form).toBe('failed_beside_waiting_plan');
    expect(toResumeFormOf(open, [])).toBeNull();
  });
  it('an ended-failed session holding a waiting plan; any other end takes none', () => {
    expect(toResumeFormOf(endedFailed, [p('w', 'planned', 1)])?.form).toBe(
      'ended_with_waiting_plan',
    );
    expect(toResumeFormOf(endedFailed, [p('g', 'generating', 1)])).toBeNull();
    expect(
      toResumeFormOf({ endedAt: new Date(), endReason: 'idle' }, [p('w', 'planned', 1)]),
    ).toBeNull();
  });
  it('breaks a createdAt tie by id (the newest waiting plan wins)', () => {
    expect(toResumeFormOf(open, [p('a', 'planned', 5), p('b', 'planned', 5)])?.waitingPlanId).toBe(
      'b',
    );
  });
});

describe('the planning_session gate handler', () => {
  const gate = { id: 'g1', subjectId: 's1', workspaceId: 'w1' };
  const args = { gate, tx: {} } as never;

  beforeEach(() => findById.mockReset());

  it('resolves the subject and stamps the moment the session began waiting', async () => {
    const { planningSessionGateHandler: h } =
      await import('@/lib/approvalGates/planningSessionHandler');
    const since = new Date('2026-10-10T09:00:00.000Z');
    findById.mockResolvedValue({
      id: 's1',
      endedAt: null,
      failedAt: null,
      awaitingPersonSince: since,
    });
    expect(await h.resolveSubject(args)).toMatchObject({ id: 's1' });
    expect(await h.subjectVersion(args)).toBe(since.toISOString());
    expect(await h.currentSubject({ ...(args as object) } as never)).toBe('s1');
    findById.mockResolvedValue(null);
    expect(await h.subjectVersion(args)).toBeNull();
    expect(await h.currentSubject(args as never)).toBeNull();
  });

  it('is current only while the session still WAITS on its person', async () => {
    const { planningSessionGateHandler: h } =
      await import('@/lib/approvalGates/planningSessionHandler');
    findById.mockResolvedValue({
      id: 's1',
      endedAt: null,
      failedAt: new Date(),
      awaitingPersonSince: null,
    });
    expect(await h.currentSubject(args as never)).toBeNull();
    expect(await h.currentSubject({ tx: {} } as never)).toBeNull(); // no gate in hand
  });

  it('routes to nobody (the raise writes the owner), needs ai:plan, and has no verbs', async () => {
    const { planningSessionGateHandler: h } =
      await import('@/lib/approvalGates/planningSessionHandler');
    expect(h.routeTo({} as never)).toBeNull();
    expect(h.permission).toBe('ai:plan');
    await expect(h.approve(args)).rejects.toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    await expect(h.requestChanges(args)).rejects.toBeInstanceOf(ApprovalGateVerbNotOfferedError);
  });
});
