// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// MOTIR-1820 — the ASK half of the one conversation, as the rail renders it:
// the cited answer turn, the correction marker, the redirect's hand-off, and the
// states this story adds. Drawn by `design/ai-chat/ask-answers.mock.html` and
// bound by `docs/decisions/conversation-turn-intent.md`.
//
// The rail is presentational — the host owns the conversation state — so each
// case hands it that state directly, the same way the shipped rail suite does.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

let seq = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-08-20T10:00:00.000Z',
    ...extra,
  };
}

/** A user turn and the assistant turn it produced, joined by their JOB — which
 *  is how the rail finds the turn a correction re-runs. */
function exchange(
  ask: string,
  answer: string,
  opts: {
    jobId?: string;
    intent?: PlanChangeTurnDto['intent'];
    citations?: string[];
    corrected?: boolean;
  } = {},
): PlanChangeTurnDto[] {
  const jobId = opts.jobId ?? 'job-1';
  return [
    turn('user', ask, {
      jobId,
      intent: opts.intent ?? 'ask',
      intentCorrected: opts.corrected ?? false,
    }),
    turn('assistant', answer, { jobId, citations: opts.citations ?? [] }),
  ];
}

function session(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([]),
  progress: null,
  review: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  acts: [],
};

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function renderRail(state: Partial<PlanChangeConversationState> = {}) {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      {...handlers}
    />,
  );
}

beforeEach(() => {
  seq = 0;
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

describe('the cited answer turn', () => {
  it('renders as an ORDINARY assistant bubble — an answer needs no new treatment', () => {
    renderRail({
      session: session(
        exchange('which stories are blocked?', 'Two are.', { citations: ['PAY-1'] }),
      ),
    });

    // Same test id, same bubble, as the planner's findings report. The design's
    // finding is that the distinction lives in what a turn CARRIES, not in a
    // second bubble style — tinting answers would say "two conversations".
    const bubble = screen.getByTestId('plan-change-report');
    expect(within(bubble).getByText('Two are.')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-question')).toBeNull();
  });

  it('says how many work items the answer rests on — a NUMBER, not a second chip list', () => {
    renderRail({
      session: session(
        exchange('which stories are blocked?', 'Two are.', {
          citations: ['PAY-1', 'PAY-2', 'PAY-3'],
        }),
      ),
    });

    expect(screen.getByTestId('plan-change-citation-count').textContent).toBe(
      'Answered from 3 work items',
    );
  });

  it('says nothing when the answer cited nothing — the line is evidence, not chrome', () => {
    // The honest no-answer is an ORDINARY bubble with no citations, so a count
    // line reading "Answered from 0 work items" would be noise on the one turn
    // that is already saying it could not find anything.
    renderRail({
      session: session(exchange('what did we decide about SSO pricing?', "I can't answer that.")),
    });

    expect(screen.queryByTestId('plan-change-citation-count')).toBeNull();
    expect(screen.getByText("I can't answer that.")).toBeTruthy();
  });
});

describe('the correction marker', () => {
  it('offers "Propose changes instead" under an ANSWER, and re-runs the USER turn', () => {
    const turns = exchange('the payments epic should come first', 'It currently sits second.');
    renderRail({ session: session(turns) });

    const marker = screen.getByTestId('plan-change-correct');
    expect(marker.textContent).toBe('Propose changes instead');
    expect(marker.getAttribute('data-direction')).toBe('plan_change');

    fireEvent.click(marker);

    // ⭐ The USER turn, not the assistant one: the re-run replays what the
    // person said, and appends no second user turn.
    expect(handlers.onCorrectTurn).toHaveBeenCalledWith(turns[0]!.id);
  });

  it('offers "Answer this instead" under a PROPOSAL', () => {
    renderRail({
      session: session(
        exchange('split the blocked story', 'Proposed 3 subtasks.', { intent: 'plan_change' }),
      ),
    });

    const marker = screen.getByTestId('plan-change-correct');
    expect(marker.textContent).toBe('Answer this instead');
    expect(marker.getAttribute('data-direction')).toBe('ask');
  });

  it('appears on the LATEST assistant turn only — never two ways to re-run one turn', () => {
    renderRail({
      session: session([
        ...exchange('first question', 'first answer', { jobId: 'job-1' }),
        ...exchange('second question', 'second answer', { jobId: 'job-2' }),
      ]),
    });

    const markers = screen.getAllByTestId('plan-change-correct');
    expect(markers).toHaveLength(1);
  });

  it('is NOT offered on a question the planner is waiting on', () => {
    // Re-running it would answer a question nobody asked, instead of the one the
    // planner is blocked on.
    renderRail({
      session: session([
        turn('user', 'add payments', { jobId: 'job-1' }),
        turn('assistant', 'Which direction?', { jobId: 'job-1', question: 'in, or out?' }),
      ]),
    });

    expect(screen.queryByTestId('plan-change-correct')).toBeNull();
  });

  it('stays put while the re-run streams, disabled, rather than vanishing mid-wait', () => {
    renderRail({
      phase: 'streaming',
      progress: { kind: 'reading' },
      session: session(
        exchange('the payments epic should come first', 'It currently sits second.'),
      ),
    });

    const marker = screen.getByTestId('plan-change-correct');
    expect(marker.textContent).toBe('Re-reading…');
    expect(marker.hasAttribute('disabled')).toBe(true);
  });

  it('says why a SECOND assistant turn exists once a correction has landed', () => {
    renderRail({
      session: session(
        exchange('the payments epic should come first', 'Proposed the move.', {
          intent: 'plan_change',
          corrected: true,
        }),
      ),
    });

    expect(screen.getByTestId('plan-change-corrected').textContent).toBe(
      'Re-read as a plan change',
    );
  });
});

describe('the redirect — one turn, two streams', () => {
  it('names the hand-off, and keeps ONE waiting row across both jobs', () => {
    const { rerender } = renderRail({ phase: 'streaming', progress: { kind: 'reading' } });

    const reading = screen.getByTestId('plan-change-progress');
    expect(reading.textContent).toContain('Reading your request…');
    expect(screen.queryByTestId('plan-change-handoff')).toBeNull();

    rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={{ ...BASE, phase: 'streaming', progress: { kind: 'redirected' } }}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );

    // ⚠️ THE SAME ELEMENT. A waiting row that unmounted and returned would read
    // as "that failed, it is trying again" — and nothing failed.
    expect(screen.getByTestId('plan-change-progress')).toBe(reading);
    expect(reading.textContent).toContain('Working on the proposal…');
    expect(screen.getByTestId('plan-change-handoff').textContent).toBe(
      'Reading it as a plan change — working on the proposal',
    );
  });
});

describe('the states this story adds', () => {
  it('a SILENT job is its own honest message, not the plan-change EMPTY copy', () => {
    renderRail({ errorCode: 'ASK_SILENT', session: session([turn('user', 'anything')]) });

    expect(screen.getByRole('alert').textContent).toBe(
      'Nothing came back. Try asking that a different way.',
    );
  });

  it('offers a question-shaped starter, which PREFILLS rather than sends', () => {
    renderRail();

    const chip = screen.getByRole('button', { name: "What's blocked, and why?" });
    fireEvent.click(chip);

    expect(handlers.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').getAttribute('value')).toBe("What's blocked, and why?");
  });
});
