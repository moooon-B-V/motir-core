import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJob } from '@/lib/ai/motirAiClient';
import { MotirAiOutOfCreditsError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { terminalStatusOf, walkPositionOf } from '@/lib/ai/jobStream';
import {
  failureRecordFrom,
  parseJobWalkStop,
  parseWalkPosition,
  reasonCodeFromError,
} from '@/lib/planChange/failureRecord';
import {
  classifyAbandonedCandidate,
  classifySessionCandidate,
} from '@/lib/services/abandonedPlanService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';

// MOTIR-7912 — the pure half of recording a failed hosted attempt: the walk-stop
// parse, the TOTAL reason map, the record builder, the frame readers, the second
// sweep table and the refusal's new fields. No database.

const NOW = new Date('2026-10-09T12:00:00Z');
const WALK_STOP = {
  phase: 'author',
  target: 'planItem:abc',
  targetTitle: 'Export a report',
  depth: 1,
  planId: 'plan_1',
  reasonCode: 'rate_limited',
  detail: 'the model said slow down',
};

describe('parseJobWalkStop', () => {
  it('reads a well-formed walkStop', () => {
    expect(parseJobWalkStop(WALK_STOP)).toMatchObject({ phase: 'author', target: 'planItem:abc' });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a wrong-typed phase', { ...WALK_STOP, phase: 'think' }],
    ['a wrong-typed depth', { ...WALK_STOP, depth: 'one' }],
    ['a missing reasonCode', { phase: 'lay', target: null, depth: 0 }],
  ])('reads %s as null and never throws', (_name, raw) => {
    expect(parseJobWalkStop(raw)).toBeNull();
  });
});

describe('reasonCodeFromError — total', () => {
  it.each([
    ['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits'],
    ['MOTIR_AI_UNAUTHORIZED', 'token_expired'],
    ['MOTIR_AI_UNAVAILABLE', 'model_unavailable'],
    ['MOTIR_AI_JOB_FAILED', 'model_unavailable'],
    ['MOTIR_AI_JOB_NOT_FOUND', 'internal'],
    ['SOMETHING_NEW', 'internal'],
  ])('%s → %s', (code, expected) => {
    expect(reasonCodeFromError({ code })).toBe(expected);
  });

  it('maps a missing error to internal', () => {
    expect(reasonCodeFromError(null)).toBe('internal');
    expect(reasonCodeFromError(undefined)).toBe('internal');
  });
});

describe('failureRecordFrom', () => {
  const base = { failedJobId: 'job_1', now: NOW, lastPosition: null, error: null };

  it('takes the stop point, reason and detail from walkStop', () => {
    const rec = failureRecordFrom({ ...base, walkStop: parseJobWalkStop(WALK_STOP) });
    expect(rec).toEqual({
      failedAt: NOW,
      failedJobId: 'job_1',
      failureReason: 'rate_limited',
      failureDetail: 'the model said slow down',
      failureStopPhase: 'author',
      failureStopRef: 'planItem:abc',
      failureStopTitle: 'Export a report',
    });
  });

  it('falls back to the last relayed position when walkStop is absent', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      lastPosition: { phase: 'lay', target: null, depth: 0 },
      error: new MotirAiOutOfCreditsError('out'),
    });
    expect(rec).toMatchObject({
      failureReason: 'out_of_credits',
      failureStopPhase: 'lay',
      failureStopRef: null,
    });
  });

  it('is all-null on the stop point with neither, and internal for a plain failure', () => {
    const rec = failureRecordFrom({ ...base, walkStop: null });
    expect(rec).toMatchObject({
      failureReason: 'internal',
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
      failureDetail: null,
    });
  });

  it('records a plan with NO job as internal with no job and no stop point (MOTIR-8132)', () => {
    const rec = failureRecordFrom({ ...base, failedJobId: null, walkStop: null });
    expect(rec).toMatchObject({
      failedJobId: null,
      failureReason: 'internal',
      failureStopPhase: null,
      failureStopRef: null,
    });
  });

  it('records an UNKNOWN reasonCode as internal, never as prose', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({ ...WALK_STOP, reasonCode: 'cosmic_rays' }),
    });
    expect(rec.failureReason).toBe('internal');
  });

  it('caps an over-long detail', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({ ...WALK_STOP, detail: 'x'.repeat(900) }),
    });
    expect(rec.failureDetail!.length).toBe(300);
  });

  it('uses the error message as the detail when walkStop carries none', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      error: new MotirAiUnavailableError('gateway 503'),
    });
    expect(rec.failureDetail).toContain('gateway 503');
  });
});

describe('the frame readers', () => {
  it('terminalStatusOf separates failed from canceled and ignores the rest', () => {
    expect(terminalStatusOf({ event: 'status', data: { status: 'failed' } })).toBe('failed');
    expect(terminalStatusOf({ event: 'status', data: { status: 'canceled' } })).toBe('canceled');
    expect(terminalStatusOf({ event: 'status', data: { status: 'running' } })).toBeNull();
    expect(terminalStatusOf({ event: 'done', data: {} })).toBeNull();
  });

  it('walkPositionOf reads a walk_position frame and nothing malformed', () => {
    expect(
      walkPositionOf({ event: 'walk_position', data: { phase: 'lay', target: null, depth: 0 } }),
    ).toEqual({ phase: 'lay', target: null, depth: 0 });
    expect(walkPositionOf({ event: 'walk_position', data: { phase: 'x' } })).toBeNull();
    expect(
      walkPositionOf({ event: 'status', data: { phase: 'lay', target: null, depth: 0 } }),
    ).toBeNull();
    expect(parseWalkPosition(null)).toBeNull();
  });
});

describe('classifySessionCandidate — the second table', () => {
  const failedJob = { status: 'failed', reachable: true, failure: null } as const;
  const succeededJob = { status: 'succeeded', reachable: true, failure: null } as const;
  const SILENT_MS = 20 * 60_000;
  const dead = (job: Parameters<typeof classifyAbandonedCandidate>[0]) => {
    const verdict = classifyAbandonedCandidate(job, SILENT_MS);
    if (!verdict.abandoned) throw new Error('fixture is not dead');
    return verdict;
  };

  it('spares a waiting session on either wait', () => {
    expect(classifySessionCandidate('failed', dead(failedJob))).toEqual({
      action: 'keep',
      reason: 'session_waiting',
    });
    expect(classifySessionCandidate('awaiting_person', dead(failedJob))).toEqual({
      action: 'keep',
      reason: 'session_waiting',
    });
  });

  it('records EVERY dead verdict on an open session — never a decline (MOTIR-8132)', () => {
    expect(classifySessionCandidate('open', dead(failedJob))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    expect(classifySessionCandidate('open', dead(succeededJob))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    const canceled = { status: 'canceled', reachable: true, failure: null } as const;
    expect(classifySessionCandidate('open', dead(canceled))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    const gone = {
      status: null,
      reachable: false,
      failure: { code: 'MOTIR_AI_JOB_NOT_FOUND', message: 'x' },
    } as const;
    expect(classifySessionCandidate('open', dead(gone))).toEqual({
      action: 'record',
      reason: 'job_gone',
    });
    const running = { status: 'running', reachable: true, failure: null } as const;
    expect(classifySessionCandidate('open', dead(running))).toEqual({
      action: 'record',
      reason: 'silent',
    });
    expect(classifySessionCandidate('open', dead(null))).toEqual({
      action: 'record',
      reason: 'silent',
    });
  });
});

describe('PlanTargetLockedError — the waiting fields', () => {
  it('a plain hold is not waiting and keeps its free-by time', () => {
    const err = new PlanTargetLockedError('MOTIR-1', 'Ada', NOW, { sessionId: 's1' });
    expect(err.sessionWaiting).toBe(false);
    expect(err.waitingCause).toBeNull();
    expect(err.freesBy).not.toBeNull();
  });

  it.each(['question', 'reply', 'failed'] as const)(
    'a %s hold says waiting on the holder, with no free-by',
    (cause) => {
      const err = new PlanTargetLockedError('MOTIR-1', 'Ada', NOW, {
        sessionId: 's1',
        waitingCause: cause,
      });
      expect(err.sessionWaiting).toBe(true);
      expect(err.waitingCause).toBe(cause);
      expect(err.freesBy).toBeNull();
      expect(err.holderSessionId).toBe('s1');
      expect(err.message).toContain('waiting on Ada');
    },
  );
});

describe('getJob parses walkStop tolerantly', () => {
  beforeEach(() => {
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (error: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jobId: 'j', status: 'failed', result: null, error }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  const problem = {
    type: 'about:blank',
    title: 'Job failed',
    status: 500,
    code: 'ai_job_failed',
    detail: 'boom',
  };

  it('carries walkStop when the problem has one', async () => {
    stub({ ...problem, walkStop: WALK_STOP });
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toMatchObject({ reasonCode: 'rate_limited' });
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
  });

  it('reads null, with the same typed error, when walkStop is absent', async () => {
    stub(problem);
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toBeNull();
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
  });

  it('reads null when walkStop has the wrong shape', async () => {
    stub({ ...problem, walkStop: { phase: 7, depth: 'deep' } });
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toBeNull();
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
  });

  it('is null on a job with no error at all', async () => {
    stub(null);
    expect((await getJob('j', 'pj')).walkStop).toBeNull();
  });
});
