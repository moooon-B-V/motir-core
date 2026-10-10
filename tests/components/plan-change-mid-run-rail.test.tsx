// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { refusalKey } from '@/components/planning/MidRunTurn';
import { forwardOfferStale, threadOwnedMailboxIds } from '@/lib/planning/planChangeThread';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeDiffIndex } from '@/lib/planning/planChangeDiff';
import type { PlanningLaunch } from '@/lib/planning/launcher';
import zh from '@/messages/zh.json';

// THE MID-RUN CONVERSATION, drawn (Story MOTIR-7990 · MOTIR-7998; design
// `plan-change-run-live--answer-or-forward.mock.html`, states 1–5 and 10–13).
// Hand-built DTO and state fixtures: the routing, the forward and the late
// revision are their own work items, and what is under test here is only how the
// rail DRAWS what they leave behind.

const INDEX = {
  isEmpty: true,
  counts: { added: 0, changed: 0, removed: 0 },
} as unknown as PlanChangeDiffIndex;

let seq = 0;
function turn(over: Partial<PlanChangeTurnDto>): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body: '',
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    createdAt: '2026-10-09T09:00:00.000Z',
    authorId: 'u1',
    ...over,
  };
}

function stateOf(
  turns: PlanChangeTurnDto[],
  over: Partial<PlanChangeConversationState> = {},
): PlanChangeConversationState {
  return {
    phase: 'streaming',
    session: {
      id: 's1',
      projectId: 'p1',
      turnCount: turns.length,
      targetKeys: [],
      lastJobId: 'run-1',
      lastSubmittedAt: '2026-10-09T09:00:00.000Z',
      turns,
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
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [{ kind: 'searching' }],
    ...over,
  } as PlanChangeConversationState;
}

function rail(
  state: PlanChangeConversationState,
  extra: { onSelectProposal?: (id: string) => void } = {},
) {
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
      {...extra}
    />
  );
}

const draftOf = (c: HTMLElement) => (c.querySelector('textarea') as HTMLTextAreaElement).value;

afterEach(() => cleanup());

const forwardedTurn = (id: string, body: string, entry: string) =>
  turn({ id, body, runJobId: 'run-1', jobId: `ask-${id}`, forwarded: { mailboxEntryId: entry } });

describe('one render per forwarded change', () => {
  it('draws the text once, with the acknowledgement and the queued label under it', () => {
    const t = forwardedTurn('u1', 'Add a card for pausing.', 'e1');
    renderWithIntl(
      rail(stateOf([t], { queued: [{ id: 'e1', text: 'Add a card for pausing.', read: false }] })),
    );

    expect(screen.getAllByText(/Add a card for pausing\./)).toHaveLength(1);
    expect(screen.getByTestId('plan-change-forwarded').textContent).toContain(
      'I passed it to the planner',
    );
    expect(screen.getByTestId('plan-change-forwarded-queued').textContent).toBe(
      'Queued — the planner reads this at its next step.',
    );
    const bubble = screen.getByTestId('conversation-user-turn');
    expect(within(bubble).getByText('queued')).toBeTruthy();
    // …and the standalone mailbox row is NOT drawn for an entry the thread owns.
    expect(screen.queryByTestId('plan-change-queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-queued-read')).toBeNull();
  });

  it('keeps the standalone render for a mailbox-only entry', () => {
    renderWithIntl(
      rail(stateOf([], { queued: [{ id: 'restart-1', text: 'Start over please.', read: false }] })),
    );
    expect(screen.getByTestId('plan-change-queued')).toBeTruthy();
    expect(screen.getAllByText('Start over please.')).toHaveLength(1);
  });

  it('threadOwnedMailboxIds returns the forwarded ids and the extras', () => {
    const turns = [forwardedTurn('u1', 'a', 'e1'), turn({ body: 'plain' })];
    const ids = threadOwnedMailboxIds(turns, ['e9']);
    expect([...ids].sort()).toEqual(['e1', 'e9']);
  });
});

describe('queued → read', () => {
  it('shows the read state with no queued label', () => {
    const t = forwardedTurn('u1', 'Add a card.', 'e1');
    renderWithIntl(rail(stateOf([t], { queued: [{ id: 'e1', text: 'Add a card.', read: true }] })));

    expect(screen.getByTestId('plan-change-forwarded-read').textContent).toBe(
      'Read — the planner has it.',
    );
    const bubble = screen.getByTestId('conversation-user-turn');
    expect(within(bubble).getByText('read')).toBeTruthy();
    expect(screen.queryByText('queued')).toBeNull();
    expect(bubble.innerHTML).not.toContain('lucide-clock');
  });

  it('gives each of two forwarded turns its own state', () => {
    const turns = [
      forwardedTurn('u1', 'First change.', 'e1'),
      forwardedTurn('u2', 'Second change.', 'e2'),
    ];
    renderWithIntl(
      rail(
        stateOf(turns, {
          queued: [
            { id: 'e1', text: 'First change.', read: true },
            { id: 'e2', text: 'Second change.', read: false },
          ],
        }),
      ),
    );
    expect(screen.getAllByTestId('plan-change-forwarded-read')).toHaveLength(1);
    expect(screen.getAllByTestId('plan-change-forwarded-queued')).toHaveLength(1);
    const [first, second] = screen.getAllByTestId('conversation-user-turn');
    expect(within(first!).getByText('read')).toBeTruthy();
    expect(within(second!).getByText('queued')).toBeTruthy();
  });
});

describe('a question is not queued', () => {
  it('renders no label, acknowledgement or read state on a mid-run question', () => {
    const q = turn({ body: 'How far along is it?', runJobId: 'run-1', jobId: 'ask-q' });
    const a = turn({ role: 'assistant', body: 'It is laying level 3.', jobId: 'ask-q' });
    renderWithIntl(rail(stateOf([q, a])));

    const bubble = screen.getByTestId('conversation-user-turn');
    expect(bubble.textContent).toContain('How far along is it?');
    expect(screen.queryByText('queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded-read')).toBeNull();
    // The answer says it was given on the side.
    expect(screen.getByTestId('plan-change-answered-aside').textContent).toBe(
      'Answered on the side — nothing was sent to the run.',
    );
  });
});

describe('answering (state 1)', () => {
  it('shows the question and the cue while the act rail stays', () => {
    renderWithIntl(rail(stateOf([], { midRunAsk: { text: 'Why is it slow?' } })));
    expect(screen.getByTestId('plan-change-pending-ask').textContent).toContain('Why is it slow?');
    expect(screen.getByTestId('plan-change-answering')).toBeTruthy();
    expect(screen.getByTestId('plan-change-answering-marker').textContent).toBe(
      'Answering on the side — the run keeps going.',
    );
    expect(screen.getByTestId('plan-change-acts')).toBeTruthy();
    expect(screen.getByTestId('plan-change-running-bar')).toBeTruthy();
  });

  it('does not draw the question twice once the thread holds it', () => {
    const q = turn({ body: 'Why is it slow?', runJobId: 'run-1', jobId: 'ask-q' });
    renderWithIntl(rail(stateOf([q], { midRunAsk: { text: 'Why is it slow?' } })));
    expect(screen.getAllByText('Why is it slow?')).toHaveLength(1);
    expect(screen.getByTestId('plan-change-answering')).toBeTruthy();
  });
});

describe('a proposal named in an answer (state 3b)', () => {
  const answer = (body: string) => [
    turn({ body: 'Why?', runJobId: 'run-1', jobId: 'ask-1' }),
    turn({ role: 'assistant', body, jobId: 'ask-1', citations: [] }),
  ];

  it('draws the New chip with the title and no key or empty href', () => {
    const { container } = renderWithIntl(
      rail(stateOf(answer('It follows from [Billing exports](motir-ref:planItem:abc123).'))),
    );
    const ref = screen.getByTestId('plan-change-proposal-ref');
    expect(ref.textContent).toContain('Billing exports');
    expect(ref.textContent).toContain('New');
    expect(ref.textContent).not.toContain('abc123');
    expect(ref.querySelector('[data-proposed="true"]')).toBeTruthy();
    expect(container.querySelector('a[href=""]')).toBeNull();
  });

  it('selects the node through onSelectProposal when the host passes it', () => {
    const onSelectProposal = vi.fn();
    renderWithIntl(
      rail(stateOf(answer('See [Billing exports](motir-ref:planItem:abc123).')), {
        onSelectProposal,
      }),
    );
    fireEvent.click(within(screen.getByTestId('plan-change-proposal-ref')).getByRole('button'));
    expect(onSelectProposal).toHaveBeenCalledWith('abc123');
  });

  it('renders a malformed link as its plain label', () => {
    const { container } = renderWithIntl(
      rail(stateOf(answer('See [Broken one](motir-ref:planItem:a b).'))),
    );
    expect(screen.queryByTestId('plan-change-proposal-ref')).toBeNull();
    expect(container.querySelector('a[href^="motir"], a[href=""]')).toBeNull();
    expect(screen.getByText(/Broken one/)).toBeTruthy();
  });
});

describe('the forward offer (state 5, next-turn form)', () => {
  const offered = () => [
    turn({ body: 'Maybe split the settings card?', runJobId: 'run-1', jobId: 'ask-1' }),
    turn({
      role: 'assistant',
      body: 'That could be a question or a change. I have not passed it on.',
      jobId: 'ask-1',
      forwardOffer: 'Maybe split the settings card?',
    }),
  ];

  it('offers the next-turn reply, with no button', () => {
    renderWithIntl(rail(stateOf(offered())));
    expect(screen.getByTestId('plan-change-forward-offer').textContent).toContain(
      'yes, forward it',
    );
    expect(screen.queryByTestId('plan-change-forward-stale')).toBeNull();
    const report = screen.getByTestId('plan-change-report');
    expect(within(report).queryByRole('button')).toBeNull();
  });

  it('goes stale once a later user turn was not forwarded', () => {
    const turns = [...offered(), turn({ body: 'What is MOTIR-7991 for?', runJobId: 'run-1' })];
    renderWithIntl(rail(stateOf(turns)));
    expect(screen.getByTestId('plan-change-forward-stale').textContent).toBe(
      'Not forwarded — nothing was changed.',
    );
  });

  it('forwardOfferStale ignores a later turn that WAS forwarded', () => {
    const turns = [...offered(), forwardedTurn('u9', 'yes, forward it', 'e9')];
    expect(forwardOfferStale(turns, 1)).toBe(false);
    expect(forwardOfferStale([...offered(), turn({ body: 'other' })], 1)).toBe(true);
  });

  it('no answer without an offer draws none', () => {
    const turns = [
      turn({ body: 'Why?', runJobId: 'run-1', jobId: 'ask-1' }),
      turn({ role: 'assistant', body: 'Because.', jobId: 'ask-1' }),
    ];
    renderWithIntl(rail(stateOf(turns)));
    expect(screen.queryByTestId('plan-change-forward-offer')).toBeNull();
  });
});

describe('a late change (state 10)', () => {
  it('draws the revision note and its link, and no queued label', () => {
    const t = turn({
      body: 'Also add an export card.',
      runJobId: 'run-1',
      revisedLate: { revisionJobId: 'rev-1' },
    });
    renderWithIntl(
      rail(
        stateOf([t], {
          phase: 'idle',
          lateRevision: { planId: 'plan-9', revisionJobId: 'rev-1', count: 1 },
        }),
      ),
    );
    const note = screen.getByTestId('plan-change-revision');
    expect(note.textContent).toContain('Applied as a revision of this plan.');
    const link = within(note).getByRole('link', { name: 'See it on the timeline' });
    expect(link.getAttribute('href')).toBe('/plans/plan-9');
    expect(screen.queryByText('queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded-queued')).toBeNull();
  });
});

describe('a change the end-of-run claim revised', () => {
  it('draws the revision note under the forwarded turn whose entry the revision carried', () => {
    const t = forwardedTurn('u1', 'Add an export card.', 'e1');
    renderWithIntl(
      rail(
        stateOf([t], {
          phase: 'idle',
          queued: [],
          lateRevision: { planId: 'plan-9', revisionJobId: 'rev-1', count: 1, entryIds: ['e1'] },
        }),
      ),
    );
    const note = screen.getByTestId('plan-change-revision');
    expect(within(note).getByRole('link').getAttribute('href')).toBe('/plans/plan-9');
  });

  it('leaves a forwarded turn the revision did not carry as it was', () => {
    const t = forwardedTurn('u1', 'Add an export card.', 'e1');
    renderWithIntl(
      rail(
        stateOf([t], {
          phase: 'idle',
          queued: [],
          lateRevision: { planId: 'plan-9', revisionJobId: 'rev-1', count: 1, entryIds: ['other'] },
        }),
      ),
    );
    expect(screen.queryByTestId('plan-change-revision')).toBeNull();
  });
});

describe('the run-ended refusal (state 11)', () => {
  const idle = (over: Partial<PlanChangeConversationState> = {}) =>
    stateOf([], { phase: 'idle', jobId: null, ...over });

  it('is a quiet band: no alert, no rose, no failure glyph', () => {
    renderWithIntl(
      rail(idle({ refusedForward: { text: 'add Y', code: 'PLAN_CHANGE_RUN_STOPPED' } })),
    );
    const band = screen.getByTestId('plan-change-forward-refusal');
    expect(band.textContent).toContain('You stopped this run.');
    expect(band.getAttribute('role')).toBeNull();
    expect(band.className).not.toContain('--el-tint-rose');
    expect(band.className).not.toContain('--el-danger');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts the refused text back in an empty composer', () => {
    const { container } = renderWithIntl(
      rail(idle({ refusedForward: { text: 'add Y', code: 'PLAN_CHANGE_JOB_NOT_RUNNING' } })),
    );
    expect(draftOf(container)).toBe('add Y');
    expect(screen.getByTestId('plan-change-forward-refusal').textContent).toContain(
      'It is in the box below.',
    );
  });

  it('leaves a newer draft alone and quotes the refused text instead', () => {
    const { container, rerender } = renderWithIntl(rail(idle()));
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'my own words' } });
    rerender(rail(idle({ refusedForward: { text: 'add Y', code: 'PLAN_CHANGE_RUN_FAILED' } })));
    expect(draftOf(container)).toBe('my own words');
    const band = screen.getByTestId('plan-change-forward-refusal');
    expect(band.textContent).toContain('This run failed.');
    expect(band.textContent).toContain('“add Y”');
  });

  it('restores once per refusal, keyed on the refusal object', () => {
    const refusal = { text: 'add Y', code: 'PLAN_CHANGE_JOB_NOT_RUNNING' };
    const { container, rerender } = renderWithIntl(rail(idle({ refusedForward: refusal })));
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '' } });
    rerender(rail(idle({ refusedForward: refusal })));
    expect(draftOf(container)).toBe('');
    rerender(rail(idle({ refusedForward: { ...refusal } })));
    expect(draftOf(container)).toBe('add Y');
  });

  it('has its own line for every named code, and a generic one for the rest', () => {
    const codes = [
      'PLAN_CHANGE_JOB_NOT_RUNNING',
      'PLAN_CHANGE_PLAN_DECIDED',
      'PLAN_CHANGE_RUN_STOPPED',
      'PLAN_CHANGE_RUN_FAILED',
      'PLAN_REVISION_IN_FLIGHT',
      'PLAN_CHANGE_NO_PLAN',
    ];
    const keys = codes.map(refusalKey);
    expect(new Set(keys).size).toBe(codes.length);
    expect(keys).not.toContain('generic');
    expect(refusalKey('MOTIR_AI_OUT_OF_CREDITS')).toBe('generic');
    expect(refusalKey('toString')).toBe('generic');

    renderWithIntl(rail(idle({ refusedForward: { text: 'x', code: 'SOMETHING_ELSE' } })));
    expect(screen.getByTestId('plan-change-forward-refusal').textContent).toContain(
      'The run has ended, so this was not forwarded.',
    );
  });
});

describe('cannot read the run (state 12)', () => {
  it('is an assistant answer with no citation count and no offer', () => {
    const turns = [
      turn({ body: 'How far along?', runJobId: 'run-1', jobId: 'ask-1' }),
      turn({
        role: 'assistant',
        body: 'I could not read the plan or its steps just now, so I won’t guess.',
        jobId: 'ask-1',
        citations: [],
      }),
    ];
    renderWithIntl(rail(stateOf(turns)));
    expect(screen.getByText(/could not read the plan/)).toBeTruthy();
    expect(screen.queryByTestId('plan-change-citation-count')).toBeNull();
    expect(screen.queryByTestId('plan-change-forward-offer')).toBeNull();
  });
});

describe('no run, no change', () => {
  it('mounts none of the mid-run pieces on an ordinary thread', () => {
    const turns = [
      turn({ body: 'Add a card.', jobId: 'job-1' }),
      turn({ role: 'assistant', body: 'Done.', jobId: 'job-1' }),
    ];
    renderWithIntl(
      rail(
        stateOf(turns, {
          phase: 'idle',
          jobId: null,
          midRunAsk: null,
          refusedForward: null,
          lateRevision: null,
        }),
      ),
    );
    for (const id of [
      'plan-change-pending-ask',
      'plan-change-answering',
      'plan-change-forwarded',
      'plan-change-forward-refusal',
      'plan-change-revision',
      'plan-change-answered-aside',
      'plan-change-forward-offer',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });
});

describe('zh', () => {
  const zhRender = (state: PlanChangeConversationState) =>
    renderWithIntl(rail(state), {
      locale: 'zh',
      messages: zh as unknown as Record<string, unknown>,
    });

  it('draws the forwarded change in Chinese', () => {
    const t = forwardedTurn('u1', '加一张卡片。', 'e1');
    zhRender(stateOf([t], { queued: [{ id: 'e1', text: '加一张卡片。', read: false }] }));
    expect(screen.getByTestId('plan-change-forwarded').textContent).toContain('我已转交给规划者');
    expect(screen.getByTestId('plan-change-forwarded-queued').textContent).toBe(
      '已排队 —— 规划者会在下一步读到。',
    );
  });

  it('draws the forward offer in Chinese', () => {
    const turns = [
      turn({ body: '也许设置卡片应该拆开？', runJobId: 'run-1', jobId: 'a1' }),
      turn({ role: 'assistant', body: '这可能是个问题。', jobId: 'a1', forwardOffer: 'x' }),
      turn({ body: '另一个问题', runJobId: 'run-1' }),
    ];
    zhRender(stateOf(turns));
    expect(screen.getByTestId('plan-change-forward-offer').textContent).toContain('是，转交');
    expect(screen.getByTestId('plan-change-forward-stale').textContent).toBe(
      '未转交 —— 没有改动任何内容。',
    );
  });

  it('draws the refusal in Chinese', () => {
    zhRender(
      stateOf([], {
        phase: 'idle',
        jobId: null,
        refusedForward: { text: '加一张卡片', code: 'PLAN_CHANGE_RUN_STOPPED' },
      }),
    );
    expect(screen.getByTestId('plan-change-forward-refusal').textContent).toContain(
      '你停止了这次运行。',
    );
  });
});
