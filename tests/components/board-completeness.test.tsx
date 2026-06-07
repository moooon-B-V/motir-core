// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Board completeness (Subtask 3.2.6) — the empty-board state, the
// unmapped-statuses tray (present/absent), and the mobile pager. Like the
// 3.2.2/3.2.4 board tests this drives the real BoardContainer under happy-dom
// (DB-free): stub next/navigation (the usePeekOpen push) + global fetch, wrap in
// ToastProvider (the dnd-kit container reads it). The empty-state CTA reuses the
// shipped NewIssueButton → useCreateIssue, so stub that context to a live
// project rather than mounting the whole CreateIssueProvider + modal.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
  useSearchParams: () => new URLSearchParams(),
}));

const { openCreateIssue } = vi.hoisted(() => ({ openCreateIssue: vi.fn() }));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ open: false, setOpen: vi.fn(), openCreateIssue, canCreate: true }),
}));

import { BoardContainer } from '@/app/(authed)/boards/_components/BoardContainer';
import type { BoardColumnDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

function column(over: Partial<BoardColumnDto> & { id: string; name: string }): BoardColumnDto {
  return {
    position: 'a0',
    wipLimit: null,
    statusKeys: ['todo'],
    cards: [],
    totalCount: 0,
    cursor: null,
    ...over,
  };
}

function status(
  over: Partial<WorkflowStatusDto> & { id: string; label: string },
): WorkflowStatusDto {
  return {
    projectId: 'p1',
    key: over.id,
    category: 'todo',
    color: null,
    position: 'a0',
    isInitial: false,
    ...over,
  };
}

function projection(over: Partial<BoardProjectionDto> = {}): BoardProjectionDto {
  return {
    boardId: 'b1',
    name: 'Default',
    type: 'kanban',
    unmappedStatuses: [],
    columns: [column({ id: 'c1', name: 'To Do' }), column({ id: 'c2', name: 'In Progress' })],
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function mockFetchOk(data: BoardProjectionDto) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe('board completeness (3.2.6)', () => {
  it('shows the empty-board state (not blank columns) when every column is empty', async () => {
    // All columns totalCount 0, no unmapped statuses → the board empty state.
    vi.stubGlobal('fetch', mockFetchOk(projection()));
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByText('No work items yet')).toBeTruthy());
    // The column row is NOT rendered — the empty state replaces it.
    expect(screen.queryByTestId('board')).toBeNull();
    // The CTA reuses the shipped create flow (NewIssueButton → openCreateIssue).
    const cta = screen.getByRole('button', { name: 'New work item' });
    fireEvent.click(cta);
    expect(openCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('keeps the columns (not the empty state) when work items are hidden in unmapped statuses', async () => {
    // Every column is empty BUT a status is unmapped — work items may be hidden,
    // so the board must NOT claim "no work items" (the rung-2 guard).
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ unmappedStatuses: [status({ id: 's-hold', label: 'On Hold' })] })),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByText('No work items yet')).toBeNull();
    expect(screen.getByTestId('board-unmapped-tray')).toBeTruthy();
  });

  it('renders the unmapped-statuses tray with the status names + a map-columns link', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })],
          unmappedStatuses: [
            status({ id: 's-triage', label: 'Needs Triage' }),
            status({ id: 's-hold', label: 'On Hold' }),
          ],
        }),
      ),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board-unmapped-tray')).toBeTruthy());
    expect(screen.getByText('Needs Triage')).toBeTruthy();
    expect(screen.getByText('On Hold')).toBeTruthy();
    const link = screen.getByTestId('board-unmapped-link');
    expect(link.getAttribute('href')).toBe('/settings/project/workflow');
  });

  it('omits the unmapped tray when every status is mapped', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })] })),
    );
    render(<BoardContainer />);

    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('board-unmapped-tray')).toBeNull();
  });

  it('renders the mobile column pager (decorative) with the active column position', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(projection({ columns: [column({ id: 'c1', name: 'To Do', totalCount: 1 })] })),
    );
    render(<BoardContainer />);

    // A single column → nothing to page through, so the pager is absent.
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy());
    expect(screen.queryByTestId('board-pager')).toBeNull();
  });

  it('shows the pager (with a dot per column) when there is more than one column', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOk(
        projection({
          columns: [
            column({ id: 'c1', name: 'To Do', totalCount: 1 }),
            column({ id: 'c2', name: 'In Progress', totalCount: 1 }),
            column({ id: 'c3', name: 'Done', totalCount: 1 }),
          ],
        }),
      ),
    );
    render(<BoardContainer />);

    const pager = await screen.findByTestId('board-pager');
    // The position label defaults to the first column before any scroll.
    expect(pager.textContent).toContain('To Do · 1 of 3');
  });
});
