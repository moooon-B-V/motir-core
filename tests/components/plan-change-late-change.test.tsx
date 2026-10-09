// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A CHANGE FORWARDED AFTER THE WALK FINISHED (Story MOTIR-7990 · MOTIR-7997) — the
// client half. When a PLANNING run's stream ends and the mailbox state the hook
// holds still lists a forwarded turn the run was never seen to read, the hook asks
// the server ONCE to claim it and submit it as a revision (or hand it back).
// Nothing queued → no request: an ordinary run makes none.
//
// Driven through the anchored door, the harness `plan-change-mid-run-turn.test.tsx`
// uses; the mid-run send is the SHIPPED one (MOTIR-7996).

const openSession = vi.fn();
const resumeContextual = vi.fn();
const recordPlannerTurn = vi.fn();
const submitContextualPlan = vi.fn();
const submitMidRunAskTurn = vi.fn();
const settleAskJob = vi.fn();
const streamAskJob = vi.fn();
const peekMailbox = vi.fn();
const submitLateChanges = vi.fn();
const streamContextual = vi.fn();
const readPending = vi.fn();

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (openSession as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  resumeContextualSession: (...a: unknown[]) => resumeContextual(...a),
  recordPlannerTurn: (...a: unknown[]) => recordPlannerTurn(...a),
  submitContextualPlan: (...a: unknown[]) => submitContextualPlan(...a),
  attachMidRunTurn: vi.fn(),
  peekMailbox: (...a: unknown[]) => peekMailbox(...a),
  stopPlanChangeRun: vi.fn(),
  submitPlanChange: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: vi.fn(),
  rerunAskTurn: vi.fn(),
  submitMidRunAskTurn: (...a: unknown[]) => submitMidRunAskTurn(...a),
  settleAskJob: (...a: unknown[]) => settleAskJob(...a),
  submitLateChanges: (...a: unknown[]) => submitLateChanges(...a),
}));

vi.mock('@/lib/planning/planEditsClient', () => ({
  streamContextualPlanJob: (...a: unknown[]) => streamContextual(...a),
  streamAugmentJob: vi.fn(),
  streamAskJob: (...a: unknown[]) => streamAskJob(...a),
  PlanEditsClientError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null,
    ) {
      super(`Plan edits request failed (${status})`);
    }
  },
  OUT_OF_CREDITS_CODE: 'MOTIR_AI_OUT_OF_CREDITS',
}));

vi.mock('@/lib/planning/planReview', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReview')>()),
  readPendingProposal: (...a: unknown[]) => readPending(...a),
}));

vi.mock('@/lib/planning/planReviewClient', async (orig) => ({
  ...(await orig<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: () => new Promise(() => {}),
}));

const { usePlanChangeConversation } = await import('@/lib/hooks/usePlanChangeConversation');

const SESSION = {
  id: 's1',
  projectId: 'p1',
  turnCount: 0,
  targetKeys: [],
  lastJobId: null,
  lastSubmittedAt: null,
  turns: [],
  refs: {},
};

const TARGETS = [
  { id: 'wi-1', identifier: 'MOTIR-1', title: 'A card', kind: 'story' },
] as unknown as Parameters<ReturnType<typeof usePlanChangeConversation>['send']>[1];

function forwarded(...pairs: Array<[string, string]>) {
  return {
    outcome: 'forwarded' as const,
    delivery: {
      turns: pairs.map(([id, text]) => ({
        id,
        text,
        receivedAt: 'x',
        disposition: 'fold',
        target: null,
      })),
      stopped: false,
    },
    session: SESSION,
  };
}

/** A planning stream held open; on release it reports the job's end as `status`. */
function heldStream(status: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  streamContextual.mockImplementation(
    async (
      _anchor: string,
      _job: string,
      _signal: AbortSignal,
      _onError: unknown,
      _onDone: unknown,
      onFrame: (event: string, data: unknown) => void,
    ) => {
      await held;
      onFrame('status', { status });
    },
  );
  return release;
}

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: 'wi-1' }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

/** Start a run, forward `queuedTurns` mid-run, and end the stream with `status`. */
async function runThatEnds(
  status: string,
  queuedTurns: Array<[string, string]>,
): Promise<Awaited<ReturnType<typeof mounted>>> {
  const hook = await mounted();
  const release = heldStream(status);
  let promise!: Promise<void>;
  await act(async () => {
    promise = hook.result.current.send('Add a stop control.', TARGETS);
    await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
  if (queuedTurns.length > 0) {
    settleAskJob.mockResolvedValue(forwarded(...queuedTurns));
    await act(async () => {
      await hook.result.current.send('A late change.', TARGETS);
    });
    expect(hook.result.current.state.queued).toHaveLength(queuedTurns.length);
  }
  await act(async () => {
    release();
    await promise;
  });
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  openSession.mockResolvedValue(SESSION);
  resumeContextual.mockResolvedValue(SESSION);
  recordPlannerTurn.mockResolvedValue(SESSION);
  submitContextualPlan.mockResolvedValue({ jobId: 'job-1', planId: 'plan-1', session: SESSION });
  readPending.mockResolvedValue(null);
  submitMidRunAskTurn.mockResolvedValue({ jobId: 'ask-1', turnId: 't1', session: SESSION });
  streamAskJob.mockResolvedValue(undefined);
  peekMailbox.mockResolvedValue({ turns: [], stopped: false });
});

describe('the late-change claim at the end of a planning run', () => {
  it('claims ONCE when the run ends with a forwarded turn still queued, and a revision clears the queue', async () => {
    submitLateChanges.mockResolvedValue({
      outcome: 'revised',
      planId: 'plan-1',
      revisionJobId: 'job-rev-1',
      texts: ['A late change.', 'And another.'],
    });

    const hook = await runThatEnds('succeeded', [
      ['m1', 'A late change.'],
      ['m2', 'And another.'],
    ]);

    expect(submitLateChanges).toHaveBeenCalledTimes(1);
    expect(submitLateChanges).toHaveBeenCalledWith('s1', 'job-1', expect.anything());
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.lateRevision).toEqual({
      planId: 'plan-1',
      revisionJobId: 'job-rev-1',
      count: 2,
    });
    expect(hook.result.current.state.refusedForward).toBeNull();
  });

  it('never claims when nothing is queued', async () => {
    const hook = await runThatEnds('succeeded', []);

    expect(submitLateChanges).not.toHaveBeenCalled();
    expect(hook.result.current.state.lateRevision).toBeNull();
  });

  it('a refusal sets refusedForward with the texts joined and the code', async () => {
    submitLateChanges.mockResolvedValue({
      outcome: 'refused',
      code: 'PLAN_CHANGE_PLAN_DECIDED',
      texts: ['A late change.', 'And another.'],
      planStatus: 'approved',
    });

    const hook = await runThatEnds('succeeded', [
      ['m1', 'A late change.'],
      ['m2', 'And another.'],
    ]);

    expect(submitLateChanges).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.refusedForward).toEqual({
      text: 'A late change.\n\nAnd another.',
      code: 'PLAN_CHANGE_PLAN_DECIDED',
    });
    expect(hook.result.current.state.lateRevision).toBeNull();
    expect(hook.result.current.state.queued).toEqual([]);
  });

  it('also claims when the run was stopped (canceled)', async () => {
    submitLateChanges.mockResolvedValue({
      outcome: 'refused',
      code: 'PLAN_CHANGE_RUN_STOPPED',
      texts: ['A late change.'],
    });

    const hook = await runThatEnds('canceled', [['m1', 'A late change.']]);

    expect(submitLateChanges).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.refusedForward?.code).toBe('PLAN_CHANGE_RUN_STOPPED');
  });

  it('a none answer marks the queued turns read, and sets no revision or refusal', async () => {
    submitLateChanges.mockResolvedValue({ outcome: 'none' });

    const hook = await runThatEnds('succeeded', [['m1', 'A late change.']]);

    expect(submitLateChanges).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.queued).toEqual([
      { id: 'm1', text: 'A late change.', read: true },
    ]);
    expect(hook.result.current.state.lateRevision).toBeNull();
    expect(hook.result.current.state.refusedForward).toBeNull();
  });

  it('a failed claim keeps the turns queued and surfaces nothing', async () => {
    submitLateChanges.mockRejectedValue(new Error('network'));

    const hook = await runThatEnds('succeeded', [['m1', 'A late change.']]);

    expect(submitLateChanges).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.queued).toHaveLength(1);
    expect(hook.result.current.state.lateRevision).toBeNull();
  });
});

describe('the settle outcome revised_late', () => {
  it('sets lateRevision from the settle, with no queue and no refusal', async () => {
    const hook = await mounted();
    const release = heldStream('succeeded');
    let promise!: Promise<void>;
    await act(async () => {
      promise = hook.result.current.send('Add a stop control.', TARGETS);
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('streaming'));
    settleAskJob.mockResolvedValue({
      outcome: 'revised_late',
      planId: 'plan-1',
      revisionJobId: 'job-rev-1',
      text: 'A late change.',
      session: SESSION,
    });

    await act(async () => {
      await hook.result.current.send('A late change.', TARGETS);
    });

    expect(hook.result.current.state.lateRevision).toEqual({
      planId: 'plan-1',
      revisionJobId: 'job-rev-1',
      count: 1,
    });
    expect(hook.result.current.state.queued).toEqual([]);
    expect(hook.result.current.state.refusedForward).toBeNull();

    await act(async () => {
      release();
      await promise;
    });
    expect(submitLateChanges).not.toHaveBeenCalled();
  });
});
