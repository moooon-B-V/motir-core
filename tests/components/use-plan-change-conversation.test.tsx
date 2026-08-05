// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The conversation LOOP (Subtask MOTIR-1730, re-pointed at the PLAN by
// MOTIR-1746): open/resume → append a turn → submit the ACCUMULATED intent →
// stream → read the run's PROPOSALS from its Plan → approve (materialize) or
// discard (decline). The session seam (MOTIR-1728), the job stream and the plans
// API are mocked, so what is under test is the state machine the rail and the
// canvas both read.

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
  streamAnchored,
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
  streamAnchored: vi.fn(),
}));

vi.mock('@/lib/planning/planChangeClient', () => ({
  openPlanChangeSession: open,
  appendPlanChangeTurn: append,
  submitPlanChange: submit,
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
  resubmitContextualPlan: resubmitAnchored,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return {
    ...actual,
    streamAugmentJob: stream,
    streamContextualPlanJob: streamAnchored,
  };
});

// The PLANS API — the same client the `/plans/[id]` island calls. Reviewing and
// confirming both go through it now; there is no second write path to mock.
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    fetchPlanReview: fetchReview,
    approvePlanRequest: approve,
    declinePlanRequest: decline,
  };
});

import { usePlanChangeConversation, narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanRequestError } from '@/lib/planning/planReviewClient';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

function session(bodies: string[], targetKeys: string[] = []): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys,
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
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
      authorId: 'u1',
      createdAt: '2026-07-27T10:00:00.000Z',
    })),
    workItemRefs: {},
  };
}

/** What the run PROPOSED, as its Plan reads back. */
const REVIEW = planReview([
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', kind: 'story', title: 'Recurring' }),
]);

/** What `materialize` returns — the same plan, now `approved`, its `add` bound to
 *  the work item it created. */
const MATERIALIZED: PlanWithItemsDto = {
  id: 'plan-1',
  projectId: 'proj_1',
  status: 'approved',
  title: null,
  summary: null,
  sourceJobId: 'job-1',
  // A rail-driven run is `user`-origin; the auto-plan watcher's is `cadence`
  // (MOTIR-916) — same Plan, same review, same confirm, per this card's
  // invariant that the trigger is irrelevant.
  origin: 'user',
  itemCount: 1,
  createdAt: '2026-07-27T09:00:00.000Z',
  plannedAt: '2026-07-27T09:01:00.000Z',
  decidedAt: '2026-07-27T09:05:00.000Z',
  decidedById: 'u1',
  items: [
    {
      id: 'pi_1',
      op: 'add',
      workItemId: 'wi_new',
      proposedFields: { title: 'Recurring' },
      patch: null,
      parentRef: null,
      blockedByRefs: [],
      baseRevision: null,
      createdAt: '2026-07-27T09:01:00.000Z',
    },
  ],
};

/** A stream that immediately reports success, optionally emitting progress frames. */
function okStream(frames: Array<[string, unknown]> = []) {
  return vi.fn(
    async (
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      for (const [event, data] of frames) onFrame?.(event, data);
    },
  );
}

beforeEach(() => {
  open.mockResolvedValue(session([]));
  append.mockImplementation(async (body: string) => session([body]));
  submit.mockResolvedValue({
    jobId: 'job-1',
    planId: 'plan-1',
    session: session(['Add recurring invoices.']),
  });
  stream.mockImplementation(okStream());
  fetchReview.mockResolvedValue(REVIEW);
  approve.mockResolvedValue(MATERIALIZED);
  decline.mockResolvedValue({ ...MATERIALIZED, status: 'declined', items: [] });
  resumeAnchored.mockResolvedValue({ session: null, planId: null });
  submitAnchored.mockResolvedValue({
    jobId: 'job-anchored-1',
    planId: 'plan-anchored-1',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  resubmitAnchored.mockResolvedValue({
    jobId: 'job-anchored-2',
    planId: 'plan-anchored-2',
    sessionId: 's1',
    session: session(['Split this story.']),
  });
  streamAnchored.mockImplementation(
    async (
      _anchorId: string,
      _jobId: string,
      _signal: AbortSignal,
      _onError: (code: string | null) => void,
      _onDone: () => void,
      onFrame?: (event: string, data: unknown) => void,
    ) => {
      void onFrame;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mounted(onApproved?: (r: unknown) => void) {
  const hook = renderHook(() =>
    usePlanChangeConversation(onApproved ? { onApproved: onApproved as never } : {}),
  );
  await waitFor(() => expect(hook.result.current.state.phase).toBe('idle'));
  return hook;
}

describe('usePlanChangeConversation — resume', () => {
  it('opens (or RESUMES) the project thread on mount', async () => {
    open.mockResolvedValue(session(['Add recurring invoices.', 'Split it in two.']));
    const { result } = await mounted();

    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.state.session?.turns).toHaveLength(2);
  });

  it('degrades to a recoverable error when the thread cannot be read', async () => {
    open.mockRejectedValue(new PlanEditsClientError(500, null));
    const { result } = await mounted();

    expect(result.current.state.errorCode).toBe('SESSION_UNAVAILABLE');
  });
});

describe('usePlanChangeConversation — a TARGETED turn (MOTIR-1491)', () => {
  const TARGETS = [
    { id: 'w-812', identifier: 'MOTIR-812', title: 'Billing', kind: 'story' as const },
    { id: 'w-918', identifier: 'MOTIR-918', title: 'Migrate', kind: 'subtask' as const },
  ];

  it('routes the turn to the CONTEXTUAL endpoint — primary as the anchor, the rest as targetKeys', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(submitAnchored).toHaveBeenCalledWith(
      'w-812',
      'Expand billing.',
      ['MOTIR-918'],
      expect.anything(),
      // MOTIR-2226: no question is pending, so the turn is not a reply.
      false,
    );
    // One call does open-or-resume + append + submit, so neither project-thread
    // hop fires — a targeted turn must not land in the project conversation.
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('adopts the SCOPED thread that comes back, so the rail shows what it is anchored at', async () => {
    submitAnchored.mockResolvedValue({
      jobId: 'job-ctx',
      planId: 'plan-ctx',
      sessionId: 's-ctx',
      session: session(['Expand billing.'], ['MOTIR-812', 'MOTIR-918']),
    });
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(result.current.state.session?.targetKeys).toEqual(['MOTIR-812', 'MOTIR-918']);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('streams the contextual job through ITS route — the anchor is re-gated on subscribe', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });

    expect(streamAnchored).toHaveBeenCalledWith(
      'w-812',
      'job-anchored-1',
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(stream).not.toHaveBeenCalled();
  });

  it('a retry RESUBMITS to the same anchor set — never re-aimed, never duplicated', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Expand billing.', TARGETS);
    });
    submitAnchored.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    // The accumulated intent goes out again with NO new turn appended (MOTIR-910's
    // resubmit), addressed to the set the failed turn actually landed in.
    expect(resubmitAnchored).toHaveBeenCalledWith('w-812', ['MOTIR-918'], expect.anything());
    expect(submitAnchored).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('an EMPTY target set is the ordinary project turn — the picker is additive', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.', []);
    });

    expect(submitAnchored).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('usePlanChangeConversation — a turn', () => {
  it('appends the turn, then submits the ACCUMULATED intent and reviews the PROPOSALS', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(append).toHaveBeenCalledWith('Add recurring invoices.', expect.anything(), false);
    // The submit takes NO prompt — the server builds it from every turn in order.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.jobId).toBe('job-1');
  });

  it('ignores an empty turn — nothing is appended and nothing is submitted', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('   ');
    });

    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('narrates the run from the job’s REAL progress frames', async () => {
    stream.mockImplementation(okStream([['search', { relatedCount: 3 }]]));
    const { result } = await mounted();

    // Freeze the run mid-stream by asserting the frame mapping directly — the
    // narration is derived, not invented.
    expect(narrateFrame('search', {})).toEqual({ kind: 'searching' });
    expect(narrateFrame('planned', { proposed: 2 })).toEqual({ kind: 'proposed', count: 2 });
    expect(narrateFrame('tokens', {})).toBeNull();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    // Settled → the narration clears; the proposal is the outcome.
    expect(result.current.state.progress).toBeNull();
  });

  it('reports an EMPTY result without losing the thread', async () => {
    fetchReview.mockResolvedValue(planReview([]));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.errorCode).toBe('EMPTY');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });
});

describe('usePlanChangeConversation — failure is recoverable in place', () => {
  it('keeps a PRIOR proposal and the thread when a later run fails', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    stream.mockImplementation(
      async (_jobId: string, _signal: AbortSignal, onError: (code: string | null) => void) =>
        onError('FAILED'),
    );
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.errorCode).toBe('FAILED');
    // The proposal already on the canvas survives — a retry continues the
    // conversation instead of restarting it.
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.phase).toBe('review');
  });

  it('flags an out-of-credits refusal as GATED, not as an error', async () => {
    submit.mockRejectedValue(new PlanEditsClientError(402, 'MOTIR_AI_OUT_OF_CREDITS'));
    const { result } = await mounted();

    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    expect(result.current.state.outOfCredits).toBe(true);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('re-sends the accumulated intent on retry WITHOUT appending a new turn', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });
    append.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    expect(append).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe('usePlanChangeConversation — approve / discard', () => {
  it('persists through the shipped approve route and KEEPS the conversation open', async () => {
    const onApproved = vi.fn();
    const { result } = await mounted(onApproved);
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    // The PLAN is what gets confirmed — the same operation `/plans/[id]` performs.
    expect(approve).toHaveBeenCalledWith('plan-1');
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.approved).toEqual({
      created: ['wi_new'],
      updated: [],
      removed: [],
    });
    // Decided → nothing is left addressable, so a second click cannot re-approve.
    expect(result.current.state.planId).toBeNull();
    // The thread survives the commit — that is what makes it a conversation.
    expect(result.current.state.session?.turns).toHaveLength(1);
    // The caller is told, so it can refresh the server surfaces AND the island.
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('WRITES NOTHING while the proposal is merely on screen', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    // The gate is the whole point: reviewing reads the Plan and stops there. No
    // approve, no decline — so neither the tree nor the Plan's status moves until
    // the user clicks.
    expect(result.current.state.phase).toBe('review');
    expect(approve).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
  });

  it('surfaces an immutable rejection and leaves the proposal in review', async () => {
    approve.mockRejectedValue(new PlanRequestError(409, 'PLAN_TARGET_IMMUTABLE'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('immutable');
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('DISCARD declines the PLAN, touches no work item, and leaves the thread intact', async () => {
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.discard();
    });

    // Declining DECIDES the plan (`planned → declined`) instead of abandoning it
    // at `planned` forever — and it is the only write a discard makes.
    expect(decline).toHaveBeenCalledWith('plan-1');
    expect(approve).not.toHaveBeenCalled();
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.planId).toBeNull();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.session?.turns).toHaveLength(1);
  });

  it('keeps the proposal decidable when the DISCARD itself fails', async () => {
    decline.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.discard();
    });

    // Clearing the canvas here would tell the user it was dropped while the
    // server still has it awaiting a decision.
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.review).toEqual(REVIEW);
    expect(result.current.state.planId).toBe('plan-1');
    expect(result.current.state.errorCode).toBe('discard');
  });

  it('says a plan someone ALREADY decided is decided, and never writes twice', async () => {
    approve.mockRejectedValue(new PlanRequestError(409, 'PLAN_NOT_IN_EXPECTED_STATUS'));
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.state.errorCode).toBe('decided');
    expect(result.current.state.phase).toBe('review');
  });

  it('does not approve when there is no Plan to address', async () => {
    // The defensive read: a stub / older response carried only a jobId, so there
    // is nothing to confirm — the gate must no-op rather than POST to `undefined`.
    submit.mockResolvedValue({ jobId: 'job-1', session: session(['Add recurring invoices.']) });
    const { result } = await mounted();
    await act(async () => {
      await result.current.send('Add recurring invoices.');
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(approve).not.toHaveBeenCalled();
  });
});

// ─── ANCHORED at a work item — the MOTIR-910 entrance's conversation ──────────
//
// Same state machine, different thread: when the workspace was summoned from a
// work item, every hop rides the item-scoped MOTIR-909 endpoints. What these
// lock is that the routing actually switches — the project thread must never be
// touched from an item's door, and vice versa.

async function mountedAnchored(anchorId = 'wi_123', settled: 'idle' | 'review' = 'idle') {
  const hook = renderHook(() => usePlanChangeConversation({ anchorId }));
  await waitFor(() => expect(hook.result.current.state.phase).toBe(settled));
  return hook;
}

describe('usePlanChangeConversation — anchored at a work item (MOTIR-910)', () => {
  it('resumes the ITEM’s thread on mount, never the project one', async () => {
    resumeAnchored.mockResolvedValue({ session: session(['Split this story.']), planId: null });
    const { result } = await mountedAnchored();

    expect(resumeAnchored).toHaveBeenCalledWith('wi_123', [], expect.anything());
    expect(open).not.toHaveBeenCalled();
    expect(result.current.state.session?.turns).toHaveLength(1);
  });

  it('treats an item that was never planned as an EMPTY thread, not an error', async () => {
    resumeAnchored.mockResolvedValue({ session: null, planId: null });
    const { result } = await mountedAnchored();

    expect(result.current.state.session).toBeNull();
    expect(result.current.state.errorCode).toBeNull();
  });

  it('re-establishes the pending planId on mount, so a reopened workspace can still confirm (MOTIR-1745)', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_pending',
    });
    const { result } = await mountedAnchored('wi_123', 'review');

    expect(result.current.state.planId).toBe('plan_pending');
    // …and it comes back REVIEWABLE: the undecided proposal is read from its Plan
    // and put back on the canvas, so closing the workspace mid-review is not the
    // same as discarding (MOTIR-1746).
    expect(fetchReview).toHaveBeenCalledWith('plan_pending', expect.anything());
    expect(result.current.state.review).toEqual(REVIEW);
  });

  it('comes back with NOTHING pending when the thread’s plan was already decided', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_decided',
    });
    fetchReview.mockResolvedValue(planReview([], { status: 'approved' }));
    const { result } = await mountedAnchored();

    // A decided plan is history, not a review — no gate, and no error either.
    expect(result.current.state.review).toBeNull();
    expect(result.current.state.errorCode).toBeNull();
  });

  it('stays usable when the pending plan cannot be READ — that is not a broken session', async () => {
    resumeAnchored.mockResolvedValue({
      session: session(['Split this story.']),
      planId: 'plan_pending',
    });
    fetchReview.mockRejectedValue(new PlanRequestError(500, null));
    const { result } = await mountedAnchored();

    expect(result.current.state.session?.turns).toHaveLength(1);
    expect(result.current.state.errorCode).toBeNull();
  });

  it('adopts the SUBMIT’s planId, and drops it once the proposal is settled', async () => {
    submitAnchored.mockResolvedValue({
      jobId: 'job-anchored-1',
      planId: 'plan_fresh',
      sessionId: 's1',
      session: session(['Split this story.']),
    });
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });
    expect(result.current.state.planId).toBe('plan_fresh');

    // Discarding DECIDES that plan, so the handle goes with the job id rather
    // than lingering as a stale confirm target.
    await act(async () => {
      await result.current.discard();
    });
    expect(decline).toHaveBeenCalledWith('plan_fresh');
    expect(result.current.state.planId).toBeNull();
    expect(result.current.state.jobId).toBeNull();
  });

  it('degrades to no planId when the response carries only a jobId', async () => {
    // The defensive read the optional browser-facing type exists for: a stub or
    // an older deployment answers without it, and the rail simply has nothing to
    // confirm — it does not crash and does not invent an id.
    submitAnchored.mockResolvedValue({
      jobId: 'job-anchored-1',
      sessionId: 's1',
      session: session(['Split this story.']),
    });
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });
    expect(result.current.state.jobId).toBe('job-anchored-1');
    expect(result.current.state.planId).toBeNull();
  });

  it('sends the turn through the anchored endpoint — ONE call that appends AND submits', async () => {
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });

    expect(submitAnchored).toHaveBeenCalledWith(
      'wi_123',
      'Split this story.',
      [],
      expect.anything(),
      false,
    );
    // The project thread's two-call shape is never used here.
    expect(append).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.state.phase).toBe('review');
    expect(result.current.state.jobId).toBe('job-anchored-1');
  });

  it('streams through the item’s own relay, which re-gates the anchor on subscribe', async () => {
    const { result } = await mountedAnchored();

    await act(async () => {
      await result.current.send('Split this story.');
    });

    expect(streamAnchored).toHaveBeenCalledTimes(1);
    expect(streamAnchored.mock.calls[0]![0]).toBe('wi_123');
    expect(streamAnchored.mock.calls[0]![1]).toBe('job-anchored-1');
    expect(stream).not.toHaveBeenCalled();
  });

  it('retries by RE-SENDING the accumulated intent — no duplicated turn', async () => {
    const { result } = await mountedAnchored();
    await act(async () => {
      await result.current.send('Split this story.');
    });
    submitAnchored.mockClear();

    await act(async () => {
      await result.current.retry();
    });

    expect(resubmitAnchored).toHaveBeenCalledWith('wi_123', [], expect.anything());
    expect(submitAnchored).not.toHaveBeenCalled();
    expect(result.current.state.jobId).toBe('job-anchored-2');
  });

  it('approves through the SAME shipped route — the anchor changes the thread, not the gate', async () => {
    const { result } = await mountedAnchored();
    await act(async () => {
      await result.current.send('Split this story.');
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(approve).toHaveBeenCalledWith('plan-anchored-1');
    expect(result.current.state.review).toBeNull();
  });
});
