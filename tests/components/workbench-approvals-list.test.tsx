// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type { ApprovalQueueRowDto, DesignResultSubjectSummaryDTO } from '@/lib/dto/approvalGate';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), RE-SCOPED by
// Subtask MOTIR-5225 (Story MOTIR-5214): the row no longer discloses a frame, it
// OPENS THE APPROVAL OVERLAY (`design/workbench/design-notes.md` § 22 Panel 9).
//
// What this file holds in place:
//
//   · the row is a REAL link to the card, and only a plain primary click is
//     turned into the overlay's address — every other click keeps its native
//     meaning (`usePeekRowClick`'s contract);
//   · the address is written OVER this page, with `shallowPush`, keeping the
//     tab's own query — so closing returns to exactly this page of the list;
//   · every row has the door, and the decision is withheld where it must be,
//     never the look;
//   · a gate decided in the overlay SETTLES its row in place, through the signal
//     a `router.refresh()` cannot deliver to a client island.
//
// happy-dom + the repo's own matchers (no jest-dom here), so assertions read
// `.toBeTruthy()` / `.textContent`.

const { push, refresh, shallowPush } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
}));
let params = new URLSearchParams('tab=approvals&page=2');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));

vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

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
      noteExcerpt: 'The row opens the overlay.',
    },
    ...over,
  };
}

const PAGINATION = { total: 1, page: 1, pageSize: 25 };
const OPENED = '/workbench?tab=approvals&page=2&approval=MOTIR-5147&approvalKind=design_result';

function renderRows(rows: ApprovalQueueRowDto[]) {
  return renderWithIntl(<ApprovalsList rows={rows} label="To approve" pagination={PAGINATION} />);
}

/** The whole-row door — named for the row, so it never reads as a second "Review". */
function rowDoor(key = 'MOTIR-5147') {
  return screen.getByRole('link', { name: new RegExp(`^Review ${key} `) });
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  params = new URLSearchParams('tab=approvals&page=2');
});
afterEach(cleanup);

describe('the Approvals list — the row', () => {
  it('names the SUBJECT, the work item and how long it has waited', () => {
    renderRows([designRow()]);

    expect(screen.getByText('Design result')).toBeTruthy();
    expect(screen.getByText(/3 files/)).toBeTruthy();
    expect(screen.getByText(/9840d00e/)).toBeTruthy();
    expect(screen.getByText('MOTIR-5147')).toBeTruthy();
    expect(screen.getByText('Design — the To-approve row')).toBeTruthy();
  });

  it('renders rows in the order the read returned them — the read orders, the list does not re-sort', () => {
    const older = designRow({ gateId: 'gate-old', waitingSince: '2026-09-01T10:00:00.000Z' });
    const newer = designRow({ gateId: 'gate-new', waitingSince: '2026-09-10T10:00:00.000Z' });

    renderRows([older, newer]);

    const rendered = screen.getAllByTestId(/^approval-row-/).map((el) => el.dataset['testid']);
    expect(rendered).toEqual(['approval-row-gate-old', 'approval-row-gate-new']);
  });

  it('reads a short wait in HOURS and a long one in DAYS', () => {
    renderRows([
      designRow({
        gateId: 'gate-hours',
        waitingSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      }),
      designRow({ gateId: 'gate-days' }),
    ]);

    const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
    expect(screen.getByText(fmt.format(-3, 'hour'))).toBeTruthy();
    expect(screen.getByText(fmt.format(-4, 'day'))).toBeTruthy();
  });

  it('says NO VERSION for a design published without a commit', () => {
    const subject = { ...designRow().subject, commitSha: null } as DesignResultSubjectSummaryDTO;
    renderRows([designRow({ subject })]);

    expect(screen.getByText(/no version/)).toBeTruthy();
  });

  it('links the WORK ITEM — the one affordance that visibly leaves the queue', () => {
    renderRows([designRow()]);

    expect(screen.getByRole('link', { name: /^MOTIR-5147/ }).getAttribute('href')).toBe(
      '/items/MOTIR-5147',
    );
  });
});

describe('the Approvals list — the row OPENS THE APPROVAL OVERLAY', () => {
  it('is a real link to the card, announced as opening a dialog — and no longer a disclosure', () => {
    const { container } = renderRows([designRow()]);

    const door = rowDoor();
    expect(door.getAttribute('href')).toBe('/items/MOTIR-5147');
    expect(door.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('a plain primary click writes the overlay address OVER this page, keeping its query', () => {
    renderRows([designRow()]);

    const proceeded = fireEvent.click(rowDoor(), { button: 0 });

    expect(proceeded).toBe(false); // the navigation to the card was intercepted
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
    // A shallow write: nothing asked the server for the page again.
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['⌘', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('a %s-click is left to the browser — the card, in a new tab', (_label, modifier) => {
    renderRows([designRow()]);

    const proceeded = fireEvent.click(rowDoor(), { button: 0, ...modifier });

    expect(proceeded).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a non-primary click is left to the browser too', () => {
    renderRows([designRow()]);

    // Dispatched straight at the handler's condition: a middle click arrives as
    // `auxclick` in a real browser and never reaches `onClick` at all.
    const proceeded = fireEvent.click(rowDoor(), { button: 1 });

    expect(proceeded).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('the Review button is the labelled door, to the same address', () => {
    renderRows([designRow()]);

    const review = screen.getByRole('button', { name: 'Review' });
    expect(review.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(review);

    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });

  it('renders NO frame in the list, opened or not — the overlay is where a gate is decided', () => {
    renderRows([designRow()]);

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getAllByTestId(/^approval-row-/)).toHaveLength(1);
  });

  it('keeps a host page with no query of its own clean', () => {
    params = new URLSearchParams();
    renderRows([designRow()]);

    fireEvent.click(rowDoor());

    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?approval=MOTIR-5147&approvalKind=design_result',
    );
  });
});

describe('the Approvals list — rows with no subject to show', () => {
  it('says a kind is NOT BUILT YET, offers nothing to decide, and still opens — on its own kind', () => {
    const row = designRow({
      gateId: 'gate-approval',
      // Still a declared hole (MOTIR-4907); both pull-request kinds are registered.
      kind: 'decision_approval',
      subject: { kind: 'decision_approval' },
    });
    renderRows([row]);

    expect(screen.getByText('Decision approval')).toBeTruthy();
    expect(screen.getByText('Not built yet')).toBeTruthy();
    expect(screen.getByText('Motir cannot show this kind yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();

    // The overlay draws this arm (§ 22 Panel 4a), so the row has the door.
    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=approvals&page=2&approval=MOTIR-5147&approvalKind=decision_approval',
    );
  });

  it('names the pull request for a MERGE gate — a registered kind with a real subject (MOTIR-4793)', () => {
    const row = designRow({
      gateId: 'gate-merge',
      kind: 'pull_request_merge',
      subject: {
        kind: 'pull_request_merge',
        pullRequestId: 'pr-1',
        repo: 'acme/web',
        number: 7,
        title: 'The merge seam',
        headSha: 'abc123',
      },
    });
    renderRows([row]);

    expect(screen.getByText('Pull-request merge')).toBeTruthy();
    expect(screen.getByText('acme/web#7 · pull request')).toBeTruthy();
    expect(screen.queryByText('Motir cannot show this kind yet')).toBeNull();
  });

  it('says the SUBJECT IS GONE — a different row from not-built-yet — and still opens', () => {
    const row = designRow({ gateId: 'gate-gone', subject: null });
    renderRows([row]);

    expect(screen.getByText('The design this asked about is gone')).toBeTruthy();
    // Still a `design_result` — the kind IS built; the row it points at is not there.
    expect(screen.getByText('Design result')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();

    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });
});

describe('the Approvals list — SEE but not DECIDE', () => {
  it("renders the row's state and NO decide control, and the row still opens", () => {
    renderRows([designRow({ canDecide: false })]);

    // No Review button — the decision is withheld.
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.getByText('Awaiting')).toBeTruthy();

    // …but the LOOK is not: the overlay draws the frame's state `B`.
    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });
});

describe('the Approvals list — a gate decided in the OVERLAY settles its row', () => {
  // The store outlives a render, as it does in the product, so each case decides
  // a gate no other case uses.

  it('swaps the Decide cell for the state pill, in place — the row neither vanishes nor moves', () => {
    const decided = designRow({ gateId: 'gate-settle-a' });
    const other = designRow({
      gateId: 'gate-settle-b',
      workItem: { ...designRow().workItem, id: 'wi-2', identifier: 'MOTIR-9', title: 'Other' },
    });
    renderRows([decided, other]);
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);

    act(() => announceGateDecided('gate-settle-a', 'approved'));

    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    const rows = screen.getAllByTestId(/^approval-row-/).map((el) => el.dataset['testid']);
    expect(rows).toEqual(['approval-row-gate-settle-a', 'approval-row-gate-settle-b']);
    // Its verb is gone; the OTHER row's is untouched.
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1);
    // A settled row keeps its door — the overlay draws the decided record.
    expect(rowDoor().getAttribute('href')).toBe('/items/MOTIR-5147');
  });

  it('draws Changes requested for a gate sent back', () => {
    renderRows([designRow({ gateId: 'gate-settle-c' })]);

    act(() => announceGateDecided('gate-settle-c', 'changes_requested'));

    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('draws a WITHDRAWN question colourless — `superseded` is the product’s write, not a person’s', () => {
    renderRows([designRow({ gateId: 'gate-settle-f' })]);

    act(() => announceGateDecided('gate-settle-f', 'superseded'));

    expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('ignores `awaiting` — it is not a decision', () => {
    renderRows([designRow({ gateId: 'gate-settle-d' })]);

    act(() => announceGateDecided('gate-settle-d', 'awaiting'));

    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('settles a row that mounts AFTER the decision, too', () => {
    act(() => announceGateDecided('gate-settle-e', 'approved'));

    renderRows([designRow({ gateId: 'gate-settle-e' })]);

    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
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
