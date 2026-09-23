// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ApprovalQueueRowDto, ApprovalRecordDecidedRowDto } from '@/lib/dto/approvalGate';

// A CHOICE IN THE LISTS (Story MOTIR-4914 · Subtask MOTIR-5897; design
// `design/workbench/approvals-row--choice.mock.html`). `ApprovalRow` is the ONE row
// the To-approve tab and the Approvals room share, so its `decision_choice` branch
// is asserted here once for both: a waiting choice names the question and how many
// options, and opens the overlay; a decided one names what was PICKED, off the
// immutable record.

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
  kind: 'decision_choice' as const,
  optionCount: 4,
  question: 'Where do exported reports live?',
};

const WORK_ITEM = {
  id: 'wi-42',
  key: 42,
  identifier: 'ACME-42',
  title: 'Choose where exports live',
  kind: 'task' as const,
  type: 'choice' as const,
};

const WAITING: ApprovalQueueRowDto = {
  gateId: 'gate-c',
  kind: 'decision_choice',
  state: 'awaiting',
  canDecide: true,
  routedToName: 'Yue',
  waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
  workItem: WORK_ITEM,
  subject: SUBJECT,
} as ApprovalQueueRowDto;

const DECIDED: ApprovalRecordDecidedRowDto = {
  gateId: 'gate-c',
  kind: 'decision_choice',
  state: 'approved',
  decidedAt: new Date().toISOString(),
  decidedByLabel: 'Yue <yue@example.com>',
  decisionSource: 'ui',
  subjectVersion: 'a'.repeat(64),
  waitingSince: new Date(Date.now() - 7_200_000).toISOString(),
  workItem: WORK_ITEM,
  // The body has since changed — the row must not read the pick from it.
  subject: { ...SUBJECT, optionCount: 2, question: 'Something else entirely?' },
  confirmedRecord: null,
  refusalReason: null,
  chosenOption: {
    optionId: 'managed-object-storage',
    label: 'Managed object storage',
    bestFor: 'less to operate',
    followUp: 'The export story.',
    situation: 'two_workflows',
  },
};

describe('a WAITING choice row', () => {
  it('shows the kind, the option count and the question, and opens the overlay', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: WAITING }} />);
    expect(screen.getByText('Options for')).toBeTruthy(); // the sentence (MOTIR-5999)
    expect(screen.getByText('4 options · Where do exported reports live?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    const href = shallowPush.mock.calls[0]![0] as string;
    expect(href).toContain('approval=ACME-42');
    expect(href).toContain('decision_choice');
  });
});

describe('a DECIDED choice row', () => {
  it('names the chosen option and what it was best for, from the record', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'decided', row: DECIDED }} />);
    expect(screen.getByText('Managed object storage')).toBeTruthy();
    expect(screen.getByText(/· less to operate/)).toBeTruthy();
    expect(screen.queryByText(/Something else entirely/)).toBeNull();
    // Its state reads Chosen — an option was picked, nothing was approved.
    expect(screen.getByText('Chosen')).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('None of these names how many options and that none was chosen', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'decided',
          row: { ...DECIDED, state: 'changes_requested', chosenOption: null },
        }}
      />,
    );
    expect(screen.getByText('2 options · none chosen')).toBeTruthy();
    expect(screen.getByText('Changes requested')).toBeTruthy();
  });
});
