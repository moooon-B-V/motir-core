// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// The CLIENT half of the planner's turn (MOTIR-2226): when a run settles, the
// browser is the only thing that saw it finish — motir-ai calls no webhook back
// — so it is what asks the server to read the result and file the utterance.
//
// Three behaviours are worth pinning, and each is a bug if it goes the other way:
//   * the recording happens on SETTLE, and its thread replaces the local one, so
//     the report/question appears without a reload;
//   * a failed recording costs the NARRATION, never the run — the proposals are
//     already on the canvas;
//   * a turn that ASKED proposes nothing BY DESIGN, so the "nothing came back to
//     change" error must not fire on the one turn with the most to say.

const { open, append, submit, stream, fetchReview, approve, decline, record } = vi.hoisted(() => ({
  open: vi.fn(),
  append: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  openPlanChangeSession: open,
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
  recordPlannerTurn: record,
  resumeContextualSession: vi.fn(),
  submitContextualPlan: vi.fn(),
  resubmitContextualPlan: vi.fn(),
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, streamAugmentJob: stream, streamContextualPlanJob: vi.fn() };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';

let n = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  n += 1;
  return {
    id: `t${n}`,
    seq: n,
    role,
    body,
    jobId: role === 'user' ? null : 'job-1',
    question: null,
    isAnswer: false,
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-08-05T10:00:00.000Z',
    ...extra,
  };
}

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: 'job-1',
    lastSubmittedAt: '2026-08-05T10:00:00.000Z',
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

/** A stream that settles successfully with no frames. */
const okStream = () =>
  vi.fn(async () => {
    /* settles immediately */
  });

beforeEach(() => {
  n = 0;
  open.mockResolvedValue(session([]));
  append.mockImplementation(async (body: string) => session([turn('user', body)]));
  submit.mockResolvedValue({ jobId: 'job-1', planId: null, session: session([]) });
  stream.mockImplementation(okStream());
  record.mockReset();
  record.mockResolvedValue(session([]));
  fetchReview.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function sendOne(
  hook: ReturnType<typeof renderHook<ReturnType<typeof usePlanChangeConversation>, unknown>>,
) {
  await act(async () => {
    await hook.result.current.send('add payments');
  });
}

describe('recording the planner turn on settle', () => {
  it('records it for the settled job and adopts the returned thread', async () => {
    const asked = session([
      turn('user', 'add payments'),
      turn('system', 'sent'),
      turn('assistant', 'Which direction?', { question: 'in, or out?' }),
    ]);
    record.mockResolvedValue(asked);

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    expect(record).toHaveBeenCalledWith('job-1', null, expect.anything());
    // The narration lands without a reload — the thread the server returned is
    // the one the rail now renders.
    await waitFor(() =>
      expect(hook.result.current.state.session?.turns.at(-1)?.question).toBe('in, or out?'),
    );
  });

  it('a FAILED recording costs the narration, not the run', async () => {
    record.mockRejectedValue(new Error('boom'));

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    // The run itself completed; the thread simply carries no planner turn.
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    expect(hook.result.current.state.outOfCredits).toBe(false);
  });

  it('does NOT record when the stream reported a failure', async () => {
    stream.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('FAILED');
      },
    );

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    // Nothing settled, so there is no result to read — and a run that never
    // produced an utterance must not be asked for one.
    expect(record).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.state.errorCode).toBe('FAILED'));
  });
});

describe('a question is an OUTCOME, not an empty result', () => {
  it('suppresses the "nothing came back" error when the planner ASKED', async () => {
    record.mockResolvedValue(
      session([turn('user', 'add payments'), turn('assistant', 'Which?', { question: 'in/out?' })]),
    );

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    // The canvas stays untouched while the planner is blocked (design state B),
    // so "nothing came back to change" would be a false error here.
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    expect(hook.result.current.state.errorCode).toBeNull();
  });

  it('still reports EMPTY when the turn only REPORTED and proposed nothing', async () => {
    record.mockResolvedValue(
      session([turn('user', 'add payments'), turn('assistant', 'I found nothing to change.')]),
    );

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    await waitFor(() => expect(hook.result.current.state.errorCode).toBe('EMPTY'));
  });
});

describe('the answer flag is derived from the thread the user was looking at', () => {
  it('flags the turn as an ANSWER when a question is pending', async () => {
    open.mockResolvedValue(
      session([turn('assistant', 'Which direction?', { question: 'in, or out?' })]),
    );

    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await act(async () => {
      await hook.result.current.send('money in');
    });

    // The same derivation the composer used to show the answer bar — so the
    // recorded disposition and the affordance that sent it cannot disagree.
    expect(append).toHaveBeenCalledWith('money in', expect.anything(), true);
  });

  it('does NOT flag it when nothing is pending', async () => {
    const hook = renderHook(() => usePlanChangeConversation());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
    await sendOne(hook);

    expect(append).toHaveBeenCalledWith('add payments', expect.anything(), false);
  });
});
