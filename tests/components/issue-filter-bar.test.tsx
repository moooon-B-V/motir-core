// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';

// The /issues FILTER bar (Subtask 2.5.4) under happy-dom — the card's component
// AC: "toggling a filter updates the query + calls back; clear resets." Filters
// live in the URL, so the bar just NAVIGATES: each facet toggle calls
// router.push with the canonical buildIssueListHref, preserving the active view
// + sort. We stub next/navigation and assert the URLs.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
}));

import { IssueFilterBar } from '@/app/(authed)/issues/_components/IssueFilterBar';

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
    id: 's-blocked',
    projectId: 'p',
    key: 'blocked',
    label: 'Blocked',
    category: 'todo',
    color: null,
    position: 'a5',
    isInitial: false,
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
  {
    id: 's3',
    projectId: 'p',
    key: 'done',
    label: 'Done',
    category: 'done',
    color: null,
    position: 'c',
    isInitial: false,
  },
];

const MEMBERS: WorkspaceMemberDTO[] = [
  { userId: 'u-alice', name: 'Alice Chen', email: 'alice@acme.test', role: 'owner' },
  { userId: 'u-dana', name: 'Dana Kim', email: 'dana@acme.test', role: 'member' },
];

function renderBar(filter: IssueFilter = EMPTY_FILTER) {
  return render(
    <IssueFilterBar
      filter={filter}
      statuses={STATUSES}
      members={MEMBERS}
      view="tree"
      sort={DEFAULT_SORT}
    />,
  );
}

/** Open the popover by clicking the Filter trigger. */
function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
}

describe('IssueFilterBar — trigger', () => {
  it('shows no count badge when no filter is active', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
  });

  it('shows the active count badge = number of selected values', () => {
    renderBar({
      kinds: ['bug'],
      statuses: ['in_progress', 'done'],
      assigneeIds: [],
      includeUnassigned: true,
      text: null,
    });
    // 1 kind + 2 statuses + Unassigned = 4
    expect(screen.getByRole('button', { name: 'Filter — 4 active' })).toBeTruthy();
  });
});

describe('IssueFilterBar — facet toggles navigate (URL-driven)', () => {
  it('toggling a kind pushes ?kind=', () => {
    renderBar();
    open();
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    expect(push).toHaveBeenCalledWith('/issues?kind=bug');
  });

  it('toggling a status pushes ?status=<key>', () => {
    renderBar();
    open();
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    expect(push).toHaveBeenCalledWith('/issues?status=in_progress');
  });

  it('toggling a member pushes ?assignee=<id>', () => {
    renderBar();
    open();
    const list = screen.getByRole('listbox', { name: 'Assignee' });
    fireEvent.click(within(list).getByRole('option', { name: /Dana Kim/ }));
    expect(push).toHaveBeenCalledWith('/issues?assignee=u-dana');
  });

  it('toggling Unassigned pushes the token', () => {
    // Fresh render (not chained after the member toggle above): a second toggle
    // in the SAME render would correctly accumulate onto the first — that
    // accumulate-don't-clobber behaviour is the finding-#58 regression test
    // below. Here we assert the bare single-toggle URL.
    renderBar();
    open();
    const list = screen.getByRole('listbox', { name: 'Assignee' });
    fireEvent.click(within(list).getByRole('option', { name: 'Unassigned' }));
    expect(push).toHaveBeenCalledWith('/issues?assignee=unassigned');
  });

  it('un-checking an already-selected facet removes it from the URL', () => {
    renderBar({ ...EMPTY_FILTER, kinds: ['bug'] });
    open();
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    const bug = within(kindList).getByRole('option', { name: 'Bug' });
    expect(bug.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(bug);
    expect(push).toHaveBeenCalledWith('/issues'); // back to the unfiltered tree
  });

  it('preserves the active view + sort when a facet changes', () => {
    render(
      <IssueFilterBar
        filter={EMPTY_FILTER}
        statuses={STATUSES}
        members={MEMBERS}
        view="list"
        sort={{ column: 'priority', direction: 'desc' }}
      />,
    );
    open();
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=priority%3Adesc&kind=bug');
  });
});

describe('IssueFilterBar — clear', () => {
  it('"Clear filters" resets to the bare /issues', () => {
    renderBar({ ...EMPTY_FILTER, kinds: ['bug'], includeUnassigned: true });
    open();
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(push).toHaveBeenCalledWith('/issues');
  });

  it('Clear is disabled when nothing is selected', () => {
    renderBar();
    open();
    expect(screen.getByRole('button', { name: /Clear filters/ }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('IssueFilterBar — optimistic selection (finding #58)', () => {
  // THE core bug: selection lives in the URL, so the check mark used to render
  // straight off the server-round-tripped `filter` prop — it stayed blank from
  // the click until the navigation + issue read settled, so a clicked status
  // "didn't show" (worse / more visibly with a status that matches nothing, so
  // the read returns empty). `push` is a stub here and NEVER re-drives the
  // `filter` prop, so this asserts the check + count update from optimistic
  // state alone, with zero round-trip. Pre-fix this failed (aria-selected stayed
  // 'false'); the count badge likewise.
  it('checks the clicked status immediately, with no navigation round-trip', () => {
    renderBar();
    open();
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    const blocked = within(statusList).getByRole('option', { name: 'Blocked' });
    expect(blocked.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(blocked);

    // no rerender with a new prop — the optimistic mirror drives the UI
    expect(blocked.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Filter — 1 active' })).toBeTruthy();
    expect(push).toHaveBeenCalledWith('/issues?status=blocked');
  });

  it('reconciles to the server filter when the navigation lands', () => {
    const { rerender } = renderBar();
    open();
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'Blocked' }));

    // simulate the Server Component re-rendering with the URL-parsed filter
    rerender(
      <IssueFilterBar
        filter={{ ...EMPTY_FILTER, statuses: ['blocked'] }}
        statuses={STATUSES}
        members={MEMBERS}
        view="tree"
        sort={DEFAULT_SORT}
      />,
    );
    const blocked = within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', {
      name: 'Blocked',
    });
    expect(blocked.getAttribute('aria-selected')).toBe('true');
  });
});

describe('IssueFilterBar — rapid multi-select (finding #58 regression)', () => {
  // Selecting more than one value in a facet "quickly" means a second toggle
  // fires BEFORE the first one's router.push round-trips back as a new `filter`
  // prop. The handler must compose the second toggle onto the first's result,
  // not onto the stale render-time `filter` — otherwise the first selection is
  // silently dropped (its check mark de-syncs). Here `push` is a stub and never
  // re-drives the `filter` prop, so two synchronous clicks reproduce exactly
  // that "before the navigation settles" window: the LAST push must carry BOTH
  // status keys. Pre-fix, the second click read the empty render-time filter and
  // pushed only the second key.
  it('keeps the first status when a second is toggled before navigation settles', () => {
    renderBar();
    open();
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    fireEvent.click(within(statusList).getByRole('option', { name: 'Done' }));

    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(1, '/issues?status=in_progress');
    // both keys survive — appended in the reducer's sorted order (done, in_progress)
    expect(push).toHaveBeenLastCalledWith('/issues?status=done&status=in_progress');
  });

  it('accumulates across facets toggled back-to-back (kind then status)', () => {
    renderBar();
    open();
    fireEvent.click(
      within(screen.getByRole('listbox', { name: 'Kind' })).getByRole('option', { name: 'Bug' }),
    );
    fireEvent.click(
      within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: 'Done' }),
    );
    expect(push).toHaveBeenLastCalledWith('/issues?kind=bug&status=done');
  });
});

describe('IssueFilterBar — text quick-filter (debounced)', () => {
  it('pushes ?q= after the debounce', () => {
    vi.useFakeTimers();
    try {
      renderBar();
      open();
      fireEvent.change(screen.getByRole('textbox', { name: 'Filter by text' }), {
        target: { value: 'oauth' },
      });
      expect(push).not.toHaveBeenCalled(); // debounced, not yet
      vi.advanceTimersByTime(300);
      expect(push).toHaveBeenCalledWith('/issues?q=oauth');
    } finally {
      vi.useRealTimers();
    }
  });
});
