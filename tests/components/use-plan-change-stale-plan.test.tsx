// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// A TURN OVER A STALE PLAN, as the overlay follows it (Story MOTIR-7928 ·
// MOTIR-7932; MOTIR-7945's outcome; design state 10). The answer is drawn as the
// stale notice, never as an error, and Plan it again opens ONE fresh plan — its
// two refusals are followed silently.

const {
  open,
  append,
  submit,
  stream,
  fetchReview,
  approve,
  decline,
  resumeAnchored,
  submitAnchored,
  resubmitAnchored,
  submitAsk,
  rerunAsk,
  settleAsk,
  streamAsk,
  readSession,
  startCopied,
} = vi.hoisted(() => ({
  open: vi.fn(),
  append: vi.fn(),
  submit: vi.fn(),
  stream: vi.fn(),
  fetchReview: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
  resumeAnchored: vi.fn(),
  submitAnchored: vi.fn(),
  resubmitAnchored: vi.fn(),
  submitAsk: vi.fn(),
  rerunAsk: vi.fn(),
  settleAsk: vi.fn(),
  streamAsk: vi.fn(),
  readSession: vi.fn(),
  startCopied: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  // The resume read answers `{ session, earlier }` (MOTIR-6024); these cases
  // mock the SESSION, so the factory wraps it.
  findResumableSession: async (...a: unknown[]) => ({
    session: await (open as (...args: unknown[]) => unknown)(...a),
    earlier: null,
  }),
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
  // The anchored half (MOTIR-910) is exercised by exactly one case here — the
  // retry that falls back to the ENTRANCE's anchor — and otherwise just has to
  // exist, because the module mock must carry every export the hook imports.
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
  resubmitContextualPlan: resubmitAnchored,
  submitAskTurn: submitAsk,
  rerunAskTurn: rerunAsk,
  settleAskJob: settleAsk,
  getPlanChangeSession: readSession,
  startCopiedSession: startCopied,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    streamAskJob: streamAsk,
  };
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
import {
  PlanAgainNotAvailableClientError,
  PlanSessionPlanDecidedClientError,
  PlanSessionPlanStaleClientError,
} from '@/lib/planning/planSessionClientErrors';
import { planReview, planReviewItem } from '../helpers/planReview';

function session(bodies: string[], id = 's1'): PlanChangeSessionDto {
  return {
    id,
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `${id}-t${seq}`,
      seq,
      role: 'user' as const,
      body,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: null,
      intentCorrected: false,
      citations: [],
      authorId: 'u1',
      createdAt: '2026-07-27T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

const FINISHED = [
  { id: 'w41', key: 'ACME-41', title: 'CSV export', status: 'done', statusLabel: 'Done' },
  { id: 'w43', key: 'ACME-43', title: 'PDF report', status: 'done', statusLabel: 'Done' },
];

const staleRefusal = (finishedCards = FINISHED) =>
  new PlanSessionPlanStaleClientError(409, {}, 'plan_s', finishedCards);

const FRESH = planReview(
  [planReviewItem({ planItemId: 'pi_9', nodeId: 'pi_9', kind: 'story', title: 'Fresh' })],
  { id: 'plan_new' },
);

beforeEach(() => {
  open.mockResolvedValue(session(['Split ACME-40.']));
  stream.mockImplementation(async () => {});
  streamAsk.mockImplementation(async () => {});
  // The thread as the server holds it once the refused turn was appended.
  readSession.mockImplementation(async () => session(['Split ACME-40.', 'Move PDF.']));
  fetchReview.mockResolvedValue(FRESH);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted() {
  const hook = renderHook(() => usePlanChangeConversation());
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

async function staleThread() {
  submitAsk.mockRejectedValue(staleRefusal());
  const hook = await mounted();
  await act(async () => {
    await hook.result.current.send('Move PDF.');
  });
  await waitFor(() => expect(hook.result.current.state.stalePlan).toBeTruthy());
  return hook;
}

describe('a turn over a STALE plan', () => {
  it('keeps the turn, holds the stale answer under it, and shows NO error', async () => {
    const { result } = await staleThread();
    const stale = result.current.state.stalePlan!;
    expect(stale.planId).toBe('plan_s');
    expect(stale.finishedCards.map((c) => c.key)).toEqual(['ACME-41', 'ACME-43']);
    // Re-read so the appended turn is in the thread, and the notice sits under it.
    expect(readSession).toHaveBeenCalledWith('s1', expect.anything());
    expect(result.current.state.session?.turns.at(-1)?.body).toBe('Move PDF.');
    expect(stale.turnId).toBe('s1-t1');
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.acts).toEqual([]);
  });

  it('no nameable item still answers — with an empty list for the generic sentence', async () => {
    submitAsk.mockRejectedValue(staleRefusal([]));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Move PDF.');
    });
    await waitFor(() => expect(result.current.state.stalePlan?.finishedCards).toEqual([]));
    expect(result.current.state.errorCode).toBeNull();
  });

  it('the same answer on the session a CARRY just made', async () => {
    const endedWaiting: PlanChangeSessionDto = {
      ...session(['Split ACME-40.']),
      endedAt: '2026-07-27T11:00:00.000Z',
      endReason: 'restarted',
      startedByViewer: true,
      pendingPlanId: 'plan_s',
    };
    readSession.mockResolvedValueOnce(endedWaiting);
    fetchReview.mockResolvedValueOnce({ ...FRESH, id: 'plan_s' });
    startCopied.mockResolvedValue(session(['Split ACME-40.', 'Move PDF.'], 's2'));
    submit.mockRejectedValue(staleRefusal());
    readSession.mockImplementation(async () => session(['Split ACME-40.', 'Move PDF.'], 's2'));
    const { result } = renderHook(() =>
      usePlanChangeConversation({ sessionId: 's1', onRestarted: vi.fn() }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    await act(async () => {
      await result.current.send('Move PDF.');
    });
    await waitFor(() => expect(result.current.state.stalePlan?.planId).toBe('plan_s'));
    expect(result.current.state.session?.id).toBe('s2');
    expect(result.current.state.stalePlan?.turnId).toBe('s2-t1');
    expect(result.current.state.errorCode).toBeNull();
  });
});

describe('Plan it again', () => {
  it('submits ONCE with planAgainOf, ignores a second press, and attaches to the new plan', async () => {
    const { result } = await staleThread();
    const pending = deferred();
    submit.mockReturnValue(pending.promise);

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.planAgain();
    });
    expect(result.current.state.stalePlan?.pressing).toBe(true);
    await act(async () => {
      await result.current.planAgain();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('s1', expect.anything(), { planAgainOf: 'plan_s' });

    pending.resolve({ jobId: 'job-new', planId: 'plan_new', session: session(['x']) });
    await act(async () => {
      await first;
    });
    expect(stream).toHaveBeenCalledWith(
      'job-new',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result.current.state.planId).toBe('plan_new');
    expect(result.current.state.stalePlan?.outcome).toBe('accepted');
    expect(result.current.state.stalePlan?.pressing).toBe(false);
  });

  it('a plan restored before the press is revised in place, and says so', async () => {
    const { result } = await staleThread();
    submit.mockResolvedValue({ jobId: 'job-r', planId: 'plan_s', session: session(['x']) });
    await act(async () => {
      await result.current.planAgain();
    });
    expect(result.current.state.stalePlan?.outcome).toBe('restored');
    expect(result.current.state.planId).toBe('plan_s');
  });

  it('ANOTHER press won: re-reads the session and follows the latest plan, silently', async () => {
    const { result } = await staleThread();
    submit.mockRejectedValue(
      new PlanAgainNotAvailableClientError(409, {}, 'superseded', 'plan_new'),
    );
    readSession.mockClear();
    await act(async () => {
      await result.current.planAgain();
    });
    await waitFor(() => expect(result.current.state.review?.id).toBe('plan_new'));
    expect(readSession).toHaveBeenCalledWith('s1', expect.anything());
    expect(result.current.state.planId).toBe('plan_new');
    expect(result.current.state.stalePlan?.outcome).toBe('superseded');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('DECIDED meanwhile: the notice takes the decide door’s refusal, never a code', async () => {
    const { result } = await staleThread();
    submit.mockRejectedValue(new PlanSessionPlanDecidedClientError(409, {}, 'plan_s', 'declined'));
    await act(async () => {
      await result.current.planAgain();
    });
    expect(result.current.state.stalePlan?.outcome).toBe('refused');
    expect(result.current.state.errorCode).toBeNull();
  });

  it('a send while the action is still offered clears the notice; one acted on stays', async () => {
    const { result } = await staleThread();
    submitAsk.mockResolvedValue({ jobId: 'ask-2', turnId: 't9', session: session(['y']) });
    settleAsk.mockResolvedValue({ outcome: 'silent', session: session(['y']) });
    await act(async () => {
      await result.current.send('Never mind.');
    });
    expect(result.current.state.stalePlan ?? null).toBeNull();
  });
});

interface Deferred {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
