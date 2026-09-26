// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// MOTIR-6210 — the planning surface OPENS SEEDED from a refused gate (story
// MOTIR-6068; design MOTIR-6206 `design/ai-chat/planning-workspace--refusal-seed.mock.html`).
// This file holds the CONVERSATION half: the hook and the rail.
//
//   · a seeded mount opens EMPTY — no resumable read, no turn, no job;
//   · the FIRST send carries `seedGateId`, and no later send does;
//   · a `SEED_NOT_APPLICABLE` refusal drops the seed and keeps the words;
//   · the seed's return (`seededSessionId`) is a RESUME — no reopened line;
//   · the rail holds the turn UNSENT in the composer, focused, with no starter
//     chips while the seed is there.
// The transport is mocked; the state machine and the rendering are under test.

const { resume, getNamed, resumeAnchored, submitAnchored, streamAnchored, fetchReview } =
  vi.hoisted(() => ({
    resume: vi.fn(),
    getNamed: vi.fn(),
    resumeAnchored: vi.fn(),
    submitAnchored: vi.fn(),
    streamAnchored: vi.fn(),
    fetchReview: vi.fn(),
  }));

vi.mock('@/lib/planning/planChangeClient', () => ({
  findResumableSession: resume,
  getPlanChangeSession: getNamed,
  resumeContextualSession: resumeAnchored,
  submitContextualPlan: submitAnchored,
}));

vi.mock('@/lib/planning/planEditsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planEditsClient')>();
  return { ...actual, streamContextualPlanJob: streamAnchored };
});

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: fetchReview };
});

import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { renderWithIntl } from '../helpers/renderWithIntl';

const GATE = 'cmg7k2q0';
const TARGET: PlanningTarget = {
  id: 'wi_44',
  identifier: 'ACME-44',
  title: 'Where exports live',
  kind: 'story',
};
const FIRST_TURN = [
  'ACME-44 · Where exports live',
  'Changes were requested on this decision.',
  'The reason given:\n“Keep the download page for large files — only the retention rule should change.”',
  'Re-plan this work item from that reason.',
].join('\n\n');

function session(
  bodies: string[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-44'],
    turnCount: bodies.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-25T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
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
      createdAt: '2026-09-25T10:00:00.000Z',
    })),
    workItemRefs: {},
    ...extra,
  };
}

beforeEach(() => {
  for (const fn of [
    resume,
    getNamed,
    resumeAnchored,
    submitAnchored,
    streamAnchored,
    fetchReview,
  ]) {
    fn.mockReset();
  }
  streamAnchored.mockResolvedValue(undefined);
  fetchReview.mockResolvedValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the hook — a SEEDED re-plan', () => {
  it('opens EMPTY: no resumable read, no named read, nothing written until Send', async () => {
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_44', seedGateId: GATE }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.session).toBeNull();
    expect(result.current.state.earlier).toBeNull();
    expect(result.current.state.reopened).toBeNull();
    // The caller's ordinary resumable conversation on the card is NOT the one a
    // refusal starts — it is not even read.
    expect(resumeAnchored).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(getNamed).not.toHaveBeenCalled();
    expect(submitAnchored).not.toHaveBeenCalled();
  });

  it('the FIRST send carries the seed; the next one names the session and carries none', async () => {
    submitAnchored.mockResolvedValue({
      jobId: 'job-1',
      planId: undefined,
      sessionId: 's1',
      session: session([FIRST_TURN]),
    });
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_44', seedGateId: GATE }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send(FIRST_TURN, [TARGET]);
    });
    expect(submitAnchored).toHaveBeenLastCalledWith(
      'wi_44',
      FIRST_TURN,
      [],
      expect.anything(),
      false,
      null,
      GATE,
    );
    await waitFor(() => expect(result.current.state.session?.id).toBe('s1'));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send('Also keep the audit log.', [TARGET]);
    });
    expect(submitAnchored).toHaveBeenLastCalledWith(
      'wi_44',
      'Also keep the audit log.',
      [],
      expect.anything(),
      false,
      's1',
    );
  });

  it('a SEED_NOT_APPLICABLE refusal shows the send error, and the next send goes UNSEEDED', async () => {
    submitAnchored.mockRejectedValueOnce(new PlanEditsClientError(422, 'SEED_NOT_APPLICABLE'));
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_44', seedGateId: GATE }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    await act(async () => {
      await result.current.send(FIRST_TURN, [TARGET]);
    });
    expect(result.current.state.errorCode).toBe('FAILED');
    expect(result.current.state.session).toBeNull();

    submitAnchored.mockResolvedValue({
      jobId: 'job-2',
      sessionId: 's1',
      session: session([FIRST_TURN]),
    });
    await act(async () => {
      await result.current.send(FIRST_TURN, [TARGET]);
    });
    expect(submitAnchored).toHaveBeenLastCalledWith(
      'wi_44',
      FIRST_TURN,
      [],
      expect.anything(),
      false,
      null,
    );
  });

  it('any OTHER failure keeps the seed for the next attempt', async () => {
    submitAnchored.mockRejectedValueOnce(new PlanEditsClientError(500, null));
    submitAnchored.mockResolvedValue({ jobId: 'j', sessionId: 's1', session: session(['x']) });
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_44', seedGateId: GATE }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await act(async () => {
      await result.current.send(FIRST_TURN, [TARGET]);
    });
    await act(async () => {
      await result.current.send(FIRST_TURN, [TARGET]);
    });
    expect(submitAnchored.mock.calls.map((c) => c[6])).toEqual([GATE, GATE]);
  });

  it('the seed’s RETURN (`seededSessionId`) is a RESUME — the transcript, and no reopened line', async () => {
    getNamed.mockResolvedValue(
      session([FIRST_TURN], {
        id: 's7',
        startedBy: { id: 'u1', name: 'Mara Lind' },
        startedByViewer: true,
        viewerCanPlan: true,
        pendingPlanId: null,
      }),
    );
    const { result } = renderHook(() =>
      usePlanChangeConversation({ anchorId: 'wi_44', sessionId: 's7', sessionIsResume: true }),
    );
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(getNamed).toHaveBeenCalledWith('s7', expect.anything());
    expect(result.current.state.session?.turns.map((t) => t.body)).toEqual([FIRST_TURN]);
    expect(result.current.state.reopened).toBeNull();
    expect(result.current.state.readOnly).toBe(false);
  });
});

// ─── The rail ──────────────────────────────────────────────────────────────

const SEEDED_LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'work-item', item: 'ACME-44' });

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: null,
  progress: null,
  acts: [],
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
};

const onSend = vi.fn();

function rail(state: Partial<PlanChangeConversationState> = {}, initialDraft?: string) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={SEEDED_LAUNCH}
      projectName="Acme"
      {...(initialDraft ? { initialDraft } : {})}
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[TARGET]}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onSend={onSend}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
    />
  );
}

const REPLAN_PLACEHOLDER = 'What’s wrong? What should change?';

describe('the rail — the turn in the COMPOSER, unsent', () => {
  afterEach(() => onSend.mockReset());

  it('holds the seed as the field’s content, focused, caret at the END — nothing is sent', () => {
    renderWithIntl(rail({}, FIRST_TURN));
    const field = screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER }) as HTMLTextAreaElement;
    expect(field.value).toBe(FIRST_TURN);
    // The re-plan placeholder is still SET — it is seen only once the draft is cleared.
    expect(field.placeholder).toBe(REPLAN_PLACEHOLDER);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(FIRST_TURN.length);
    expect(field.selectionEnd).toBe(FIRST_TURN.length);
    // The opener names the card, and the chip reads plan change.
    expect(screen.getByTestId('planning-mode-chip').textContent).toBe('plan change');
    expect(screen.getByText('Opened in the context of ACME-44.')).toBeTruthy();
    // Send is ENABLED, and nothing has been sent.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows NO starter chips while the seed is in the field — and they return once it is cleared', () => {
    renderWithIntl(rail({}, FIRST_TURN));
    expect(screen.queryByRole('button', { name: 'Add work to an epic' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What’s blocked, and why?' })).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER }), {
      target: { value: '' },
    });
    // Cleared, the rail is an ordinary item re-plan again.
    expect(screen.getByRole('button', { name: 'Add work to an epic' })).toBeTruthy();
  });

  it('an UNSEEDED item re-plan keeps its starter chips and an empty field, as before', () => {
    renderWithIntl(rail());
    const field = screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER }) as HTMLTextAreaElement;
    expect(field.value).toBe('');
    expect(screen.getByRole('button', { name: 'Add work to an epic' })).toBeTruthy();
  });

  it('Send posts the (edited) seed as the first turn', () => {
    renderWithIntl(rail({}, FIRST_TURN));
    const field = screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER });
    fireEvent.change(field, { target: { value: `${FIRST_TURN}\n\nKeep it small.` } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(`${FIRST_TURN}\n\nKeep it small.`);
  });

  it('a FAILED seeded send (422 SEED_NOT_APPLICABLE) puts the words back and shows the send error', () => {
    const { rerender } = renderWithIntl(rail({}, FIRST_TURN));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(FIRST_TURN);
    // The composer clears on submit, and the run is in flight…
    rerender(rail({ phase: 'streaming' }, FIRST_TURN));
    // …then it comes back refused: no session, the existing send-error state.
    rerender(rail({ phase: 'idle', errorCode: 'FAILED' }, FIRST_TURN));
    const field = screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER }) as HTMLTextAreaElement;
    expect(field.value).toBe(FIRST_TURN);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a failed seeded send does NOT overwrite words typed since — and the error clearing changes nothing', () => {
    const { rerender } = renderWithIntl(rail({}, FIRST_TURN));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    rerender(rail({ phase: 'streaming' }, FIRST_TURN));
    // The person starts the next thought while the send is in flight…
    const field = () =>
      screen.getByRole('textbox', { name: REPLAN_PLACEHOLDER }) as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'Actually, keep it smaller.' } });
    // …and the refusal lands: their newer words stay; the seed is not pasted over them.
    rerender(rail({ phase: 'idle', errorCode: 'FAILED' }, FIRST_TURN));
    expect(field().value).toBe('Actually, keep it smaller.');
    // The error clearing (a retry, a dismiss) is not a failure — nothing moves.
    rerender(rail({ phase: 'idle', errorCode: null }, FIRST_TURN));
    expect(field().value).toBe('Actually, keep it smaller.');
  });

  it('a SUCCESSFUL seeded send does not come back into the field', () => {
    const { rerender } = renderWithIntl(rail({}, FIRST_TURN));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    rerender(rail({ phase: 'streaming', session: session([FIRST_TURN]) }, FIRST_TURN));
    rerender(rail({ phase: 'idle', session: session([FIRST_TURN]) }, FIRST_TURN));
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe('');
  });

  it('the RESUMED return draws no "Reopened from the Plans page" line and no draft', () => {
    renderWithIntl(rail({ session: session([FIRST_TURN], { id: 's7' }) }));
    expect(screen.queryByTestId('planning-reopened-session')).toBeNull();
    expect(screen.queryByTestId('planning-reopened-from-approvals')).toBeNull();
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    // An ordinary composer — the conversation has started, so it no longer asks.
    expect(field.placeholder).not.toBe(REPLAN_PLACEHOLDER);
  });
});
