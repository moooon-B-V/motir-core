// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

import { renderWithIntl } from '../helpers/renderWithIntl';
import zh from '@/messages/zh.json';
import {
  CopiedDivider,
  EndedComposerSlot,
  RestartedDivider,
  SessionEndMarker,
  TakenBackNotice,
  PlanMovedAwayLine,
  TargetRefusal,
  WaitingPlanStillWaits,
  copiedTurnCount,
  offersCopy,
} from '@/components/planning/SessionEndParts';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The overlay's END PARTS on their own (Story MOTIR-7630 · MOTIR-7643) — the
// variants the rail's sheets do not reach: a decision's chip, an end with no named
// person, the project-scoped copy and take-back, and every refusal title.

afterEach(() => cleanup());

const SESSION: PlanChangeSessionDto = {
  id: 's1',
  projectId: 'p1',
  targetKeys: ['ACME-40'],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-07-27T10:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
};

const ENDED_AT = '2026-07-27T11:00:00.000Z';

describe('SessionEndMarker', () => {
  it('draws nothing for an open session', () => {
    const { container } = renderWithIntl(<SessionEndMarker session={SESSION} />);
    expect(container.textContent).toBe('');
  });

  it('an APPROVED end reads Approved, by the approver', () => {
    renderWithIntl(
      <SessionEndMarker
        session={{
          ...SESSION,
          endedAt: ENDED_AT,
          endReason: 'approved',
          endedBy: { id: 'u2', name: 'Mara' },
        }}
      />,
    );
    const marker = screen.getByTestId('planning-session-end');
    expect(marker.textContent).toContain('Approved');
    expect(marker.textContent).toContain('Mara');
  });

  it('a decision whose person is gone still reads its chip and its time', () => {
    renderWithIntl(
      <SessionEndMarker session={{ ...SESSION, endedAt: ENDED_AT, endReason: 'declined' }} />,
    );
    const marker = screen.getByTestId('planning-session-end');
    expect(marker.textContent).toContain('Declined');
    expect(marker.querySelector('[title]')).toBeTruthy();
  });

  it('a RESTART reads Closed — Motir’s ending, not a decision', () => {
    renderWithIntl(
      <SessionEndMarker session={{ ...SESSION, endedAt: ENDED_AT, endReason: 'restarted' }} />,
    );
    expect(screen.getByTestId('planning-session-end').textContent).toContain('Closed');
  });
});

describe('the copy', () => {
  it('counts only the turns older than the copy itself, and none on a session that is no copy', () => {
    const turn = (id: string, createdAt: string) => ({ ...turnBase, id, createdAt });
    const copy = {
      ...SESSION,
      copiedFromSessionId: 's0',
      turns: [turn('t0', '2026-07-27T08:00:00.000Z'), turn('t1', '2026-07-27T09:30:00.000Z')],
    };
    expect(copiedTurnCount(copy)).toBe(1);
    expect(copiedTurnCount({ ...copy, copiedFromSessionId: null })).toBe(0);
    expect(copiedTurnCount(null)).toBe(0);
  });

  it('the divider on a PROJECT session links the source by id', () => {
    renderWithIntl(<CopiedDivider fromSessionId="s0" anchorKey={null} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('s0');
  });

  it('offers the copy for a failed or idle end, to its starter, who may plan', () => {
    const failed = { ...SESSION, endedAt: ENDED_AT, endReason: 'failed' as const };
    expect(offersCopy(failed, false)).toBe(true);
    expect(offersCopy({ ...failed, endReason: 'idle' }, false)).toBe(true);
    expect(offersCopy({ ...failed, endReason: 'approved' }, false)).toBe(false);
    expect(offersCopy(failed, true)).toBe(false);
    expect(offersCopy({ ...failed, startedByViewer: false }, false)).toBe(false);
  });
});

const turnBase = {
  id: 't',
  seq: 0,
  role: 'user' as const,
  body: 'x',
  jobId: null,
  question: null,
  isAnswer: false,
  intent: null,
  intentCorrected: false,
  citations: [],
  authorId: 'u1',
  createdAt: '2026-07-27T09:00:00.000Z',
};

describe('the take-back and the refusal', () => {
  it('a PROJECT take-back names the project', () => {
    renderWithIntl(<TakenBackNotice label={null} projectName="PayFlow" />);
    expect(screen.getByTestId('planning-taken-back').textContent).toContain('PayFlow');
  });

  it('a session held by someone UNNAMED says “someone”, and draws no link', () => {
    renderWithIntl(
      <TargetRefusal
        held={{
          target: 'ACME-40',
          holder: null,
          freesBy: '2026-07-27T12:30:00.000Z',
          holderSessionId: 's9',
        }}
      />,
    );
    expect(screen.getByTestId('planning-target-refused').textContent).toContain('ACME-40');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a NAMED person’s plan names them, with no free-by time', () => {
    renderWithIntl(
      <TargetRefusal
        held={{ target: 'ACME-40', holder: 'Mara', freesBy: null, holderSessionId: null }}
      />,
    );
    expect(screen.getByTestId('planning-target-refused').textContent).toContain('Mara');
  });
});

describe('TargetRefusal — a session that WAITS (Story MOTIR-7905 · MOTIR-7918)', () => {
  const waiting = {
    target: 'ACME-40',
    holder: 'Ana',
    freesBy: '2026-07-27T12:30:00.000Z',
    holderSessionId: 's9',
    sessionWaiting: true,
  };

  it('reads *Waiting on Ana* with NO free-by time, and keeps the link to their session', () => {
    renderWithIntl(<TargetRefusal held={{ ...waiting, waitingCause: 'failed' }} />);
    const block = screen.getByTestId('planning-target-refused');
    expect(screen.getByTestId('planning-waiting-on').textContent).toBe('Waiting on Ana');
    expect(block.textContent).not.toMatch(/free by|12:30|1:30/);
    expect(block.textContent).toContain('Their attempt failed');
    expect(screen.getByRole('link').textContent).toBe('Open their session');
  });

  it.each([
    ['question', 'asked a question'],
    ['reply', 'waiting for their reply'],
    ['failed', 'attempt failed'],
  ] as const)('the %s cause has its own sentence', (cause, fragment) => {
    renderWithIntl(<TargetRefusal held={{ ...waiting, waitingCause: cause }} />);
    expect(screen.getByTestId('planning-target-refused').textContent).toContain(fragment);
  });

  it('an unnamed holder reads *Waiting on someone*, with no link', () => {
    renderWithIntl(
      <TargetRefusal
        held={{ ...waiting, holder: null, holderSessionId: null, waitingCause: null }}
      />,
    );
    expect(screen.getByTestId('planning-waiting-on').textContent).toBe('Waiting on someone');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('with sessionWaiting false or absent it reads exactly as today (a free-by time)', () => {
    renderWithIntl(<TargetRefusal held={{ ...waiting, sessionWaiting: false }} />);
    expect(screen.queryByTestId('planning-waiting-on')).toBeNull();
    expect(screen.getByTestId('planning-target-refused').textContent).toContain('free by about');
  });

  it('renders under zh with no English', () => {
    renderWithIntl(<TargetRefusal held={{ ...waiting, waitingCause: 'reply' }} />, {
      locale: 'zh',
      messages: zh,
    });
    expect(screen.getByTestId('planning-waiting-on').textContent).toBe('正在等待 Ana');
    expect(screen.getByRole('link').textContent).toBe('打开他们的会话');
  });
});

describe('EndedComposerSlot', () => {
  const failed = { ...SESSION, endedAt: ENDED_AT, endReason: 'failed' as const };

  it('a reader without `ai:plan` gets the read-only reason', () => {
    renderWithIntl(
      <EndedComposerSlot session={failed} readOnly label="ACME-40" projectName="PayFlow" />,
    );
    expect(screen.getByTestId('planning-read-only')).toBeTruthy();
    expect(screen.queryByTestId('planning-session-ended')).toBeNull();
  });

  it('a project session that ended says the PROJECT conversation ended', () => {
    renderWithIntl(
      <EndedComposerSlot
        session={{ ...failed, endReason: 'declined' }}
        readOnly={false}
        label={null}
        projectName="PayFlow"
      />,
    );
    expect(screen.getByTestId('planning-read-only').textContent).toContain('PayFlow');
  });

  it('with no Start handler, a copyable end still says it ended', () => {
    renderWithIntl(
      <EndedComposerSlot session={failed} readOnly={false} label="ACME-40" projectName="PayFlow" />,
    );
    expect(screen.getByTestId('planning-read-only').textContent).toContain('ACME-40');
  });
});

describe('RestartedDivider', () => {
  it.each([
    ['a card session', 'ACME-40'],
    ['a project session', null],
  ] as const)('on %s, Open it reopens the ended session by id', (_name, anchorKey) => {
    renderWithIntl(<RestartedDivider fromSessionId="s1" anchorKey={anchorKey} />);
    expect(screen.getByTestId('planning-restart-earlier').textContent).toContain(
      'Your earlier session is closed',
    );
    const link = screen.getByRole('link', { name: 'Open it' });
    expect(link.getAttribute('href')).toContain('planSession=s1');
    fireEvent.click(link);
    expect(shallowPush).toHaveBeenLastCalledWith(expect.stringContaining('planSession=s1'));
  });
});

// The CARRY's parts (Story MOTIR-7928 · MOTIR-7932) on the arms the rail's sheets do
// not reach: a project-scoped moved-away link, a take-back with no scope label, and
// the slot's decided / not-yours lines.
describe('the carry', () => {
  it.each([
    ['a card session', 'ACME-40'],
    ['a project session', null],
  ] as const)('on %s, the moved-away line opens the newer session by id', (_name, anchorKey) => {
    renderWithIntl(<PlanMovedAwayLine toSessionId="s2" anchorKey={anchorKey} />);
    const link = screen.getByRole('link', { name: 'Open the newer session' });
    expect(link.getAttribute('href')).toContain('planSession=s2');
  });

  it('a take-back with no scope label names the project', () => {
    renderWithIntl(<WaitingPlanStillWaits planId="p1" label={null} projectName="PayFlow" />);
    expect(screen.getByTestId('planning-taken-back-waiting').textContent).toContain('PayFlow');
  });

  const waiting: PlanChangeSessionDto = {
    ...SESSION,
    endedAt: ENDED_AT,
    endReason: 'restarted',
    pendingPlanId: 'plan-1',
  };

  it('a carry refused by a decision says nothing is left to continue', () => {
    renderWithIntl(
      <EndedComposerSlot
        session={waiting}
        readOnly={false}
        label="ACME-40"
        projectName="PayFlow"
        carryDecided
      />,
    );
    expect(screen.getByTestId('planning-read-only').textContent).toContain(
      'nothing left to continue',
    );
  });

  it.each([
    ['a named starter', { id: 'u2', name: 'Mara' }, 'Only Mara'],
    ['an unnamed starter', null, 'Only someone'],
  ] as const)('another member, with %s, is told whose plan it is', (_name, startedBy, text) => {
    renderWithIntl(
      <EndedComposerSlot
        session={{ ...waiting, startedByViewer: false, startedBy }}
        readOnly={false}
        label="ACME-40"
        projectName="PayFlow"
      />,
    );
    expect(screen.getByTestId('planning-read-only').textContent).toContain(text);
  });
});
