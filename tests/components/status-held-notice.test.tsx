// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';

const { shallowPushSpy } = vi.hoisted(() => ({ shallowPushSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams('tab=activity'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: shallowPushSpy }));
// A plan hold must NEVER open the approval overlay (ADR `approval-gates.md`
// §11.5b) — the real address builder, spied so a plan line can prove it is unused.
vi.mock('@/lib/approvals/overlayAddress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/approvals/overlayAddress')>();
  return { ...actual, withApprovalOverlay: vi.fn(actual.withApprovalOverlay) };
});

import { StatusHeldNotice, type StatusHeldLine } from '@/components/issues/StatusHeldNotice';
import { StatusPicker } from '@/components/issues/StatusPicker';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import { planRowDestination } from '@/lib/planning/planDestination';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';

// THE STATUS CONTROL SAYS SO (Story MOTIR-4887 · Subtask MOTIR-5528), built to
// `design/work-items/status-held-by-decision.mock.html`. One line per held status;
// the door appears ONLY on a decidable decision line.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const line = (over: Partial<StatusHeldLine>): StatusHeldLine => ({
  statusKey: 'done',
  statusLabel: 'Done',
  waitingOn: 'decision',
  kind: 'design_result',
  gateRaised: true,
  canDecide: true,
  routedToLabel: 'Ada Lovelace',
  ...over,
});

describe('StatusHeldNotice', () => {
  it('a decidable decision line says so and carries Review & approve into the overlay over THIS page', () => {
    render(<StatusHeldNotice itemKey="PROD-7" lines={[line({})]} />);

    const notice = screen.getByTestId('status-held-notice');
    expect(notice.textContent).toContain(
      "Status can't be moved to Done directly — a design approval is waiting.",
    );
    const door = within(notice).getByRole('link', { name: 'Review & approve' });
    expect(door.getAttribute('href')).toBe(
      '/items/PROD-7?tab=activity&approval=PROD-7&approvalKind=design_result',
    );
    fireEvent.click(door);
    expect(shallowPushSpy).toHaveBeenCalledWith(
      '/items/PROD-7?tab=activity&approval=PROD-7&approvalKind=design_result',
    );
  });

  it('a reader who may only look is told whose decision it is, and gets no button', () => {
    render(<StatusHeldNotice itemKey="PROD-7" lines={[line({ canDecide: false })]} />);
    expect(screen.getByTestId('status-held-notice').textContent).toContain(
      'a design approval is waiting on Ada Lovelace.',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('with an open pull request: Approved waits on the decision (with the door), Done on the merge (never a door)', () => {
    render(
      <StatusHeldNotice
        itemKey="PROD-7"
        lines={[
          line({ statusKey: 'approved', statusLabel: 'Approved', kind: 'pull_request_approval' }),
          line({ statusKey: 'done', waitingOn: 'merge', kind: 'pull_request_approval' }),
        ]}
      />,
    );
    const text = screen.getByTestId('status-held-notice').textContent ?? '';
    expect(text).toContain(
      "Status can't be moved to Approved directly — a pull-request approval is waiting.",
    );
    expect(text).toContain(
      "Status can't be moved to Done directly — merging the pull request moves it.",
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('no gate raised yet says the approval is asked for once the checks pass, with no button', () => {
    render(
      <StatusHeldNotice
        itemKey="PROD-7"
        lines={[
          line({
            statusKey: 'approved',
            statusLabel: 'Approved',
            kind: 'pull_request_approval',
            gateRaised: false,
            canDecide: false,
            routedToLabel: null,
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('status-held-notice').textContent).toContain(
      "is asked for once the pull request's checks pass.",
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing when nothing is held', () => {
    render(<StatusHeldNotice itemKey="PROD-7" lines={[]} />);
    expect(screen.queryByTestId('status-held-notice')).toBeNull();
  });

  it('ships in zh', () => {
    render(<StatusHeldNotice itemKey="PROD-7" lines={[line({ waitingOn: 'merge' })]} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByTestId('status-held-notice').textContent).toContain(
      '合并该合并请求后会自动变更',
    );
  });
});

// THE STATUS CONTROL SAYS A PLAN HOLDS IT (Story MOTIR-6017 · MOTIR-6267), built to
// `design/work-items/status-held-by-decision--plan-hold.mock.html`.
describe('StatusHeldNotice — a plan hold', () => {
  const plan = (over: Partial<PlanHoldDTO> = {}): PlanHoldDTO => ({
    itemKey: 'PROD-7',
    workItemId: 'wi_7',
    planId: 'pln_7c3a91',
    planStatus: 'generating',
    sessionId: 'pcs_41f8',
    anchorKey: 'PROD-7',
    ...over,
  });
  /** The door's href, as the ONE destination rule computes it for this page. */
  const expectedHref = (p: PlanHoldDTO) =>
    planRowDestination({
      planStatus: p.planStatus,
      planId: p.planId,
      sessionId: p.sessionId,
      host: '/items/PROD-7?tab=activity',
      anchorKey: p.anchorKey,
    }).href;

  it.each([
    ['generating', 'Motir AI is still writing this plan.'],
    ['planned', 'This plan is waiting for approval.'],
    ['stale', 'This plan needs attention before it can be approved.'],
  ] as const)(
    'plan %s: the refusal, what the plan is doing, and Review plan onto the planning surface',
    (planStatus, second) => {
      const hold = plan({ planStatus });
      render(<StatusHeldNotice itemKey="PROD-7" lines={[]} plan={hold} />);

      const notice = screen.getByTestId('status-held-notice');
      expect(notice.textContent).toContain("Status can't be changed while a plan is open.");
      expect(notice.textContent).toContain(second);
      const door = within(notice).getByRole('link', { name: 'Review plan' });
      const href = expectedHref(hold);
      expect(href).toContain('planSession=pcs_41f8');
      expect(door.getAttribute('href')).toBe(href);
      expect(door.getAttribute('data-plan-door')).toBe('planning-surface');

      fireEvent.click(door);
      expect(shallowPushSpy).toHaveBeenCalledWith(href);
      expect(withApprovalOverlay).not.toHaveBeenCalled();
    },
  );

  it('a plan with NO session opens /plans/<id> as an ordinary link — same copy', () => {
    const hold = plan({ planStatus: 'planned', sessionId: null });
    render(<StatusHeldNotice itemKey="PROD-7" lines={[]} plan={hold} />);

    const notice = screen.getByTestId('status-held-notice');
    expect(notice.textContent).toContain("Status can't be changed while a plan is open.");
    expect(notice.textContent).toContain('This plan is waiting for approval.');
    const door = within(notice).getByRole('link', { name: 'Review plan' });
    expect(door.getAttribute('href')).toBe(expectedHref(hold));
    expect(door.getAttribute('href')).toBe('/plans/pln_7c3a91');
    expect(door.getAttribute('data-plan-door')).toBe('plan-page');
    expect(withApprovalOverlay).not.toHaveBeenCalled();
  });

  it('a plan AND a gate: both lines, the plan FIRST, and the gate line carries NO button', () => {
    render(
      <StatusHeldNotice
        itemKey="PROD-7"
        lines={[line({ canDecide: true })]}
        plan={plan({ planStatus: 'planned' })}
      />,
    );
    const notice = screen.getByTestId('status-held-notice');
    const rows = notice.querySelectorAll('[data-waiting-on]');
    expect([...rows].map((r) => r.getAttribute('data-waiting-on'))).toEqual(['plan', 'decision']);
    expect(rows[1]!.textContent).toBe(
      'A design approval is waiting on this item too — it can be decided once the plan is.',
    );
    // The one door is the plan's; there is no Review & approve.
    expect(
      within(notice)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Review plan']);
    expect(withApprovalOverlay).not.toHaveBeenCalled();
  });

  it('renders nothing with no plan and no lines', () => {
    render(<StatusHeldNotice itemKey="PROD-7" lines={[]} plan={null} />);
    expect(screen.queryByTestId('status-held-notice')).toBeNull();
  });

  it('ships in zh', () => {
    render(
      <StatusHeldNotice itemKey="PROD-7" lines={[line({})]} plan={plan({ planStatus: 'stale' })} />,
      { locale: 'zh', messages: zhMessages },
    );
    const text = screen.getByTestId('status-held-notice').textContent ?? '';
    expect(text).toContain('计划未决定前无法更改状态。');
    expect(text).toContain('该计划需要先处理，然后才能批准。');
    expect(text).toContain('计划决定后才能处理');
    expect(screen.getByRole('link', { name: '审阅计划' })).toBeTruthy();
  });
});

describe('StatusPicker — held targets', () => {
  const statuses: WorkflowStatusDto[] = [
    ['in_review', 'In Review', 'in_progress'],
    ['in_progress', 'In Progress', 'in_progress'],
    ['approved', 'Approved', 'in_progress'],
    ['done', 'Done', 'done'],
  ].map(([key, label, category], i) => ({
    id: `s${i}`,
    projectId: 'p',
    key: key!,
    label: label!,
    category: category as WorkflowStatusDto['category'],
    color: null,
    position: `a${i}`,
    isInitial: i === 0,
  }));

  it('locks a held option — tagged, announced unavailable, and not pickable — and leaves the others pickable', () => {
    const onChange = vi.fn();
    render(
      <StatusPicker
        statuses={statuses}
        transitions={[]}
        policyMode="open"
        value="in_review"
        onChange={onChange}
        held={[
          { statusKey: 'approved', waitingOn: 'decision' },
          { statusKey: 'done', waitingOn: 'merge' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));

    const approved = screen.getByRole('option', { name: /Approved/ });
    const done = screen.getByRole('option', { name: /Done/ });
    expect(approved.getAttribute('aria-disabled')).toBe('true');
    expect(approved.textContent).toContain('needs approval');
    expect(done.textContent).toContain('moves on merge');

    fireEvent.click(done);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: /In Progress/ }));
    expect(onChange).toHaveBeenCalledWith('in_progress');
  });

  it('a plan hold tags a locked option *held by plan* (MOTIR-6267)', () => {
    const onChange = vi.fn();
    render(
      <StatusPicker
        statuses={statuses}
        transitions={[]}
        policyMode="open"
        value="in_review"
        onChange={onChange}
        held={statuses
          .filter((s) => s.key !== 'in_review')
          .map((s) => ({ statusKey: s.key, waitingOn: 'plan' as const }))}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    for (const name of [/In Progress/, /Approved/, /Done/]) {
      const option = screen.getByRole('option', { name });
      expect(option.getAttribute('aria-disabled')).toBe('true');
      expect(option.textContent).toContain('held by plan');
      fireEvent.click(option);
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
