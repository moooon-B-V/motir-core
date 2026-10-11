import { describe, expect, it } from 'vitest';
import { classifyRevisionCandidate } from '@/lib/services/abandonedPlanService';
import type { PlanJobStateDto } from '@/lib/dto/plans';

const HOUR = 60 * 60 * 1000;
const job = (over: Record<string, unknown>): PlanJobStateDto =>
  ({ jobId: 'j', reachable: true, status: 'running', failure: null, ...over }) as never;

describe('classifyRevisionCandidate', () => {
  it('a failed job is a failure to record', () => {
    expect(classifyRevisionCandidate(job({ status: 'failed' }), HOUR)).toEqual({
      action: 'fail',
      reason: 'job_terminal',
    });
  });
  it('a canceled or succeeded job only owes its lease back', () => {
    for (const status of ['canceled', 'succeeded']) {
      expect(classifyRevisionCandidate(job({ status }), HOUR)).toEqual({
        action: 'release',
        reason: 'job_terminal',
      });
    }
  });
  it('a vanished job is a failure', () => {
    const gone = job({
      reachable: false,
      status: null,
      failure: { code: 'MOTIR_AI_JOB_NOT_FOUND', message: '' },
    });
    expect(classifyRevisionCandidate(gone, HOUR)).toEqual({ action: 'fail', reason: 'job_gone' });
  });
  it('a running job is kept until the max age, then failed', () => {
    expect(classifyRevisionCandidate(job({}), HOUR)).toEqual({
      action: 'keep',
      reason: 'job_in_flight',
    });
    expect(classifyRevisionCandidate(job({}), 25 * HOUR)).toEqual({
      action: 'fail',
      reason: 'max_age',
    });
  });
  it('an unreachable motir-ai is kept', () => {
    expect(classifyRevisionCandidate(job({ reachable: false, status: null }), HOUR)).toEqual({
      action: 'keep',
      reason: 'ai_unreachable',
    });
  });
});
