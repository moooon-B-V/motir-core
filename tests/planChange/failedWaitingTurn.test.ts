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

// MOTIR-9121 — motir-ai said the failed job cannot be resumed.
describe('classifyFailedWaitingTurn — a failure that cannot be resumed (MOTIR-9121)', () => {
  it('⚠️ with nothing waiting, the next turn plans again instead of being refused for a Resume', () => {
    // The production shape once the attempt is released: its plan declined, nothing undecided.
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        failureResumable: false,
        plans: [],
      }),
    ).toBe('continue');
  });
  it('never refuses for a Resume, even while the failed job’s generating plan is still there', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        failureResumable: false,
        plans: [plan('a', 'generating', 1, 'job-f')],
      }),
    ).toBe('continue');
  });
  it('beside a plan that waits, it continues that plan, as situation 2 does', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'failed',
        failedJobId: 'job-f',
        failureResumable: false,
        plans: [plan('a', 'planned', 1)],
      }),
    ).toBe('continue');
  });
  it.each([true, null, undefined])(
    'a resumable or unknown (%s) verdict keeps today’s answer',
    (failureResumable) => {
      expect(
        classifyFailedWaitingTurn({
          waiting: 'failed',
          failedJobId: 'job-f',
          failureResumable,
          plans: [plan('a', 'generating', 1, 'job-f')],
        }),
      ).toBe('refuse_resume');
      expect(
        classifyFailedWaitingTurn({
          waiting: 'failed',
          failedJobId: 'job-f',
          failureResumable,
          plans: [],
        }),
      ).toBe('refuse_resume');
    },
  );
  it('a session that is not failed is not_failed whatever the verdict', () => {
    expect(
      classifyFailedWaitingTurn({
        waiting: 'open',
        failedJobId: null,
        failureResumable: false,
        plans: [],
      }),
    ).toBe('not_failed');
  });
});
