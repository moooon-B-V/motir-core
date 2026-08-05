// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// The PLANNER SPEAKING in the rail (MOTIR-2226; design `design/ai-chat/`
// § "The planner SPEAKS in the plan-change thread", states A–E).
//
// The load-bearing one is the FIRST test: before this card the rail branched
// `system` → marker and fell through to a numbered USER bubble for everything
// else, so the very first assistant turn would have been attributed to the
// person who did not write it. That is the defect these assertions pin shut.
//
// Everything else follows the design's own distinction — *a report changes only
// the transcript; a question changes the composer* — and its rule that awaiting
// is DERIVED from the persisted thread, which is why the reload case here is a
// plain fresh render of a server-shaped session rather than any replay of client
// state.

const LAUNCH = parsePlanningLaunch({ mode: 'project', from: 'project' });

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

function session(
  turns: PlanChangeTurnDto[],
  workItemRefs: PlanChangeSessionDto['workItemRefs'] = {},
): PlanChangeSessionDto {
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
    workItemRefs,
  };
}

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function renderRail(turns: PlanChangeTurnDto[], refs: PlanChangeSessionDto['workItemRefs'] = {}) {
  const state: PlanChangeConversationState = {
    phase: 'idle',
    session: session(turns, refs),
    progress: null,
    review: null,
    jobId: null,
    planId: null,
    approved: null,
    errorCode: null,
    outOfCredits: false,
  };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={state}
      index={indexPlanReview(null)}
      targets={[]}
      {...handlers}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const fn of Object.values(handlers)) fn.mockReset();
});

describe('state A — the findings report', () => {
  it('renders as an ASSISTANT bubble, NOT as a numbered user turn (the fall-through bug)', () => {
    renderRail([turn('user', 'add payments'), turn('assistant', 'I searched the plan.')]);

    const report = screen.getByTestId('plan-change-report');
    expect(within(report).getByText('I searched the plan.')).toBeTruthy();
    // The planner's avatar, not the user's — the whole point. Before this card
    // the same turn rendered inside a `turn 2` user bubble.
    expect(within(report).getByText('M')).toBeTruthy();
    expect(within(report).queryByText('·')).toBeNull();
    expect(screen.queryByText('turn 2')).toBeNull();
    // A report changes only the transcript: the composer is untouched.
    expect(screen.queryByTestId('plan-change-awaiting')).toBeNull();
  });

  it('renders the report’s work-item references as the shipped chip', () => {
    renderRail(
      [turn('assistant', 'I searched the plan. [PAY-12](motir:wi_12) already covers it.')],
      {
        wi_12: {
          id: 'wi_12',
          identifier: 'PAY-12',
          title: 'Invoice model',
          kind: 'story',
          archived: false,
          status: { key: 'done', label: 'Done', category: 'done' },
          accessible: true,
        },
      },
    );

    const report = screen.getByTestId('plan-change-report');
    // The live chip (key · title · status), not the authored text — the shipped
    // autolink path, reused rather than re-invented for this surface.
    expect(within(report).getByText('PAY-12')).toBeTruthy();
    expect(within(report).getByText('Invoice model')).toBeTruthy();
    expect(report.querySelector('.wi-chip')).toBeTruthy();
  });

  it('a report does NOT put the composer in its answer state', () => {
    renderRail([turn('assistant', 'I searched the plan.')]);
    expect(screen.getByPlaceholderText('Reply, or refine further…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });
});

describe('state B — the question changes the composer', () => {
  const asking = () =>
    turn('assistant', 'When you say “add payments” — which direction?', {
      question: 'Taking money in, or paying suppliers out?',
    });

  it('renders the asking bubble with its label and glyph', () => {
    renderRail([turn('user', 'add payments'), asking()]);

    const q = screen.getByTestId('plan-change-question');
    expect(within(q).getByText('asking')).toBeTruthy();
    expect(within(q).getByText(/which direction/)).toBeTruthy();
    // Not colour alone: the tint is paired with a word AND a glyph.
    expect(q.querySelector('svg.lucide-message-circle-question-mark')).toBeTruthy();
    expect(q.querySelector('.bg-\\(--el-warning-surface\\)')).toBeTruthy();
  });

  it('pins the answer bar above the composer, echoing the question', () => {
    renderRail([asking()]);

    const bar = screen.getByTestId('plan-change-awaiting');
    expect(within(bar).getByText('Waiting for your answer')).toBeTruthy();
    expect(within(bar).getByText('Taking money in, or paying suppliers out?')).toBeTruthy();
  });

  it('relabels the placeholder AND the Send button', () => {
    renderRail([asking()]);

    const input = screen.getByPlaceholderText('Answer Motir AI…');
    // The accessible name tracks the prompt — a screen reader hears the same ask.
    expect(input.getAttribute('aria-label')).toBe('Answer Motir AI…');
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('“See it” moves FOCUS to the pending question, not just the scroll', () => {
    renderRail([asking(), turn('system', 'sent')]);
    const q = screen.getByTestId('plan-change-question');
    q.scrollIntoView = vi.fn();

    fireEvent.click(screen.getByRole('button', { name: 'See it' }));

    // Focus, so the jump lands for a keyboard or screen-reader user too.
    expect(document.activeElement).toBe(q);
  });

  it('the pending question outranks the re-plan ASK placeholder', () => {
    const replan = parsePlanningLaunch({ mode: 'replan', from: 'item', item: 'PAY-3' });
    const state: PlanChangeConversationState = {
      phase: 'idle',
      session: session([asking()]),
      progress: null,
      review: null,
      jobId: null,
      planId: null,
      approved: null,
      errorCode: null,
      outOfCredits: false,
    };
    renderWithIntl(
      <PlanChangeRail
        launch={replan}
        projectName="PayFlow"
        state={state}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );

    // The planner is blocked; the one thing to ask for is what unblocks it.
    expect(screen.getByPlaceholderText('Answer Motir AI…')).toBeTruthy();
  });
});

describe('state C — the answer, and resumption', () => {
  it('labels the reply as the ANSWER and marks planning resumed', () => {
    renderRail([
      turn('assistant', 'Which direction?', { question: 'in, or out?' }),
      turn('user', 'Taking money from customers.', { isAnswer: true }),
    ]);

    expect(screen.getByText('turn 1 · answer')).toBeTruthy();
    expect(screen.getByTestId('plan-change-answered').textContent).toBe(
      'Answered — planning resumed',
    );
    // The bar clears, Send returns to its icon, the placeholder returns.
    expect(screen.queryByTestId('plan-change-awaiting')).toBeNull();
    expect(screen.getByPlaceholderText('Reply, or refine further…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('RECOVERS the pending state from the persisted thread on a cold mount', () => {
    // Panel C's second frame: the same session reopened hours later. Nothing is
    // replayed — this is a first render of exactly what the server returns, and
    // the awaiting state is derived from it.
    renderRail([
      turn('user', 'add payments'),
      turn('system', 'sent'),
      turn('assistant', 'Which direction?', { question: 'in, or out?' }),
    ]);

    expect(screen.getByTestId('plan-change-awaiting')).toBeTruthy();
    expect(screen.getByPlaceholderText('Answer Motir AI…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
  });

  it('sends the reply through the ordinary turn path', () => {
    renderRail([turn('assistant', 'Which direction?', { question: 'in, or out?' })]);

    const input = screen.getByPlaceholderText('Answer Motir AI…');
    fireEvent.change(input, { target: { value: 'money in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));

    // An ordinary user turn — not a paired or nested element.
    expect(handlers.onSend).toHaveBeenCalledWith('money in');
  });
});

describe('state E — a question nobody answered', () => {
  const thread = [
    turn('assistant', 'Which direction?', { question: 'in, or out?' }),
    turn('user', 'Actually — re-sequence the Billing epic first.'),
  ];

  it('marks it superseded and leaves the question bubble EXACTLY as it was', () => {
    renderRail(thread);

    expect(screen.getByTestId('plan-change-superseded').textContent).toBe(
      'Not answered — Motir AI carried on with what you asked',
    );
    // Not dimmed, not struck through, not removed: the reader has to be able to
    // see later WHY a plan rests on an assumption they never confirmed.
    const q = screen.getByTestId('plan-change-question');
    expect(within(q).getByText('asking')).toBeTruthy();
    expect(within(q).getByText(/Which direction/)).toBeTruthy();
  });

  it('is NEVER blocking — the composer is back to normal', () => {
    renderRail(thread);

    expect(screen.queryByTestId('plan-change-awaiting')).toBeNull();
    expect(screen.getByPlaceholderText('Reply, or refine further…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    // The superseding turn is numbered as the ordinary turn it is — NOT labelled
    // an answer, which is the whole difference from state C.
    expect(screen.getByText('turn 1')).toBeTruthy();
    expect(screen.queryByText('turn 1 · answer')).toBeNull();
  });
});

describe('the roles remain distinguishable', () => {
  it('renders each of the three roles as its own speaker in one thread', () => {
    renderRail([
      turn('user', 'add payments'),
      turn('system', 'sent'),
      turn('assistant', 'I searched the plan.'),
    ]);

    expect(screen.getByTestId('plan-change-marker').textContent).toBe('Sent to Motir AI');
    expect(screen.getByTestId('plan-change-report')).toBeTruthy();
    expect(screen.getByText('turn 1')).toBeTruthy();
    // One assistant turn on screen besides the opener + no user bubble claiming
    // the planner's words.
    expect(screen.queryByText('I searched the plan.')?.closest('[data-testid]')).toBeTruthy();
  });
});
