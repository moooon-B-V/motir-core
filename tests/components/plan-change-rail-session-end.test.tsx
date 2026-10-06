// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanningTarget } from '@/lib/planning/planningTargets';

// THE SESSION'S END in the rail (Story MOTIR-7630 · MOTIR-7643), drawn to
// MOTIR-7633's `planning-workspace--session-end.mock.html`. The rail is
// presentational, so each sheet is asserted by handing it the server's row.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });

function turn(
  seq: number,
  body: string,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: role === 'user' ? null : 'job-1',
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-07-27T10:00:00.000Z',
    ...extra,
  };
}

function session(turns: PlanChangeTurnDto[], targetKeys: string[] = []): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys,
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([]),
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

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  launch: typeof LAUNCH = LAUNCH,
  targets: PlanningTarget[] = [],
) {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={launch}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={targets}
      {...handlers}
      onStartNewSession={onStartNewSession}
    />,
  );
}

const onStartNewSession = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ENDED_AT = '2026-07-27T11:00:00.000Z';

function endedSession(
  endReason: NonNullable<PlanChangeSessionDto['endReason']>,
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    ...session([turn(0, 'Split ACME-40.')], ['ACME-40']),
    endedAt: ENDED_AT,
    endReason,
    startedByViewer: true,
    ...extra,
  };
}

describe('an ENDED session (AMENDMENT 23 §1)', () => {
  it('a FAILED end: the failure line with NO Try again, the Closed marker, and the Start slot', () => {
    renderRail({ session: endedSession('failed'), errorCode: 'FAILED' });
    expect(screen.getByTestId('planning-failed-closed')).toBeTruthy();
    const marker = screen.getByTestId('planning-session-end');
    expect(marker.getAttribute('data-end-reason')).toBe('failed');
    expect(marker.textContent).toContain('Closed');
    // A retry would append to a session that accepts no turn.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /start a new session/i }));
    expect(onStartNewSession).toHaveBeenCalledTimes(1);
  });

  it('an IDLE end offers the copy too — but never the failure line', () => {
    renderRail({ session: endedSession('idle') });
    expect(screen.queryByTestId('planning-failed-closed')).toBeNull();
    expect(screen.getByTestId('planning-session-ended')).toBeTruthy();
  });

  it('a DECIDED session never offers the copy: Declined reads as Declined, by its person', () => {
    renderRail({
      session: endedSession('declined', { endedBy: { id: 'u2', name: 'Mara' } }),
    });
    const marker = screen.getByTestId('planning-session-end');
    expect(marker.textContent).toContain('Declined');
    expect(marker.textContent).toContain('Mara');
    expect(screen.queryByTestId('planning-session-ended')).toBeNull();
    expect(screen.getByTestId('planning-read-only').textContent).toContain('ACME-40');
  });

  it('a session someone ELSE started is read-only to its reader, even after a failure', () => {
    renderRail({ session: endedSession('failed', { startedByViewer: false }) });
    expect(screen.queryByTestId('planning-session-ended')).toBeNull();
    expect(screen.getByTestId('planning-read-only')).toBeTruthy();
  });
});

describe('a COPIED session (AMENDMENT 23 §6)', () => {
  it('draws the divider under the copied turns, and only there', () => {
    renderRail({
      session: {
        ...session(
          [
            turn(0, 'Split ACME-40.', 'user', { createdAt: '2026-07-27T09:00:00.000Z' }),
            turn(1, 'Make it three.', 'user', { createdAt: '2026-07-27T12:05:00.000Z' }),
          ],
          ['ACME-40'],
        ),
        id: 's2',
        createdAt: '2026-07-27T12:00:00.000Z',
        copiedFromSessionId: 's1',
      },
    });
    const divider = screen.getByTestId('planning-copied-divider');
    const before = screen.getByText('Split ACME-40.');
    const after = screen.getByText('Make it three.');
    expect(before.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a session that is no copy has no divider', () => {
    renderRail({ session: session([turn(0, 'Split ACME-40.')]) });
    expect(screen.queryByTestId('planning-copied-divider')).toBeNull();
  });
});

describe('the take-back and the refusal (AMENDMENT 23 §3–§4)', () => {
  it('says the person is BACK in the session they already had open', () => {
    renderRail({
      session: { ...session([turn(0, 'Split ACME-40.')], ['ACME-40']), takenBack: true },
    });
    expect(screen.getByTestId('planning-taken-back').textContent).toContain('ACME-40');
  });

  it('another person’s SESSION: names them, says when it frees, links it, and holds the composer', () => {
    renderRail({
      targetHeld: {
        target: 'ACME-40',
        holder: 'Mara',
        freesBy: '2026-07-27T12:30:00.000Z',
        holderSessionId: 's_mara',
      },
    });
    const refusal = screen.getByTestId('planning-target-refused');
    expect(refusal.getAttribute('role')).toBe('status');
    expect(refusal.textContent).toContain('Mara');
    expect(refusal.textContent).toContain('ACME-40');
    expect(screen.getByRole('link', { name: /mara/i })).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('a PLAN’s hold has no free-by and no link; an unnamed holder is “someone”', () => {
    renderRail({
      targetHeld: { target: 'ACME-40', holder: null, freesBy: null, holderSessionId: null },
    });
    const refusal = screen.getByTestId('planning-target-refused');
    expect(refusal.textContent).toContain('ACME-40');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('taking the held card OUT of the tray re-enables the composer', () => {
    const other: PlanningTarget = {
      id: 'wi_41',
      identifier: 'ACME-41',
      title: 'Other',
      kind: 'story',
    };
    renderRail(
      {
        targetHeld: {
          target: 'ACME-40',
          holder: 'Mara',
          freesBy: '2026-07-27T12:30:00.000Z',
          holderSessionId: 's_mara',
        },
      },
      LAUNCH,
      [other],
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });
});
