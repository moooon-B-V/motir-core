// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html`.
//
// ⚠️ THE CONTROL IS ASSERTED BY IDENTITY, NOT BY MARKUP — the card's own
// criterion, and the reason is the story's central claim. If this suite matched
// a header, a port and two buttons, it would pass against a row that had
// re-implemented the frame — which is a SECOND approval language wearing the
// first one's clothes, and the exact thing the registry and the frame exist
// together to prevent. So `ApprovalGateControl` is mocked at its MODULE
// SPECIFIER: the marker below renders only if this list imports that module, and
// the last test proves the ITEM PAGE resolves the same one.
//
// happy-dom + the repo's own matchers (no jest-dom here), so assertions read
// `.toBeTruthy()` / `.textContent`.

const decide = vi.hoisted(() => vi.fn());
const loadSubject = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
}));

vi.mock('@/components/approvals/ApprovalGateControl', () => ({
  ApprovalGateControl: (props: Record<string, unknown>) => (
    <div data-testid="the-shipped-frame" data-can-decide={String(props['canDecide'])}>
      <div data-testid="frame-port">{props['port'] as never}</div>
      <button
        type="button"
        onClick={() => void (props['onDecide'] as (d: string) => Promise<unknown>)('approve')}
      >
        frame-approve
      </button>
    </div>
  ),
}));

vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: unknown }) => (
    <div data-testid="design-panel">{evidence ? 'evidence-loaded' : 'no-evidence'}</div>
  ),
}));

vi.mock('../../app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction: decide,
}));

vi.mock('../../app/(authed)/workbench/approvalsActions', () => ({
  loadApprovalSubjectAction: loadSubject,
}));

const { ApprovalsList } = await import('../../app/(authed)/workbench/_components/ApprovalsList');

function designRow(over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto {
  return {
    gateId: 'gate-1',
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-1',
      key: 5147,
      identifier: 'MOTIR-5147',
      title: 'Design — the To-approve row',
      kind: 'subtask',
      type: 'design',
    },
    subject: {
      kind: 'design_result',
      designEvidenceId: 'ev-1',
      producedByKey: 'MOTIR-5147',
      commitSha: '9840d00ea1b2',
      assetCount: 3,
      noteExcerpt: 'The row is a disclosure.',
    },
    ...over,
  };
}

const PAGINATION = { total: 1, page: 1, pageSize: 25 };

beforeEach(() => {
  decide.mockReset();
  loadSubject.mockReset();
  refresh.mockReset();
  push.mockReset();
  loadSubject.mockResolvedValue({ evidence: { id: 'ev-1' }, filesKept: true });
});
afterEach(cleanup);

describe('the Approvals list — the row', () => {
  it('names the SUBJECT, the work item and how long it has waited', () => {
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );

    expect(screen.getByText('Design result')).toBeTruthy();
    expect(screen.getByText(/3 files/)).toBeTruthy();
    expect(screen.getByText(/9840d00e/)).toBeTruthy();
    expect(screen.getByText('MOTIR-5147')).toBeTruthy();
    expect(screen.getByText('Design — the To-approve row')).toBeTruthy();
  });

  it('renders rows in the order the read returned them — the read orders, the list does not re-sort', () => {
    const older = designRow({ gateId: 'gate-old', waitingSince: '2026-09-01T10:00:00.000Z' });
    const newer = designRow({ gateId: 'gate-new', waitingSince: '2026-09-10T10:00:00.000Z' });

    renderWithIntl(
      <ApprovalsList rows={[older, newer]} label="To approve" pagination={PAGINATION} />,
    );

    const rendered = screen.getAllByTestId(/^approval-row-/).map((el) => el.dataset['testid']);
    expect(rendered).toEqual(['approval-row-gate-old', 'approval-row-gate-new']);
  });

  it('links the WORK ITEM — the one affordance that leaves the queue', () => {
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );

    expect(screen.getByRole('link', { name: /MOTIR-5147/ }).getAttribute('href')).toBe(
      '/items/MOTIR-5147',
    );
  });
});

describe('the Approvals list — the DISCLOSURE', () => {
  it('renders NO frame until the row is opened', () => {
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );

    expect(screen.queryByTestId('the-shipped-frame')).toBeNull();
  });

  it('opens the row, renders THE SHIPPED CONTROL, and lazily loads the design into its port', async () => {
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]!);

    // ⚠️ THE IDENTITY ASSERTION. This marker exists only inside the mock of
    // `@/components/approvals/ApprovalGateControl`, so it renders if and only if
    // the list imported that module — never because the markup happened to match.
    expect(screen.getByTestId('the-shipped-frame')).toBeTruthy();

    // The PORT is loaded on disclosure, not with the list: a page of rows would
    // otherwise be a page of evidence reads.
    await waitFor(() => expect(loadSubject).toHaveBeenCalledWith('wi-1', 'ev-1'));
    await waitFor(() =>
      expect(screen.getByTestId('design-panel').textContent).toBe('evidence-loaded'),
    );
  });

  it('keeps ONE row open at a time — opening a second closes the first', () => {
    const a = designRow({ gateId: 'gate-a' });
    const b = designRow({ gateId: 'gate-b' });
    renderWithIntl(<ApprovalsList rows={[a, b]} label="To approve" pagination={PAGINATION} />);

    const reviews = screen.getAllByRole('button', { name: 'Review' });
    fireEvent.click(reviews[0]!);
    expect(screen.getByTestId('approval-frame-gate-a')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[1]!);
    expect(screen.queryByTestId('approval-frame-gate-a')).toBeNull();
    expect(screen.getByTestId('approval-frame-gate-b')).toBeTruthy();
  });
});

describe('the Approvals list — deciding', () => {
  it('SETTLES the row in place and refreshes the server surfaces', async () => {
    decide.mockResolvedValue({
      ok: true,
      gate: { id: 'gate-1', state: 'approved' },
    });
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'frame-approve' }));

    // The row is STILL THERE — it settles rather than vanishing under the cursor.
    await waitFor(() => expect(screen.getByText('Approved')).toBeTruthy());
    expect(screen.getByTestId('approval-row-gate-1')).toBeTruthy();
    // And the strip count + the readiness of everything this unblocked are
    // SERVER surfaces, which only a refresh reaches.
    expect(refresh).toHaveBeenCalled();
  });

  it('hands a REFUSAL back to the frame rather than swallowing it', async () => {
    const refusal = { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ana' };
    decide.mockResolvedValue({ ok: false, refusal });
    renderWithIntl(
      <ApprovalsList rows={[designRow()]} label="To approve" pagination={PAGINATION} />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'frame-approve' }));

    // The frame draws its own refusal IN PLACE; the list neither renders one nor
    // removes the row, and it does NOT refresh — the reader's decision did not land.
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(screen.getByTestId('approval-row-gate-1')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the Approvals list — rows with no subject to show', () => {
  it('says a kind is NOT BUILT YET, names it, and offers no disclosure', () => {
    const row = designRow({
      gateId: 'gate-merge',
      kind: 'pull_request_merge',
      subject: { kind: 'pull_request_merge' },
    });
    renderWithIntl(<ApprovalsList rows={[row]} label="To approve" pagination={PAGINATION} />);

    expect(screen.getByText('Pull-request merge')).toBeTruthy();
    expect(screen.getByText('Not built yet')).toBeTruthy();
    expect(screen.getByText('Motir cannot show this kind yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('says the SUBJECT IS GONE — a different row from not-built-yet', () => {
    const row = designRow({ gateId: 'gate-gone', subject: null });
    renderWithIntl(<ApprovalsList rows={[row]} label="To approve" pagination={PAGINATION} />);

    expect(screen.getByText('The design this asked about is gone')).toBeTruthy();
    // Still a `design_result` — the kind IS built; the row it points at is not there.
    expect(screen.getByText('Design result')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });
});

describe('the Approvals list — the pager', () => {
  it('navigates within the approvals tab, never to another one', () => {
    renderWithIntl(
      <ApprovalsList
        rows={[designRow()]}
        label="To approve"
        pagination={{ total: 60, page: 1, pageSize: 25 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));

    expect(push).toHaveBeenCalledWith('/workbench?tab=approvals&page=2');
  });
});

describe('the Approvals list — SEE but not DECIDE', () => {
  it("renders the row's state and NO decide control, and still opens", () => {
    renderWithIntl(
      <ApprovalsList
        rows={[designRow({ canDecide: false })]}
        label="To approve"
        pagination={PAGINATION}
      />,
    );

    // No Review button — the decision is withheld.
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.getByText('Awaiting')).toBeTruthy();

    // ...but the LOOK is not: the row still discloses, and the frame is handed
    // `canDecide: false` so it draws its own state `B`.
    fireEvent.click(screen.getByRole('button', { name: /Review MOTIR-5147/ }));
    expect(screen.getByTestId('the-shipped-frame').dataset['canDecide']).toBe('false');
  });
});
