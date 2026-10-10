// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// THE SESSION'S END, as the overlay's state machine follows it (Story MOTIR-7630 ·
// MOTIR-7643; AMENDMENT 23 §2–§6). What the rail draws is the SERVER's row, so
// these cases pin the reads and the refusals that put it into state:
//
//   * a failed attempt RE-READS the session, and an ended one replaces the thread;
//   * an ended session takes no Retry and no send;
//   * another holder's card is refused IN PLACE — on open and on a send's 409 —
//     never as the generic failure;
//   * Start a new session swaps onto the copied session with nothing carried over.

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
  resumeSession,
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
  resumeSession: vi.fn(),
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
  // Story MOTIR-7905 · MOTIR-7918: the failed-waiting session's Resume door.
  resumePlanSession: resumeSession,
  resumeAlreadyStartedJobId: (err: { code?: string; body?: { jobId?: string } } | null) =>
    err?.code === 'RESUME_ALREADY_STARTED' ? (err.body?.jobId ?? null) : null,
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

import {
  usePlanChangeConversation,
  targetHeldFrom,
  sessionEnded,
  sessionFailed,
  sessionAwaitsResume,
  SESSION_END_REREAD_MS,
} from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanSessionPlanDecidedClientError } from '@/lib/planning/planSessionClientErrors';
import { planReview, planReviewItem } from '../helpers/planReview';

function session(bodies: string[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns: bodies.map((body, seq) => ({
      id: `t${seq}`,
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

const ENDED_AT = '2026-07-27T11:00:00.000Z';

function ended(s: PlanChangeSessionDto, reason: 'failed' | 'idle' = 'failed') {
  return { ...s, endedAt: ENDED_AT, endReason: reason };
}

const HELD = {
  target: 'ACME-40',
  holder: 'Mara',
  freesBy: '2026-07-27T12:30:00.000Z',
  holderSessionId: 's_mara',
};

beforeEach(() => {
  open.mockResolvedValue(session(['Add recurring invoices.']));
  resumeAnchored.mockResolvedValue({ session: null, planId: null });
  stream.mockImplementation(async () => {});
  streamAsk.mockImplementation(async () => {});
  readSession.mockImplementation(async () => session(['Add recurring invoices.']));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function mounted(opts: { anchorId?: string } = {}) {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId: opts.anchorId ?? null }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('the pure readers', () => {
  it('reads a 409 PLAN_TARGET_LOCKED body as the holder and its free-by — nothing else', () => {
    expect(targetHeldFrom(new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED', HELD))).toEqual({
      ...HELD,
      sessionWaiting: false,
      waitingCause: null,
    });
    // A plan's hold carries no free-by and may carry no name.
    expect(
      targetHeldFrom(new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED', { target: 'ACME-40' })),
    ).toEqual({
      target: 'ACME-40',
      holder: null,
      freesBy: null,
      holderSessionId: null,
      sessionWaiting: false,
      waitingCause: null,
    });
    expect(targetHeldFrom(new PlanEditsClientError(500, null))).toBeNull();
    expect(targetHeldFrom(new Error('boom'))).toBeNull();
    // A 409 with no body still reads as a refusal, with nothing named.
    expect(targetHeldFrom(new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED'))).toEqual({
      target: '',
      holder: null,
      freesBy: null,
      holderSessionId: null,
      sessionWaiting: false,
      waitingCause: null,
    });
  });

  it('reads sessionWaiting and its cause off the 409 (MOTIR-7918); absent ⇒ false', () => {
    expect(
      targetHeldFrom(
        new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED', {
          ...HELD,
          sessionWaiting: true,
          waitingCause: 'failed',
        }),
      ),
    ).toMatchObject({ sessionWaiting: true, waitingCause: 'failed' });
    expect(
      targetHeldFrom(
        new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED', { ...HELD, waitingCause: 'nonsense' }),
      ),
    ).toMatchObject({ sessionWaiting: false, waitingCause: null });
  });

  it('a session has ended only when the SERVER row says so', () => {
    expect(sessionEnded(null)).toBe(false);
    expect(sessionEnded(session([]))).toBe(false);
    expect(sessionEnded(ended(session([])))).toBe(true);
  });
});

describe('a failed attempt ENDS the session (AMENDMENT 23 §2)', () => {
  it('re-reads the session after a refused send and draws the server’s end', async () => {
    submitAsk.mockRejectedValue(new PlanEditsClientError(409, 'PLAN_SESSION_ENDED'));
    readSession.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Try once more.');
    });
    await waitFor(() => expect(result.current.state.session?.endedAt).toBe(ENDED_AT));
    expect(readSession).toHaveBeenCalledWith('s1', expect.anything());
    expect(result.current.state.session?.endReason).toBe('failed');
  });

  it('a stream that FAILS re-reads the session — an open one is left alone, its error recoverable', async () => {
    submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't0', session: session(['x']) });
    streamAsk.mockImplementation(
      async (_job: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('PLANNER_FAILED');
      },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await mounted();

    await act(async () => {
      const sent = result.current.send('Split it.');
      await vi.advanceTimersByTimeAsync(SESSION_END_REREAD_MS * 3);
      await sent;
    });
    // Re-read until the relay could have ended it; it never did.
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(result.current.state.session?.endedAt ?? null).toBeNull();
    expect(result.current.state.errorCode).not.toBeNull();
  });

  it('Try again works while the end re-read is still waiting — the failed run is over', async () => {
    submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't0', session: session(['x']) });
    rerunAsk.mockResolvedValue({ jobId: 'ask-2', turnId: 't0', session: session(['x']) });
    streamAsk.mockImplementation(
      async (_job: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('PLANNER_FAILED');
      },
    );
    // The first re-read never answers, so the failed send is still settling.
    readSession.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = await mounted();

    await act(async () => {
      void result.current.send('Split it.');
    });
    await waitFor(() => expect(result.current.state.errorCode).not.toBeNull());

    await act(async () => {
      await result.current.retry();
    });
    expect(rerunAsk).toHaveBeenCalledWith('t0', expect.anything(), expect.anything());
  });

  it('takes NO Retry and NO send inside an ended session — the only way on is a new one', async () => {
    open.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    const { result } = await mounted();
    expect(result.current.state.session?.endedAt).toBe(ENDED_AT);

    await act(async () => {
      await result.current.retry();
      await result.current.send('Anything?');
    });
    expect(submitAsk).not.toHaveBeenCalled();
    expect(rerunAsk).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe('another holder’s card is refused IN PLACE (AMENDMENT 23 §4)', () => {
  it('on OPEN: the item’s resume names the holder before anything is typed', async () => {
    resumeAnchored.mockResolvedValue({ session: null, planId: null, heldBy: HELD });
    const { result } = await mounted({ anchorId: 'wi_40' });
    expect(result.current.state.targetHeld).toEqual(HELD);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('on a SEND: the 409 is a refusal, not the generic failure — and nothing streams', async () => {
    submitAsk.mockRejectedValue(new PlanEditsClientError(409, 'PLAN_TARGET_LOCKED', HELD));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Split ACME-40.');
    });
    expect(result.current.state.targetHeld).toEqual({
      ...HELD,
      sessionWaiting: false,
      waitingCause: null,
    });
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.phase).toBe('idle');
    expect(streamAsk).not.toHaveBeenCalled();
  });
});

describe('Start a new session (AMENDMENT 23 §6)', () => {
  it('swaps onto the copied session in place, carrying none of the ended run’s state', async () => {
    open.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    const copied = {
      ...session(['Add recurring invoices.']),
      id: 's2',
      createdAt: '2026-07-27T12:00:00.000Z',
      copiedFromSessionId: 's1',
    };
    startCopied.mockResolvedValue(copied);
    const { result } = await mounted();

    await act(async () => {
      await result.current.startCopied();
    });
    expect(startCopied).toHaveBeenCalledWith('s1');
    expect(result.current.state.session).toEqual(copied);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.acts).toEqual([]);
    // Nothing was sent: the copy only carries the conversation.
    expect(submitAsk).not.toHaveBeenCalled();
  });

  it('does nothing on a session that has NOT ended', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.startCopied();
    });
    expect(startCopied).not.toHaveBeenCalled();
  });

  it('a failed copy is the recoverable session error, and the ended thread stays', async () => {
    open.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    startCopied.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.startCopied();
    });
    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
    expect(result.current.state.session?.id).toBe('s1');
  });

  it('an ABORTED copy is no error at all, and the ended thread stays', async () => {
    open.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    startCopied.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.startCopied();
    });
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.session?.id).toBe('s1');
  });

  it.each([
    ['answers', (d: Deferred) => d.resolve({ ...session([]), id: 's2' })],
    ['fails', (d: Deferred) => d.reject(new PlanEditsClientError(500, null))],
  ])('a copy that %s after the overlay closed writes nothing', async (_label, settle) => {
    open.mockResolvedValue(ended(session(['Add recurring invoices.'])));
    const pending = deferred();
    startCopied.mockReturnValue(pending.promise);
    const { result, unmount } = await mounted();
    const copying = result.current.startCopied();
    unmount();
    settle(pending);
    await act(async () => {
      await copying;
    });
    expect(startCopied).toHaveBeenCalledWith('s1');
  });
});

// ── THE CARRY (Story MOTIR-7928 · MOTIR-7932; design states 3–6) ───────────
//
// The first send on an ENDED session whose plan still waits calls the carry, and
// the overlay follows whichever of the server's three answers comes back.

const WAITING = planReview(
  [planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'CSV' })],
  { id: 'plan_w' },
);

function waitingSession(): PlanChangeSessionDto {
  return {
    ...ended(session(['Split ACME-40.'])),
    endReason: 'restarted',
    startedByViewer: true,
    viewerCanPlan: true,
    pendingPlanId: 'plan_w',
  };
}

const CARRIED: PlanChangeSessionDto = {
  ...session(['Split ACME-40.', 'Put PDF in this sprint.']),
  id: 's2',
  createdAt: '2026-07-27T12:00:00.000Z',
  copiedFromSessionId: 's1',
};

async function mountedOnWaiting(onRestarted = vi.fn()) {
  readSession.mockResolvedValue(waitingSession());
  fetchReview.mockResolvedValue(WAITING);
  const hook = renderHook(() => usePlanChangeConversation({ sessionId: 's1', onRestarted }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe('review'));
  return { ...hook, onRestarted };
}

describe('the CARRY — the first send on an ended session whose plan waits', () => {
  it('calls the carry ONCE with the words — never the ordinary turn — and holds the turn pending', async () => {
    const pending = deferred();
    startCopied.mockReturnValue(pending.promise);
    const { result } = await mountedOnWaiting();

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.send('Put PDF in this sprint.');
    });
    expect(result.current.state.carrying).toEqual({ text: 'Put PDF in this sprint.' });
    // A second send while the carry is in flight makes no second call.
    await act(async () => {
      await result.current.send('Again.');
    });
    expect(startCopied).toHaveBeenCalledTimes(1);
    expect(startCopied).toHaveBeenCalledWith(
      's1',
      { body: 'Put PDF in this sprint.', isAnswer: false, anchorKey: null },
      expect.anything(),
    );
    expect(submitAsk).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    // The plan stays decidable while the carry is in flight.
    expect(result.current.state.review?.id).toBe('plan_w');

    pending.resolve({ ...CARRIED, takenBack: false });
    submit.mockResolvedValue({ jobId: 'job-r', planId: 'plan_w', session: CARRIED });
    await act(async () => {
      await first;
    });
  });

  it('CARRIED: swaps through the restart’s path, marks it carried, and revises the SAME plan', async () => {
    startCopied.mockResolvedValue(CARRIED);
    submit.mockResolvedValue({ jobId: 'job-r', planId: 'plan_w', session: CARRIED });
    const { result, onRestarted } = await mountedOnWaiting();

    await act(async () => {
      await result.current.send('Put PDF in this sprint.');
    });
    expect(onRestarted).toHaveBeenCalledWith('s2');
    expect(result.current.state.session?.id).toBe('s2');
    expect(result.current.state.carriedFrom).toBe('s1');
    expect(result.current.state.carrying).toBeNull();
    // The planner answers the turn already appended: the session's own submit.
    expect(submit).toHaveBeenCalledWith('s2', expect.anything());
    expect(stream).toHaveBeenCalledWith(
      'job-r',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result.current.state.planId).toBe('plan_w');
    expect(result.current.state.takenBackWaitingPlanId ?? null).toBeNull();
  });

  it('TAKEN BACK: swaps to the open session, keeps the waiting plan to lead back to, runs nothing', async () => {
    const open2 = {
      ...session(['Other scope.', 'Put PDF in this sprint.']),
      id: 's_open',
      takenBack: true,
    };
    startCopied.mockResolvedValue(open2);
    const { result, onRestarted } = await mountedOnWaiting();

    await act(async () => {
      await result.current.send('Put PDF in this sprint.');
    });
    expect(onRestarted).toHaveBeenCalledWith('s_open');
    expect(result.current.state.session?.id).toBe('s_open');
    expect(result.current.state.takenBackWaitingPlanId).toBe('plan_w');
    expect(result.current.state.carriedFrom ?? null).toBeNull();
    expect(result.current.state.review).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('DECIDED while typing: the session does not change, the words are kept, the plan reads decided', async () => {
    startCopied.mockRejectedValue(
      new PlanSessionPlanDecidedClientError(409, {}, 'plan_w', 'approved'),
    );
    const { result, onRestarted } = await mountedOnWaiting();
    fetchReview.mockResolvedValue({ ...WAITING, status: 'approved' });
    readSession.mockResolvedValue({ ...waitingSession(), pendingPlanId: null });

    await act(async () => {
      await result.current.send('Put PDF in this sprint.');
    });
    expect(onRestarted).not.toHaveBeenCalled();
    expect(result.current.state.session?.id).toBe('s1');
    expect(result.current.state.session?.pendingPlanId).toBeNull();
    expect(result.current.state.carryDecided).toEqual({ text: 'Put PDF in this sprint.' });
    expect(result.current.state.decided).toBe('accepted');
    expect(result.current.state.errorCode).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('another member’s send goes nowhere: an ended session they did not start carries nothing', async () => {
    readSession.mockResolvedValue({ ...waitingSession(), startedByViewer: false });
    fetchReview.mockResolvedValue(WAITING);
    const { result } = renderHook(() => usePlanChangeConversation({ sessionId: 's1' }));
    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    await act(async () => {
      await result.current.send('Mine now.');
    });
    expect(startCopied).not.toHaveBeenCalled();
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

// ── A FAILED HOSTED ATTEMPT WAITS TO BE RESUMED (Story MOTIR-7905 · MOTIR-7918) ──

const FAILURE = {
  failedAt: '2026-07-27T11:00:00.000Z',
  reason: 'rate_limited' as const,
  stopPhase: 'author' as const,
  stopRef: 'ACME-20',
  stopTitle: 'Export a report',
};
const failedSession = (over: Partial<NonNullable<PlanChangeSessionDto['failure']>> = {}) => ({
  ...session(['Add recurring invoices.']),
  failure: { ...FAILURE, ...over },
});

describe('the pure readers for a session waiting on a failure', () => {
  it('failed-waiting is read from the server’s row, and an ended session is never it', () => {
    expect(sessionFailed(null)).toBe(false);
    expect(sessionFailed(session([]))).toBe(false);
    expect(sessionFailed(failedSession())).toBe(true);
    expect(sessionFailed({ ...failedSession(), endedAt: ENDED_AT, endReason: 'failed' })).toBe(
      false,
    );
  });

  it('only a resumable failure awaits RESUME; situation 2 (resumable: false) takes a turn', () => {
    expect(sessionAwaitsResume(failedSession())).toBe(true);
    expect(sessionAwaitsResume(failedSession({ resumable: true }))).toBe(true);
    expect(sessionAwaitsResume(failedSession({ resumable: false }))).toBe(false);
  });
});

describe('after a failed stream', () => {
  it('adopts a row that carries `failure` (and no end) — the rail then draws the failure line', async () => {
    submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't0', session: session(['x']) });
    streamAsk.mockImplementation(
      async (_job: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('PLANNER_FAILED');
      },
    );
    readSession.mockResolvedValue(failedSession());
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Split it.');
    });
    await waitFor(() => expect(result.current.state.session?.failure?.reason).toBe('rate_limited'));
    expect(result.current.state.session?.endedAt ?? null).toBeNull();
  });

  it('a re-read that returns `endedAt` still draws the end marker as before', async () => {
    submitAsk.mockResolvedValue({ jobId: 'ask-1', turnId: 't0', session: session(['x']) });
    streamAsk.mockImplementation(
      async (_job: string, _signal: AbortSignal, onError: (code: string | null) => void) => {
        onError('PLANNER_FAILED');
      },
    );
    readSession.mockResolvedValue(ended(session(['x'])));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Split it.');
    });
    await waitFor(() => expect(result.current.state.session?.endedAt).toBe(ENDED_AT));
  });
});

describe('Retry inside a session waiting to resume', () => {
  it('submits nothing — it would open a second plan beside the held one', async () => {
    open.mockResolvedValue(failedSession());
    const { result } = await mounted();
    expect(result.current.state.session?.failure).toBeTruthy();
    await act(async () => {
      await result.current.retry();
    });
    expect(submit).not.toHaveBeenCalled();
    expect(submitAnchored).not.toHaveBeenCalled();
    expect(resubmitAnchored).not.toHaveBeenCalled();
    expect(rerunAsk).not.toHaveBeenCalled();
  });
});

describe('Resume', () => {
  const RESUMED = {
    jobId: 'job-9',
    planId: 'plan-3',
    session: session(['Add recurring invoices.']),
  };

  it('calls the door ONCE (even on a double press), reads resuming, and attaches the returned job on the returned plan', async () => {
    open.mockResolvedValue(failedSession());
    let release!: (v: unknown) => void;
    resumeSession.mockReturnValue(new Promise((r) => (release = r)));
    stream.mockImplementation(async () => {});
    const { result } = await mounted();

    await act(async () => {
      void result.current.resume();
      void result.current.resume();
    });
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledWith('s1', expect.anything());
    expect(result.current.state.resuming).toBe(true);

    await act(async () => release(RESUMED));
    await waitFor(() => expect(stream).toHaveBeenCalled());
    expect(stream.mock.calls[0]![0]).toBe('job-9');
    expect(result.current.state.planId).toBe('plan-3');
    // The new attempt's row carries no failure — Resume cleared it server-side.
    expect(result.current.state.session?.failure ?? null).toBeNull();
    await waitFor(() => expect(result.current.state.resuming).toBe(false));
  });

  it('RESUME_ALREADY_STARTED attaches to the winning job it carries — no error', async () => {
    open.mockResolvedValue(failedSession());
    resumeSession.mockRejectedValue(
      new PlanEditsClientError(409, 'RESUME_ALREADY_STARTED', { jobId: 'job-winner' }),
    );
    stream.mockImplementation(async () => {});
    const { result } = await mounted();
    await act(async () => {
      await result.current.resume();
    });
    expect(stream.mock.calls[0]![0]).toBe('job-winner');
    expect(result.current.state.resumeError ?? null).toBeNull();
  });

  it.each(['SESSION_NOT_FAILED', 'PLAN_NOT_RESUMABLE', 'NOT_SESSION_OWNER', 'PLAN_SESSION_ENDED'])(
    '%s keeps the failure line and holds the code beside it',
    async (code) => {
      open.mockResolvedValue(failedSession());
      resumeSession.mockRejectedValue(new PlanEditsClientError(409, code));
      const { result } = await mounted();
      await act(async () => {
        await result.current.resume();
      });
      expect(result.current.state.resumeError).toBe(code);
      expect(result.current.state.session?.failure?.reason).toBe('rate_limited');
      expect(stream).not.toHaveBeenCalled();
    },
  );

  it('out of credits reads as the credit code', async () => {
    open.mockResolvedValue(failedSession());
    resumeSession.mockRejectedValue(new PlanEditsClientError(402, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.resume();
    });
    expect(result.current.state.resumeError).toBe('MOTIR_AI_OUT_OF_CREDITS');
  });

  it('does nothing on a session that is not waiting to resume', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.resume();
    });
    expect(resumeSession).not.toHaveBeenCalled();
  });
});
