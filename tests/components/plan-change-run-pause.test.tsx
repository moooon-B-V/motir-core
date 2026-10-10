// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { isOpenUnclear, pauseAnchorIndex, pauseOf, pauseOwnedIds } from '@/lib/planning/runPause';
import type { PlanChangeRunPauseDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// THE PLANNER'S MID-RUN PAUSE, drawn (Story MOTIR-7990 · MOTIR-8010; design
// `plan-change-run-live--answer-or-forward.mock.html`, states 6–9). Hand-built
// state: the pause door and the hook are tested where they live; this file holds
// how the rail DRAWS an open, answered and refused pause.

const INDEX = {
  isEmpty: true,
  counts: { added: 0, changed: 0, removed: 0 },
} as unknown as PlanChangeDiffIndex;

function pause(over: Partial<PlanChangeRunPauseDto> = {}): PlanChangeRunPauseDto {
  return {
    id: 'pause-1',
    jobId: 'run-1',
    kind: 'replan',
    changeTurnIds: ['e1'],
    reason: 'That changes what the whole plan is for.',
    question: null,
    createdAt: '2026-10-09T09:00:00.000Z',
    answer: null,
    answeredAt: null,
    replyText: null,
    delivery: 'pending',
    refusedCode: null,
    mailboxEntryId: null,
    ...over,
  };
}

const changeTurn: PlanChangeTurnDto = {
  id: 'u1',
  seq: 1,
  role: 'user',
  body: 'Make it a mobile app instead.',
  jobId: 'ask-u1',
  runJobId: 'run-1',
  forwarded: { mailboxEntryId: 'e1' },
  question: null,
  isAnswer: false,
  intent: null,
  intentCorrected: false,
  citations: [],
  createdAt: '2026-10-09T09:00:00.000Z',
  authorId: 'u1',
} as unknown as PlanChangeTurnDto;

function stateOf(
  runPause: PlanChangeRunPauseDto | null,
  over: Partial<PlanChangeConversationState> = {},
): PlanChangeConversationState {
  return {
    phase: 'streaming',
    session: {
      id: 's1',
      projectId: 'p1',
      turnCount: 1,
      targetKeys: [],
      lastJobId: 'run-1',
      lastSubmittedAt: '2026-10-09T09:00:00.000Z',
      turns: [changeTurn],
      refs: {},
    } as unknown as PlanChangeConversationState['session'],
    progress: { kind: 'searching' },
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: 'run-1',
    planId: 'plan-1',
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [{ id: 'e1', text: 'Make it a mobile app instead.', read: false }],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [{ kind: 'searching' }],
    runPause,
    ...over,
  } as PlanChangeConversationState;
}

function rail(state: PlanChangeConversationState, onAnswerRunPause = vi.fn()) {
  return (
    <PlanChangeRail
      launch={{ mode: 'project' } as PlanningLaunch}
      projectName="Motir"
      state={state}
      index={INDEX}
      targets={[]}
      onAddTarget={() => {}}
      onRemoveTarget={() => {}}
      onSend={() => {}}
      onRetry={() => {}}
      onCorrectTurn={() => {}}
      onApprove={() => {}}
      onDiscard={() => {}}
      onStop={() => {}}
      onAnswerRunPause={onAnswerRunPause}
    />
  );
}

afterEach(() => cleanup());

describe('state 6 — the re-plan offer', () => {
  it('shows the planner reason with exactly two controls, and answers on press', () => {
    const onAnswer = vi.fn();
    renderWithIntl(rail(stateOf(pause()), onAnswer));

    expect(screen.getByTestId('planner-start-over-turn').textContent).toContain(
      'That changes what the whole plan is for.',
    );
    const group = screen.getByTestId('planner-start-over-offer');
    expect(group.querySelectorAll('button')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('planner-start-over-yes'));
    expect(onAnswer).toHaveBeenCalledWith('start_over');
    fireEvent.click(screen.getByTestId('planner-start-over-keep'));
    expect(onAnswer).toHaveBeenCalledWith('apply');
  });

  it('draws the paused bar with Stop still reachable, not the spinner bar', () => {
    renderWithIntl(rail(stateOf(pause())));
    const bar = screen.getByTestId('plan-change-running-bar');
    expect(bar.getAttribute('data-paused')).toBe('true');
    expect(screen.getByTestId('plan-change-paused-word').textContent?.toLowerCase()).toContain(
      'paused',
    );
    expect(screen.getByTestId('plan-change-stop')).toBeTruthy();
  });

  it('disables both controls while an answer is in flight', () => {
    renderWithIntl(rail(stateOf(pause(), { answeringPause: true })));
    expect((screen.getByTestId('planner-start-over-yes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('planner-start-over-keep') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('state 8 — an answered re-plan is a record', () => {
  it('drops the controls and the paused bar, naming the choice', () => {
    renderWithIntl(rail(stateOf(pause({ answer: 'start_over', delivery: 'delivered' }))));
    expect(screen.queryByTestId('planner-start-over-offer')).toBeNull();
    expect(screen.getByTestId('planner-start-over-record')).toBeTruthy();
    expect(screen.getByTestId('plan-change-running-bar').getAttribute('data-paused')).toBeNull();
  });

  it('adds the planner applying line after keep going', () => {
    renderWithIntl(rail(stateOf(pause({ answer: 'apply', delivery: 'delivered' }))));
    expect(screen.getByTestId('planner-start-over-applying')).toBeTruthy();
  });

  it('shows a quiet reason line, not an alert, when the run ended first', () => {
    renderWithIntl(
      rail(
        stateOf(pause({ answer: null }), {
          pauseAnswerRefusal: { code: 'PLAN_CHANGE_JOB_NOT_RUNNING', choice: 'apply' },
        } as Partial<PlanChangeConversationState>),
      ),
    );
    const line = screen.getByTestId('planner-pause-refusal');
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('data-code')).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');
  });
});

describe('state 9 — the planner asks what a change meant', () => {
  const unclear = pause({
    kind: 'unclear',
    reason: null,
    question: 'Do you mean replace the web app, or add a mobile one?',
  });

  it('draws the question with no controls, the answer placeholder and the paused bar', () => {
    const { container } = renderWithIntl(rail(stateOf(unclear)));
    expect(screen.getByTestId('plan-change-question').textContent).toContain(
      'Do you mean replace the web app, or add a mobile one?',
    );
    expect(screen.queryByTestId('planner-start-over-offer')).toBeNull();
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toMatch(/answer/i);
    expect(screen.getByTestId('plan-change-running-bar').getAttribute('data-paused')).toBe('true');
  });

  it('records an answered question as a reply under it, read once the run took it', () => {
    const replied = pause({
      kind: 'unclear',
      question: 'Which one?',
      answer: 'replied',
      delivery: 'delivered',
      replyText: 'Add a mobile one.',
      mailboxEntryId: 'r1',
    });
    renderWithIntl(
      rail(
        stateOf(replied, {
          queued: [
            { id: 'e1', text: 'x', read: true },
            { id: 'r1', text: 'Add a mobile one.', read: false },
          ],
        }),
      ),
    );
    expect(screen.getByTestId('planner-pause-reply').textContent).toContain('Add a mobile one.');
    expect(screen.getByTestId('plan-change-forwarded-queued')).toBeTruthy();
    // The reply is drawn once: the standalone mailbox row skips it.
    expect(screen.getAllByText(/Add a mobile one\./)).toHaveLength(1);
    // …and it carries no acknowledgement of its own: the only one is the change turn's.
    expect(screen.getAllByTestId('plan-change-forwarded')).toHaveLength(1);
    expect(
      screen
        .getByTestId('planner-pause-reply')
        .querySelector('[data-testid="plan-change-forwarded"]'),
    ).toBeNull();
  });
});

describe('the derivations', () => {
  it('reads a pause from the poll, ignoring one that belongs to another run', () => {
    expect(pauseOf({ runPause: pause(), jobId: 'run-1' })?.id).toBe('pause-1');
    expect(pauseOf({ runPause: pause(), jobId: 'run-2' })).toBeNull();
    expect(pauseOf({ runPause: null, session: { runPause: pause() }, jobId: 'run-1' })).toBeNull();
    expect(pauseOf({ session: { runPause: pause() }, jobId: 'run-1' })?.id).toBe('pause-1');
  });

  it('knows an open unclear pause, and which entries the thread owns', () => {
    expect(isOpenUnclear(pause({ kind: 'unclear' }))).toBe(true);
    expect(isOpenUnclear(pause({ kind: 'replan' }))).toBe(false);
    expect(pauseOwnedIds(pause({ answer: 'apply', mailboxEntryId: 'f1' }))).toEqual(['f1']);
    expect(pauseOwnedIds(pause({ answer: 'start_over', mailboxEntryId: 'f1' }))).toEqual([]);
    expect(pauseOwnedIds(pause())).toEqual([]);
  });

  it('anchors under the last change turn it names, else the last turn', () => {
    expect(pauseAnchorIndex([changeTurn], pause())).toBe(0);
    expect(pauseAnchorIndex([changeTurn], pause({ changeTurnIds: ['zz'] }))).toBe(0);
    expect(pauseAnchorIndex([], pause())).toBe(-1);
  });
});
