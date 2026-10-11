import { describe, expect, it } from 'vitest';
import { classifyFailedWaitingTurn } from '@/lib/planChange/failedWaitingTurn';

const t = (n: number) => new Date(2026, 9, 1, 0, n);
const plan = (
  id: string,
  status: 'generating' | 'planned' | 'stale',
  n: number,
  sourceJobId: string | null = null,
) => ({ id, status, createdAt: t(n), sourceJobId });

describe('classifyFailedWaitingTurn (MOTIR-7938)', () => {
  it('a session that is not failed-waiting is not_failed', () => {
    for (const waiting of ['open', 'awaiting_person'] as const) {
      expect(
        classifyFailedWaitingTurn({ waiting, failedJobId: null, plans: [plan('a', 'planned', 1)] }),
      ).toBe('not_failed');
    }
  });
  it('a failed generating walk is refused → Resume', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        plans: [plan('a', 'generating', 1, 'job-f')],
      }),
    ).toBe('refuse_resume');
  });
  it('a failed walk beside an OLDER planned plan is still refused', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        plans: [plan('b', 'generating', 2, 'job-f'), plan('a', 'planned', 1)],
      }),
    ).toBe('refuse_resume');
  });
  it('a failed session holding only a planned or stale plan continues', () => {
    for (const status of ['planned', 'stale'] as const) {
      expect(
        classifyFailedWaitingTurn({
          waiting: 'failed',
          failedJobId: 'job-f',
          plans: [plan('a', status, 1)],
        }),
      ).toBe('continue');
    }
  });
  it('no undecided plan → refuse_resume (a failure keeps no third exit)', () => {
    expect(classifyFailedWaitingTurn({ waiting: 'failed', failedJobId: 'job-f', plans: [] })).toBe(
      'refuse_resume',
    );
  });
  it('a generating plan that is not the failed job’s → refuse_resume', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        plans: [plan('b', 'generating', 2, 'job-other'), plan('a', 'planned', 1)],
      }),
    ).toBe('refuse_resume');
  });
});
