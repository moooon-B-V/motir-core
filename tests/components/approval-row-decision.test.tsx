// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type {
  ApprovalQueueRowDto,
  DecisionApprovalSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE TO-APPROVE TAB'S DECISION ROW (Story MOTIR-4907 · Subtask MOTIR-5679;
// `design/workbench/design-notes.md` § 27, Panels 7a–7d and 8b). The row is drawn from
// the capture's summary with no host call, so its title is the FILE NAME's (Panel 7b).

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
let params = new URLSearchParams('tab=approvals');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { ApprovalsList } = await import('../../app/(authed)/workbench/_components/ApprovalsList');

const ds = en.workbench.approvals.decisionSubject;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const ONE: DecisionApprovalSubjectSummaryDTO = {
  kind: 'decision_approval',
  outcome: 'one',
  repo: 'moooon/motir-core',
  number: 214,
  path: 'docs/decisions/page-body.md',
  title: 'Page body',
  blobSha: '3f9a2c1000000000000000000000000000000000',
  documentCount: 1,
};

function decisionRow(
  subject: DecisionApprovalSubjectSummaryDTO = ONE,
  over: Partial<ApprovalQueueRowDto> = {},
): ApprovalQueueRowDto {
  return {
    gateId: 'gate-dec-1',
    kind: 'decision_approval',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    workItem: {
      id: 'wi-18',
      key: 18,
      identifier: 'ACME-18',
      title: 'Decide how a page stores its body',
      kind: 'subtask',
      type: 'decision',
    },
    subject,
    ...over,
  };
}

function renderRows(rows: ApprovalQueueRowDto[]) {
  return renderWithIntl(
    <ApprovalsList
      rows={rows}
      label="To approve"
      pagination={{ total: rows.length, page: 1, pageSize: 25 }}
      empty={<p>Nothing</p>}
    />,
  );
}

beforeEach(() => {
  shallowPush.mockReset();
  params = new URLSearchParams('tab=approvals');
});
afterEach(cleanup);

describe('the decision row (Panel 7a/7b)', () => {
  it('names the document — its file-name title and path — under the kind Decision', () => {
    renderRows([decisionRow()]);
    expect(screen.getByText(en.workbench.approvals.rowKind.decision_approval)).toBeTruthy();
    const subject = screen.getByText('Page body · docs/decisions/page-body.md');
    // The cell's title carries the path and the blob.
    expect(subject.getAttribute('title')).toBe(
      fill(ds.title, { path: 'docs/decisions/page-body.md', blob: '3f9a2c1' }),
    );
    expect(screen.getByText('ACME-18')).toBeTruthy();
  });

  it('is a LIVE row — no "Not built yet", and a Review door', () => {
    renderRows([decisionRow()]);
    expect(screen.queryByText(en.workbench.approvals.notBuiltYet)).toBeNull();
    expect(screen.getByRole('button', { name: en.workbench.approvals.review })).toBeTruthy();
  });

  it('opens the overlay at the DECISION gate’s address (Panel 8b)', () => {
    renderRows([decisionRow()]);
    fireEvent.click(screen.getByRole('button', { name: en.workbench.approvals.review }));
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=approvals&approval=ACME-18&approvalKind=decision_approval',
    );
  });
});

describe('unresolvable decisions still list, and say why (Panel 7c)', () => {
  it.each([
    [
      { outcome: 'none' as const, documentCount: 0 },
      fill(ds.none, { pr: 'moooon/motir-core · #214' }),
    ],
    [
      { outcome: 'several' as const, documentCount: 2 },
      fill(ds.several, { count: 2, pr: 'moooon/motir-core · #214' }),
    ],
    [
      { outcome: 'unreadable' as const, documentCount: 0 },
      fill(ds.unreadable, { pr: 'moooon/motir-core · #214' }),
    ],
  ])('%o → its own line, and the door still opens', (over, line) => {
    renderRows([decisionRow({ ...ONE, ...over, path: null, title: null, blobSha: null })]);
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText(en.workbench.approvals.notBuiltYet)).toBeNull();
    expect(screen.getByRole('button', { name: en.workbench.approvals.review })).toBeTruthy();
  });
});
