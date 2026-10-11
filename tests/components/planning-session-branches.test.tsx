// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const { shallowPush, resumePlanSession, fetchPlanReview } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  resumePlanSession: vi.fn(),
  fetchPlanReview: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=to-resume'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('@/lib/planning/planChangeClient', () => ({ resumePlanSession }));
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';

const { PlanningSessionResumeEntry } =
  await import('../../app/(authed)/workbench/_components/PlanningSessionResumeEntry');
const { PlanningSessionFormBody, useLeftLine } =
  await import('../../app/(authed)/workbench/_components/PlanningSessionResumeForms');
const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

// The small branches of the story's rendering that its sheets do not draw: an arrival, several
// targets, no target and no plan, an untitled waiting plan, a failure with no record, and an
// error that is not the client's own.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const AGO = new Date(Date.now() - 5 * 60_000).toISOString();
const t = en.workbench.planningSession;

function entry(over: Partial<ToResumePlanningSessionDto> = {}): ToResumePlanningSessionDto {
  return {
    sessionId: 's1',
    form: 'failed_walk',
    planId: 'p1',
    title: 'A titled plan',
    waitingPlan: null,
    projectName: 'Acme',
    targets: [],
    failure: { failedAt: AGO, reason: 'internal', stopPhase: null, stopRef: null, stopTitle: null },
    endedAt: null,
    progress: null,
    ...over,
  };
}

const mount = (e: ToResumePlanningSessionDto, arrived = false) =>
  renderWithIntl(
    <PlanningSessionResumeEntry entry={e} arrived={arrived} held={false} onSettled={vi.fn()} />,
  );

describe('PlanningSessionResumeEntry', () => {
  it('an arrival wears New; several targets read `+n` with every key in the title', () => {
    mount(
      entry({
        targets: [
          { key: 'ACME-1', title: 'One' },
          { key: 'ACME-2', title: 'Two' },
          { key: 'ACME-3', title: null },
        ],
      }),
      true,
    );
    expect(screen.getByText(en.workbench.live.new)).toBeTruthy();
    expect(screen.getByText('ACME-1 +2').getAttribute('title')).toBe('ACME-1, ACME-2, ACME-3');
  });

  it('a session with no target and no plan is named by its title, and opened by the session', () => {
    mount(entry({ planId: null, title: null }));
    expect(screen.getByText('Acme')).toBeTruthy(); // the project-name form
    const url = new URL(
      within(screen.getByTestId('to-resume-session-s1'))
        .getByTestId('to-resume-session-open')
        .getAttribute('href')!,
      'http://x',
    );
    expect(url.searchParams.get('planSession')).toBe('s1');
  });

  it('an error that is not the client’s own reads as the unavailable sentence', async () => {
    resumePlanSession.mockRejectedValue(new Error('network down'));
    mount(entry());
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(t.refusal.unavailable);
  });

  it('pressing Resume on an entry with no failure record sends nothing', () => {
    mount(entry({ failure: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resumePlanSession).not.toHaveBeenCalled();
  });
});

describe('PlanningSessionFormBody', () => {
  it('a failed walk with no failure record draws nothing', () => {
    const { container } = renderWithIntl(
      <PlanningSessionFormBody entry={entry({ failure: null })} />,
    );
    expect(container.textContent).toBe('');
  });

  it('the waiting plan beside a walk falls back to the project name when untitled', () => {
    renderWithIntl(
      <PlanningSessionFormBody
        entry={entry({ waitingPlan: { planId: 'w', title: null, status: 'planned' } })}
      />,
    );
    expect(within(screen.getByTestId('to-resume-also-waiting')).getByText('Acme')).toBeTruthy();
  });

  it('a form-B entry with no failure record or waiting plan still names the plan’s state', () => {
    renderWithIntl(
      <PlanningSessionFormBody
        entry={entry({ form: 'failed_beside_waiting_plan', failure: null, waitingPlan: null })}
      />,
    );
    expect(screen.getByText(t.form.b.stateWaiting)).toBeTruthy();
    expect(screen.queryByText(/^failed /)).toBeNull();
  });

  it('a form-C entry with no end time and no plan says nothing about when', () => {
    renderWithIntl(
      <PlanningSessionFormBody
        entry={entry({ form: 'ended_with_waiting_plan', failure: null, endedAt: null })}
      />,
    );
    expect(screen.getByText(t.form.c.gloss)).toBeTruthy();
    expect(screen.queryByText(/^The conversation ended/)).toBeNull();
  });
});

describe('PlanningSessionRow', () => {
  const waiting = (over: Record<string, unknown> = {}): ApprovalQueueRowDto => ({
    gateId: 'g1',
    kind: 'planning_session',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Yue',
    waitingSince: AGO,
    workItem: null,
    subject: {
      kind: 'planning_session',
      sessionId: 's1',
      planId: 'p1',
      cause: 'reply',
      question: null,
      plannerLine: null,
      since: AGO,
      planTitle: 'A plan',
      targetKey: null,
      targetTitle: null,
      projectName: 'Acme',
      ...over,
    },
  });

  it('an arrival wears New; no target means no key cell; an empty planner line draws only the lead', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} arrived />);
    expect(screen.getByText(en.workbench.approvals.live.new)).toBeTruthy();
    expect(screen.getByText(en.approvalGate.planningSession.row.waitReply)).toBeTruthy();
    expect(screen.queryByText(/ACME-/)).toBeNull();
  });
});

describe('useLeftLine', () => {
  const held = entry({
    form: 'failed_beside_waiting_plan',
    waitingPlan: { planId: 'w', title: null, status: 'planned' },
  });

  it('keeps the inferred line when the plan read fails', async () => {
    fetchPlanReview.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLeftLine(held, true));
    await waitFor(() => expect(fetchPlanReview).toHaveBeenCalled());
    expect(result.current).toBe('turn');
  });

  it('says nothing for an entry that has not left', () => {
    const { result } = renderHook(() => useLeftLine(held, false));
    expect(result.current).toBeNull();
    expect(fetchPlanReview).not.toHaveBeenCalled();
  });
});
