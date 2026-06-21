// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The backlog filter UI (Story 8.8 · Subtask 8.8.18) under happy-dom. It REUSES
// the /items filter components verbatim — exactly as the board did (6.15.3) —
// so the value this suite adds is the BACKLOG wiring: the formerly-disabled
// `[Filter]` seam is now an ENABLED trigger, and the injected backlog-scoped
// buildHref makes every facet toggle navigate to `/backlog?…` (NO `?board=`, no
// view/sort). We stub next/navigation and assert the pushed URLs, the same shape
// the board-filter suite uses.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/backlog',
}));

import { BacklogFilterControls } from '@/app/(authed)/backlog/_components/BacklogFilterControls';
import { BacklogFilteredEmptyState } from '@/app/(authed)/backlog/_components/BacklogFilteredEmptyState';

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

function renderControls(opts: { filter?: IssueFilter } = {}) {
  return renderWithIntl(
    <ToastProvider>
      <BacklogFilterControls
        filter={opts.filter ?? EMPTY_FILTER}
        ast={null}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={[]}
        customFields={[]}
        components={[]}
        referencedLabels={[]}
        projectKey="BKL"
        viewer={VIEWER}
      />
    </ToastProvider>,
  );
}

describe('BacklogFilterControls — the wired seam reuses the /items primitives', () => {
  it('renders the ENABLED Filter, Advanced and Saved triggers (the seam is wired)', () => {
    renderControls();
    const filter = screen.getByRole('button', { name: 'Filter' }) as HTMLButtonElement;
    // The formerly-disabled seam is now an enabled trigger (8.8.18).
    expect(filter.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Saved filters/i })).toBeTruthy();
  });

  it('toggling a kind facet pushes a BACKLOG-scoped href (/backlog?kind=bug)', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    // The backlog-scoped buildHref navigates to /backlog (NOT /items, NOT a
    // board href) — there is no view/sort/board companion.
    expect(push).toHaveBeenCalledWith('/backlog?kind=bug');
  });

  it('toggling a status facet composes /backlog?status=', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    expect(push).toHaveBeenCalledWith('/backlog?status=in_progress');
  });
});

describe('BacklogFilteredEmptyState — distinct "no match" state with a Clear CTA', () => {
  it('renders the filtered-empty copy + a backlog Clear link', () => {
    renderWithIntl(<BacklogFilteredEmptyState />);
    expect(screen.getByText('No work items match this filter')).toBeTruthy();
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    // Clears to the bare /backlog (no filter) — the backlog has no selection axis.
    expect(clear.getAttribute('href')).toBe('/backlog');
  });
});
