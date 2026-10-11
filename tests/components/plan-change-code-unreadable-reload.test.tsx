// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { toPlanChangeTurnDto } from '@/lib/mappers/planChangeMappers';
import type { PlanChangeTurn } from '@/generated/prisma/client';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';

// THE OUTAGE FACES, AFTER A RELOAD (Story MOTIR-8136 · MOTIR-8143; cases 5 and 6).
//
// The rail is rendered from DTOs produced by the REAL mapper over PERSISTED-SHAPE rows —
// the columns exactly as `plan_change_turn` stores them, `code_unreadable` included — so
// what is drawn is what a reload would draw, not what a settle call returned. The
// database half of the same chain (set in the settle, kept in the row, read back through
// the thread read) is `tests/integration/planning/codeUnreadableOutage.test.ts`; the
// real-database harness is not importable from a happy-dom file, so the render is kept
// here on the mapped rows and the persisted read lives there.

const PLAN_BODY =
  "I can't read your code right now, so I haven't changed your plan. Motir is on it.";
const MARKER = 'Nothing was written — your plan is unchanged.';
const ASK_NOTICE =
  "I couldn't read your code for this answer. Treat anything about the code here as unconfirmed.";

afterEach(() => cleanup());

let seq = 0;
function row(over: Partial<PlanChangeTurn>): PlanChangeTurn {
  seq += 1;
  return {
    id: `t${seq}`,
    workspaceId: 'w1',
    sessionId: 's1',
    seq,
    role: 'assistant',
    body: 'a body',
    jobId: `job-${seq}`,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    anchorKey: null,
    debugLanding: null,
    guideTurn: null,
    attachmentIds: [],
    confirm: null,
    codeUnreadable: null,
    runJobId: null,
    forwardOffer: null,
    forwardedEntryId: null,
    revisedLateJobId: null,
    authorId: null,
    createdAt: new Date('2026-10-10T09:00:00.000Z'),
    ...over,
  } as PlanChangeTurn;
}

function userRow(): PlanChangeTurn {
  return row({ role: 'user', body: 'add payments', authorId: 'u1', jobId: null });
}

function stateOf(rows: PlanChangeTurn[]): PlanChangeConversationState {
  const turns = rows.map(toPlanChangeTurnDto);
  return {
    phase: 'idle',
    session: {
      id: 's1',
      projectId: 'p1',
      turnCount: turns.length,
      targetKeys: [],
      lastJobId: null,
      lastSubmittedAt: null,
      turns,
      workItemRefs: {},
    } as unknown as PlanChangeConversationState['session'],
    progress: null,
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
    acts: [],
  } as PlanChangeConversationState;
}

function rail(state: PlanChangeConversationState, onRetry = vi.fn()) {
  return (
    <PlanChangeRail
      launch={{ mode: 'project' } as PlanningLaunch}
      projectName="Motir"
      state={state}
      index={indexPlanReview(null)}
      targets={[]}
      onAddTarget={() => {}}
      onRemoveTarget={() => {}}
      onSend={() => {}}
      onRetry={onRetry}
      onCorrectTurn={() => {}}
      onApprove={() => {}}
      onDiscard={() => {}}
      onStop={() => {}}
    />
  );
}

describe('the declined turn, rendered from a persisted row', () => {
  it('shows the fixed message and marker, no failure styling, and one Try again', () => {
    const onRetry = vi.fn();
    renderWithIntl(
      rail(
        stateOf([userRow(), row({ codeUnreadable: 'declined', body: 'stored fallback' })]),
        onRetry,
      ),
    );

    const notice = screen.getByTestId('plan-change-code-unreadable-notice');
    expect(notice.textContent).toContain(PLAN_BODY);
    // The words come from the catalogue, never from the stored body.
    expect(screen.queryByText('stored fallback')).toBeNull();
    expect(screen.getByTestId('plan-change-code-unreadable-marker').textContent).toBe(MARKER);
    // Information register, not the rose "That didn't go through" alert.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notice.className).toContain('--el-notice-info-bg');
    expect(notice.className).not.toMatch(/danger|rose/);

    fireEvent.click(screen.getByTestId('plan-change-code-unreadable-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('draws no plan card, proposal tree or review bar', () => {
    renderWithIntl(rail(stateOf([userRow(), row({ codeUnreadable: 'declined' })])));
    expect(screen.queryByTestId('plan-handoff')).toBeNull();
    expect(screen.queryByTestId('plan-change-report')).toBeNull();
  });

  it('keeps the notice on an earlier turn after a later ordinary one, with no button on it', () => {
    renderWithIntl(
      rail(
        stateOf([
          userRow(),
          row({ codeUnreadable: 'declined' }),
          userRow(),
          row({ body: 'Here is the plan.' }),
        ]),
      ),
    );
    expect(screen.getAllByTestId('plan-change-code-unreadable-notice')).toHaveLength(1);
    expect(screen.queryByTestId('plan-change-code-unreadable-retry')).toBeNull();
    expect(screen.getByText('Here is the plan.')).toBeTruthy();
  });

  it('shows Try again on only the latest declined turn when two outage turns stand', () => {
    renderWithIntl(
      rail(
        stateOf([
          userRow(),
          row({ codeUnreadable: 'declined' }),
          userRow(),
          row({ codeUnreadable: 'declined' }),
        ]),
      ),
    );
    expect(screen.getAllByTestId('plan-change-code-unreadable-notice')).toHaveLength(2);
    expect(screen.getAllByTestId('plan-change-code-unreadable-retry')).toHaveLength(1);
  });
});

describe('the answered turn, rendered from a persisted row', () => {
  const LONG = 'Billing runs through the invoice service. '.repeat(30).trim();

  it.each([
    ['a short answer', 'Billing runs through invoices.'],
    ['a long answer', LONG],
  ])('puts the notice ABOVE %s', (_label, answer) => {
    renderWithIntl(rail(stateOf([userRow(), row({ codeUnreadable: 'answered', body: answer })])));
    const bubble = screen.getByTestId('plan-change-report');
    const notice = within(bubble).getByTestId('plan-change-code-unreadable-ask-notice');
    expect(notice.textContent).toContain(ASK_NOTICE);
    expect(within(bubble).getByRole('status')).toBe(notice);
    expect(bubble.textContent).toContain(answer.slice(0, 40));
    // The notice precedes the answer in document order.
    const text = bubble.textContent ?? '';
    expect(text.indexOf(ASK_NOTICE)).toBeLessThan(text.indexOf(answer.slice(0, 20)));
    expect(screen.queryByTestId('plan-change-code-unreadable-retry')).toBeNull();
  });

  it('draws an answer with no face without any outage chrome', () => {
    renderWithIntl(rail(stateOf([userRow(), row({ body: 'Plain answer.' })])));
    expect(screen.queryByTestId('plan-change-code-unreadable-ask-notice')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('case 6 — neither face points at the Code page, and neither is state E', () => {
  it.each([
    ['declined', row({ codeUnreadable: 'declined' })],
    ['answered', row({ codeUnreadable: 'answered', body: 'An answer.' })],
  ])('the %s face has no link and no connect-a-repository remedy', (_label, assistant) => {
    renderWithIntl(rail(stateOf([userRow(), assistant])));
    const notices = screen.getAllByRole('status');
    for (const notice of notices) {
      expect(notice.querySelector('a')).toBeNull();
      expect(notice.textContent).not.toMatch(/connect a repository/i);
    }
    expect(document.body.querySelector('a[href*="/code"]')).toBeNull();
  });
});
