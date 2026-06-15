// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The board filter UI (Story 6.15 · Subtask 6.15.3) under happy-dom. It REUSES
// the /issues filter components verbatim — the value this suite adds over
// issue-filter-bar.test.tsx is the BOARD wiring: the injected board-scoped
// buildHref (every facet toggle preserves `?board=`, never drops it), the
// over-cap "Refine filter" → open-the-filter context path, and the
// filtered-empty / over-cap CTA states. We stub next/navigation and assert URLs
// + behaviour, the same shape the issue-filter-bar suite uses.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
}));

import { BoardFilterControls } from '@/app/(authed)/boards/_components/BoardFilterControls';
import {
  BoardFilterUiProvider,
  useBoardFilterUi,
} from '@/app/(authed)/boards/_components/BoardFilterUiContext';
import { OverCapBanner } from '@/app/(authed)/boards/_components/OverCapBanner';
import { BoardFilteredEmptyState } from '@/app/(authed)/boards/_components/BoardFilteredEmptyState';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  push.mockReset();
  cleanup();
});

const STATUSES: WorkflowStatusDto[] = [
  {
    id: 's1',
    projectId: 'p',
    key: 'todo',
    label: 'To Do',
    category: 'todo',
    color: null,
    position: 'a',
    isInitial: true,
  },
  {
    id: 's2',
    projectId: 'p',
    key: 'in_progress',
    label: 'In Progress',
    category: 'in_progress',
    color: null,
    position: 'b',
    isInitial: false,
  },
];

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u-alice', name: 'Alice Chen', email: 'alice@acme.test', role: 'owner' },
];

const VIEWER: Viewer = { userId: 'u-alice', canBrowse: true, canShare: true, isAdmin: false };

function renderControls(opts: { boardId?: string; filter?: IssueFilter; withUi?: boolean } = {}) {
  const controls = (
    <BoardFilterControls
      selectedBoardId={opts.boardId}
      filter={opts.filter ?? EMPTY_FILTER}
      ast={null}
      statuses={STATUSES}
      members={MEMBERS}
      sprints={[]}
      customFields={[]}
      components={[]}
      referencedLabels={[]}
      projectKey="BRD"
      viewer={VIEWER}
    />
  );
  const tree = opts.withUi ? <BoardFilterUiProvider>{controls}</BoardFilterUiProvider> : controls;
  return renderWithIntl(<ToastProvider>{tree}</ToastProvider>);
}

describe('BoardFilterControls — reuses the /issues primitives on the board toolbar', () => {
  it('renders the Filter, Advanced and Saved triggers (the builder + saved picker)', () => {
    renderControls();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Saved filters/i })).toBeTruthy();
  });

  it('toggling a kind facet pushes a board-scoped href, PRESERVING ?board=', () => {
    renderControls({ boardId: 'brd_1' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    // The board-scoped buildHref kept the selection (a plain buildIssueListHref
    // would have dropped it and emitted just `?kind=bug`).
    expect(push).toHaveBeenCalledWith('/boards?board=brd_1&kind=bug');
  });

  it('toggling a status facet with NO board selected still composes /boards?status=', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    expect(push).toHaveBeenCalledWith('/boards?status=in_progress');
  });
});

// The over-cap banner's "Refine filter" CTA opens the board filter through the
// BoardFilterUiContext (the CTA used to point at a dead seam). A probe stands in
// for BoardContainer's wiring: it sets `filterOpen`, exactly as the CTA does.
function OpenFilterProbe() {
  const ui = useBoardFilterUi();
  return (
    <button type="button" onClick={() => ui?.setFilterOpen(true)}>
      probe-open
    </button>
  );
}

describe('BoardFilterUiContext — the over-cap "Refine" path opens the quick filter', () => {
  it('setting filterOpen via the context opens the Filter popover', () => {
    renderWithIntl(
      <ToastProvider>
        <BoardFilterUiProvider>
          <BoardFilterControls
            filter={EMPTY_FILTER}
            ast={null}
            statuses={STATUSES}
            members={MEMBERS}
            sprints={[]}
            customFields={[]}
            components={[]}
            referencedLabels={[]}
            projectKey="BRD"
            viewer={VIEWER}
          />
          <OpenFilterProbe />
        </BoardFilterUiProvider>
      </ToastProvider>,
    );
    // Closed initially — the popover's facet listboxes are not mounted.
    expect(screen.queryByRole('listbox', { name: 'Kind' })).toBeNull();
    fireEvent.click(screen.getByText('probe-open'));
    // The context flip opened the quick-filter popover (its Kind facet is now in
    // the tree) — exactly what the over-cap "Refine filter" CTA triggers.
    expect(screen.getByRole('listbox', { name: 'Kind' })).toBeTruthy();
  });
});

describe('OverCapBanner — the CTA opens the filter (was a dead seam)', () => {
  it('calls onRefine and is enabled when wired', () => {
    const onRefine = vi.fn();
    renderWithIntl(<OverCapBanner cap={500} onRefine={onRefine} />);
    const btn = screen.getByTestId('board-overcap-filter') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onRefine).toHaveBeenCalledTimes(1);
  });

  it('falls back to the disabled seam when no onRefine is wired', () => {
    renderWithIntl(<OverCapBanner cap={500} />);
    const btn = screen.getByTestId('board-overcap-filter') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('BoardFilteredEmptyState — distinct "no match" state with a Clear CTA', () => {
  it('renders the filtered-empty copy + a board-scoped Clear link', () => {
    renderWithIntl(<BoardFilteredEmptyState selectedBoardId="brd_1" />);
    expect(screen.getByText('No work items match this filter')).toBeTruthy();
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    // Clears to the board with no filter, preserving the selection.
    expect(clear.getAttribute('href')).toBe('/boards?board=brd_1');
  });

  it('clears to the bare /boards when no board is selected', () => {
    renderWithIntl(<BoardFilteredEmptyState />);
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    expect(clear.getAttribute('href')).toBe('/boards');
  });
});
