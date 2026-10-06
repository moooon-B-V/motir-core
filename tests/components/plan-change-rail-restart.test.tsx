// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// PLAN SOMETHING NEW in the rail (Story MOTIR-7631 · MOTIR-7650), drawn to
// MOTIR-7647's `planning-workspace--plan-something-new.mock.html`. The rail is
// presentational, so each panel is asserted by handing it the server's thread.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'Split the export work.' : 'Done.',
    jobId: role === 'assistant' ? 'job-1' : null,
    question: null,
    confirm: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-06T10:00:00.000Z',
    ...extra,
  };
}

const CONFIRM = turn(2, 'assistant', {
  jobId: null,
  confirm: 'new_session',
  // The STORED body — the rail must not render it; it reads the catalogue.
  body: 'stored body that should never show',
});

function session(
  turns: PlanChangeTurnDto[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-06T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...extra,
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([turn(0), turn(1, 'assistant')]),
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
};

const onRequestRestart = vi.fn();
const onAnswerRestart = vi.fn();

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  opts: { withRestart?: boolean; messages?: Record<string, unknown> } = {},
) {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      {...(opts.withRestart === false ? {} : { onRequestRestart, onAnswerRestart })}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the control (panel 1)', () => {
  it('sits in the rail head of an open session and raises the confirm', () => {
    renderRail();
    const control = screen.getByTestId('planning-restart-control');
    expect(control.textContent).toContain('Plan something new');
    expect((control as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(control);
    expect(onRequestRestart).toHaveBeenCalledTimes(1);
  });

  it('reads the zh catalogue', () => {
    renderRail({}, { messages: zhMessages });
    expect(screen.getByTestId('planning-restart-control').textContent).toContain('规划新内容');
  });
});

describe('where the control is absent or disabled (panel 5)', () => {
  it.each([
    ['no session yet', { session: null }],
    ['a read-only reopen', { readOnly: true }],
    ["somebody else's session", { session: session([turn(0)], { startedByViewer: false }) }],
    ['a guide conversation', { session: session([turn(0)], { origin: 'guide' }) }],
    [
      'an ended session',
      {
        session: session([turn(0)], {
          endedAt: '2026-10-06T11:00:00.000Z',
          endReason: 'restarted',
        }),
      },
    ],
  ] as const)('is absent on %s', (_name, state) => {
    renderRail(state as Partial<PlanChangeConversationState>);
    expect(screen.queryByTestId('planning-restart-control')).toBeNull();
  });

  it('is absent when the host offers no restart', () => {
    renderRail({}, { withRestart: false });
    expect(screen.queryByTestId('planning-restart-control')).toBeNull();
  });

  it('is disabled while a run streams, and names why', () => {
    renderRail({ phase: 'streaming', jobId: 'job-2' });
    const control = screen.getByTestId('planning-restart-control');
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Available when this run finishes')).toBeTruthy();
  });
});

describe('the confirm (panel 2)', () => {
  it('renders the catalogue question with Confirm and Keep planning while it is the latest turn', () => {
    renderRail({ session: session([turn(0), turn(1, 'assistant'), CONFIRM]) });
    const confirmTurn = screen.getByTestId('planning-restart-confirm-turn');
    expect(confirmTurn.textContent).toContain(
      'Start something new? This closes the current planning session and gives its work items back.',
    );
    expect(confirmTurn.textContent).not.toContain('stored body');

    fireEvent.click(within(confirmTurn).getByTestId('planning-restart-confirm'));
    expect(onAnswerRestart).toHaveBeenCalledWith('confirm');
    fireEvent.click(within(confirmTurn).getByTestId('planning-restart-keep'));
    expect(onAnswerRestart).toHaveBeenCalledWith('keep');
  });

  it('holds its answers still while one is in flight', () => {
    renderRail({ session: session([turn(0), CONFIRM]), restarting: true });
    expect((screen.getByTestId('planning-restart-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('planning-restart-keep') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('planning-restart-control') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('a later turn leaves it as a record without its buttons', () => {
    renderRail({ session: session([turn(0), CONFIRM, turn(3)]) });
    expect(screen.getByTestId('planning-restart-confirm-turn')).toBeTruthy();
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
  });

  it('a read-only reader sees the confirm with no answers', () => {
    renderRail({ session: session([turn(0), CONFIRM]), readOnly: true });
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
  });
});

describe('after Keep planning (panel 3)', () => {
  it('the system turn after the confirm reads Kept planning; other markers keep their line', () => {
    renderRail({
      session: session([
        turn(0, 'system', { body: 'intent' }),
        turn(1),
        CONFIRM,
        turn(3, 'system', { body: 'Kept planning.' }),
      ]),
    });
    expect(screen.getByTestId('planning-restart-kept').textContent).toContain('Kept planning');
    expect(screen.getByTestId('plan-change-marker')).toBeTruthy();
    expect(screen.queryByTestId('planning-restart-confirm')).toBeNull();
    // The control is still there for a later change of mind.
    expect(screen.getByTestId('planning-restart-control')).toBeTruthy();
  });
});

describe('the swap (panel 4)', () => {
  it('draws the earlier-session line on the new session, and Open it reopens the ended one', () => {
    renderRail({ session: session([], { id: 's2' }), restartedFrom: 's1' });
    const line = screen.getByTestId('planning-restart-earlier');
    expect(line.textContent).toContain('Your earlier session is closed');
    const link = within(line).getByRole('link', { name: 'Open it' });
    expect(link.getAttribute('href')).toContain('planSession=s1');
    fireEvent.click(link);
    expect(shallowPush).toHaveBeenCalledWith(expect.stringContaining('planSession=s1'));
    expect(
      screen.getByText('Your earlier session is closed. A new session is open.').className,
    ).toContain('sr-only');
  });

  it('draws no earlier-session line without a restart', () => {
    renderRail();
    expect(screen.queryByTestId('planning-restart-earlier')).toBeNull();
  });
});
