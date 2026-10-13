// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { planReview } from '../helpers/planReview';
import { planRunPhase } from '@/lib/planning/planRunPhase';

// THE CONVERSATION PHASE ENDS AT `target_settled` (MOTIR-8203). A plan job carries
// its plan id from the submit, but PART 1 — settling the target, the entry and the
// requirement, and perhaps asking a question — runs inside that same job. So the hook
// records which job has settled, from the frame itself, and `planRunPhase` answers
// `conversation` until it arrives. A REOPENED overlay settles from the replay of the
// run's frames, so it agrees with a live viewer.

const { open, getSession, submit, stream, fetchReview, record, submitAsk, settleAsk, streamAsk } =
  vi.hoisted(() => ({
    open: vi.fn(),
    getSession: vi.fn(),
    submit: vi.fn(),
    stream: vi.fn(),
    fetchReview: vi.fn(),
    record: vi.fn(),
    submitAsk: vi.fn(),
    settleAsk: vi.fn(),
    streamAsk: vi.fn(),
  }));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  getPlanChangeSession: getSession,
  appendPlanChangeTurn: vi.fn(),
  submitPlanChange: submit,
  recordPlannerTurn: record,
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
  submitAskTurn: submitAsk,
  rerunAskTurn: vi.fn(),
  settleAskJob: settleAsk,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    streamAskJob: streamAsk,
    streamContextualPlanJob: vi.fn(),
  };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    fetchPlanReviewSince: fetchReview,
  };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';

type Frame = (event: string, data: unknown) => void;

function turn(
  role: PlanChangeTurnDto['role'],
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
) {
  return {
    id: `t-${role}-${body}`,
    seq: 1,
    role,
    body,
    jobId: role === 'user' ? null : 'job-1',
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-11T10:00:00.000Z',
    ...extra,
  } satisfies PlanChangeTurnDto;
}

function session(over: Partial<PlanChangeSessionDto> = {}): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: 'job-1',
    lastSubmittedAt: '2026-10-11T10:00:00.000Z',
    lastActivityAt: '2026-10-11T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
    turns: [],
    workItemRefs: {},
    ...over,
  };
}

/** A stream the test drives frame by frame, and ends when it says so. */
function heldStream() {
  let emit: Frame = () => {};
  let end: () => void = () => {};
  const impl = vi.fn(
    (_job: string, _signal: AbortSignal, _onError: unknown, _onDone: unknown, onFrame: Frame) =>
      new Promise<void>((resolve) => {
        emit = onFrame;
        end = resolve;
      }),
  );
  return {
    impl,
    emit: (event: string, data: unknown = {}) => act(() => emit(event, data)),
    end: () => act(async () => end()),
  };
}

beforeEach(() => {
  open.mockResolvedValue(session());
  record.mockResolvedValue(session());
  fetchReview.mockResolvedValue(null);
  submitAsk.mockImplementation(async (body: string) => ({
    jobId: 'ask-1',
    turnId: 't0',
    session: session({ turns: [turn('user', body)] }),
  }));
  // The ask READS the turn as a plan change and hands off to plan job `job-1`,
  // whose plan exists from the submit.
  settleAsk.mockResolvedValue({
    outcome: 'redirected',
    jobId: 'job-1',
    planId: 'plan-1',
    session: session({ turns: [turn('user', 'add payments')] }),
  });
  streamAsk.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a LIVE plan run', () => {
  it('is in its conversation phase until `target_settled`, then planning', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());
    expect(hook.result.current.state.planId).toBe('plan-1');
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    // PART 1 is still talking: no settlement yet.
    run.emit('conversation', { seq: 1 });
    run.emit('target_read', { seq: 2 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    run.emit('target_settled', { seq: 3, key: 'ACME-1', entry: 'lay' });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(planRunPhase(hook.result.current.state)).toBe('planning');

    await run.end();
    await act(async () => sent);
    expect(planRunPhase(hook.result.current.state)).toBeNull();
  });

  it('a job that comes back with a QUESTION never reaches the planning phase', async () => {
    const run = heldStream();
    stream.mockImplementation(run.impl);
    record.mockResolvedValue(
      session({
        turns: [
          turn('user', 'add payments'),
          turn('assistant', 'Which?', { question: 'Incoming or outgoing?' }),
        ],
      }),
    );
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));

    let sent!: Promise<void>;
    act(() => {
      sent = hook.result.current.send('add payments');
    });
    await waitFor(() => expect(run.impl).toHaveBeenCalled());
    run.emit('conversation', { seq: 1 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');

    await run.end();
    await act(async () => sent);
    expect(hook.result.current.state.settledJobId).toBeNull();
    expect(planRunPhase(hook.result.current.state)).toBeNull();
  });
});

describe('a REOPENED overlay mid-run', () => {
  const generating = planReview([], {
    id: 'plan-1',
    status: 'generating',
    authorSource: 'native',
    plannedAt: null,
  });

  beforeEach(() => {
    getSession.mockResolvedValue(session({ pendingPlanId: 'plan-1', lastJobId: 'job-1' }));
    fetchReview.mockResolvedValue(generating);
  });

  it('settles from the replay of the run’s frames, and closes the replay once it has it', async () => {
    const replay = heldStream();
    stream.mockImplementation(replay.impl);
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');
    await waitFor(() => expect(replay.impl).toHaveBeenCalled());
    expect(replay.impl.mock.calls[0]![0]).toBe('job-1');

    replay.emit('conversation', { seq: 1 });
    expect(planRunPhase(hook.result.current.state)).toBe('conversation');
    replay.emit('target_settled', { seq: 2 });
    expect(hook.result.current.state.settledJobId).toBe('job-1');
    expect(planRunPhase(hook.result.current.state)).toBe('planning');
    // The replay is read for that one frame and no further.
    const signal = replay.impl.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(replay.impl).toHaveBeenCalledTimes(1);
  });

  it('a plan an agent writes over MCP opens no replay: it has no conversation phase', async () => {
    fetchReview.mockResolvedValue({ ...generating, authorSource: 'mcp' });
    const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));

    await waitFor(() => expect(hook.result.current.state.liveReview?.status).toBe('generating'));
    expect(planRunPhase(hook.result.current.state)).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });
});
