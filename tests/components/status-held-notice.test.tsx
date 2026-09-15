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

import { StatusHeldNotice, type StatusHeldLine } from '@/components/issues/StatusHeldNotice';
import { StatusPicker } from '@/components/issues/StatusPicker';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

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
});
