// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ApprovalQueueRowDto, ApprovalRecordDecidedRowDto } from '@/lib/dto/approvalGate';

// A DECISION TO CONFIRM IN THE LISTS (Story MOTIR-5871 · Subtask MOTIR-5961; design
// `design/workbench/approvals-row--decision-confirm.mock.html`). `ApprovalRow` is the ONE
// row the To-approve tab and the Approvals room share, so its `decision_confirmation`
// branch is asserted here once for both: a waiting decision names its changes, what it
// supersedes and its first line, and opens the overlay; a decided one says Confirmed —
// with or without a written record, read from the STAMP — or Overturned with the owed
// re-plan.

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

afterEach(() => {
  cleanup();
  shallowPush.mockClear();
});

const SUBJECT = {
  kind: 'decision_confirmation' as const,
  decision: 'Exports move to managed object storage.',
  changes: ['workflow' as const, 'less_requirement' as const],
  supersedesCount: 3,
};

const WORK_ITEM = {
  id: 'wi-42',
  key: 42,
  identifier: 'ACME-42',
  title: 'Exports move to a bucket',
  kind: 'task' as const,
  type: 'decision' as const,
};

const WAITING: ApprovalQueueRowDto = {
  gateId: 'gate-d',
  kind: 'decision_confirmation',
  state: 'awaiting',
  canDecide: true,
  routedToName: 'Yue',
  waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
  workItem: WORK_ITEM,
  subject: SUBJECT,
} as ApprovalQueueRowDto;

const CONFIRMED: ApprovalRecordDecidedRowDto = {
  gateId: 'gate-d',
  kind: 'decision_confirmation',
  state: 'approved',
  decidedAt: new Date().toISOString(),
  decidedByLabel: 'Yue <yue@example.com>',
  decisionSource: 'ui',
  subjectVersion: 'a'.repeat(64),
  waitingSince: new Date(Date.now() - 7_200_000).toISOString(),
  workItem: WORK_ITEM,
  subject: SUBJECT,
  chosenOption: null,
  confirmedRecord: {
    kind: 'attachment',
    attachmentId: 'att-1',
    originalFilename: 'decision.md',
    mimeType: 'text/markdown',
    sizeBytes: 100,
    createdAt: new Date().toISOString(),
  },
};

describe('a WAITING decision row', () => {
  it('shows the kind, the glyph’s label, the changes · supersedes · decision line, and opens the overlay', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: WAITING }} />);
    // The sentence *{title} is decided* (MOTIR-5999) — the agent's decision-document row
    // reads *Decision document for {title}*, so the two stay tellable apart in one list.
    expect(screen.getByText('is decided')).toBeTruthy();
    expect(
      screen.getByText(
        'workflow · less requirement · supersedes 3 · Exports move to managed object storage.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const href = shallowPush.mock.calls[0]![0] as string;
    expect(href).toContain('approval=ACME-42');
    expect(href).toContain('decision_confirmation');
  });
});

describe('a DECIDED decision row', () => {
  it('Confirmed with a written record — its own pill, never Approved', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'decided', row: CONFIRMED }} />);
    expect(screen.getByText('Confirmed with a written record · supersedes 3')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('Confirmed without a written record, read from the stamp', () => {
    renderWithIntl(
      <ApprovalRow
        record={{ section: 'decided', row: { ...CONFIRMED, confirmedRecord: { kind: 'none' } } }}
      />,
    );
    expect(screen.getByText('Confirmed without a written record · supersedes 3')).toBeTruthy();
  });

  it('Overturned names the owed re-plan and wears its own pill', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'decided',
          row: { ...CONFIRMED, state: 'overturned', confirmedRecord: null },
        }}
      />,
    );
    expect(screen.getByText('Overturned · re-plan owed for 3 work items')).toBeTruthy();
    expect(screen.getByText('Overturned')).toBeTruthy();
    expect(screen.queryByText('Changes requested')).toBeNull();
  });
});
