// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { ApprovalQueueRowDto, PlanningSessionSubjectSummaryDTO } from '@/lib/dto/approvalGate';

// THE PLANNING SESSION THAT NEEDS YOU, as a Waiting on you row (Story MOTIR-7905 · MOTIR-7917;
// design `design/workbench/design-notes.md` § 37.1). A `planning_session` gate belongs to no
// work item, so everything the row draws is its SUBJECT: § 29's three naming forms, the cause's
// lead line (the question, or *waiting on your reply* + the planner's line), `since`, NO verb —
// and a door that is the ONE plan-overlay door, never an address assembled by hand.

const { shallowPush, push, nav, fetchPlanReview } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  push: vi.fn(),
  nav: { params: new URLSearchParams('tab=approvals') },
  fetchPlanReview: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
// The door's read — proving it is NEVER made is half of this suite.
vi.mock('@/lib/planning/planReviewClient', () => ({ fetchPlanReview }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

const rowMsgs = en.approvalGate.planningSession.row;

function subject(
  over: Partial<PlanningSessionSubjectSummaryDTO> = {},
): PlanningSessionSubjectSummaryDTO {
  return {
    kind: 'planning_session',
    sessionId: 'sess-7',
    planId: 'plan-7',
    cause: 'question',
    question: 'Should the export include archived cards, or only the ones still open?',
    plannerLine: null,
    since: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    planTitle: null,
    targetKey: 'ACME-14',
    targetTitle: 'Export a report',
    projectName: 'Acme',
    ...over,
  };
}

let seq = 0;
function waiting(over: Partial<PlanningSessionSubjectSummaryDTO> = {}): ApprovalQueueRowDto {
  seq += 1;
  return {
    gateId: `gate-ps-${seq}`,
    kind: 'planning_session',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Yue',
    waitingSince: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    workItem: null,
    subject: subject(over),
  };
}

const door = () => screen.getAllByRole('link')[0]!;

beforeEach(() => {
  shallowPush.mockReset();
  push.mockReset();
  fetchPlanReview.mockReset();
  nav.params = new URLSearchParams('tab=approvals');
});
afterEach(cleanup);

describe('the LEADING LINE — § 29’s three forms, reused and not re-worded', () => {
  it('targeted: *Plan for {target title}*, the title is the quick-view door, the key follows', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    expect(screen.getByText('Plan for')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export a report' }).getAttribute('href')).toBe(
      '/items/ACME-14',
    );
    expect(screen.getByText('ACME-14')).toBeTruthy();
    expect(screen.getByText(rowMsgs.kind)).toBeTruthy();
  });

  it('named: no resolvable target, a plan title → *Plan — {title}*, plain text', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({ targetKey: null, targetTitle: null, planTitle: 'three stories' }),
        }}
      />,
    );
    expect(screen.getByText('Plan —')).toBeTruthy();
    expect(screen.getByText('three stories').tagName).toBe('SPAN');
  });

  it('project: nothing names it → *Plan for {project}*, never a blank', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({ targetKey: null, targetTitle: null, planTitle: null, planId: null }),
        }}
      />,
    );
    expect(screen.getByText('Plan for')).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
  });
});

describe('the cause’s lead line', () => {
  it('question: the planner asked, truncated to one line with the full text in `title`', () => {
    const question = 'Before I lay the second level I need to know about archived cards.';
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting({ question }) }} />);
    expect(screen.getByText(rowMsgs.asked)).toBeTruthy();
    const line = screen.getByText(question);
    expect(line.getAttribute('title')).toBe(question);
    expect(line.className).toContain('truncate');
  });

  it('reply: *waiting on your reply* + the planner’s last line, and no question', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({
            cause: 'reply',
            question: null,
            plannerLine: 'I laid the first level and listed three open choices.',
          }),
        }}
      />,
    );
    expect(screen.getByText(rowMsgs.waitReply)).toBeTruthy();
    expect(screen.getByText('I laid the first level and listed three open choices.')).toBeTruthy();
    expect(screen.queryByText(rowMsgs.asked)).toBeNull();
  });

  it('says since when, and offers NO approve / decline control', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    expect(screen.getByText(/^since /)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a card-less row of any OTHER non-plan kind still draws nothing', () => {
    const other = waiting();
    const { container } = renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: { ...other, kind: 'decision_choice', subject: null },
        }}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('the DOOR — the ONE plan-overlay door, with `known`, so no fetch', () => {
  it('a plain primary click opens the overlay in place, with `planVia=approvals`', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    const click = fireEvent.click(door());
    expect(click).toBe(false); // preventDefault — no navigation
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const url = new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/workbench');
    expect(url.searchParams.get('tab')).toBe('approvals');
    expect(url.searchParams.get('planSession')).toBe('sess-7');
    expect(url.searchParams.get('planVia')).toBe('approvals');
    expect(fetchPlanReview).not.toHaveBeenCalled();
  });

  it('a modified click is not prevented, and the row’s href IS the overlay address', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    const href = door().getAttribute('href')!;
    expect(new URL(href, 'http://x').searchParams.get('planSession')).toBe('sess-7');
    const notPrevented = fireEvent.click(door(), { metaKey: true });
    expect(notPrevented).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a question before the first proposal (no plan) opens at its SESSION', () => {
    renderWithIntl(
      <ApprovalRow
        record={{ section: 'awaiting', row: waiting({ planId: null, targetKey: null }) }}
      />,
    );
    fireEvent.click(door());
    const url = new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
    expect(url.searchParams.get('planSession')).toBe('sess-7');
    expect(fetchPlanReview).not.toHaveBeenCalled();
  });
});

describe('zh', () => {
  it('renders the row in Chinese, and the first tab is never called 待审批', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />, {
      locale: 'zh',
      messages: zh,
    });
    expect(screen.getByText(zh.approvalGate.planningSession.row.kind)).toBeTruthy();
    expect(screen.getByText(zh.approvalGate.planningSession.row.asked)).toBeTruthy();
    expect(zh.workbench.tabs.toApprove).not.toContain('待审批');
  });
});
