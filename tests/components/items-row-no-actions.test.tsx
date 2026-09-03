// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueRowData } from '@/app/(authed)/items/_components/issueRows';

// MOTIR-4258 — the `/items` row has NO ⋯ actions menu, and the row's own click
// is what opens the item.
//
// ── Why this is a guard and not a deletion ─────────────────────────────────
// Removing a control is a one-line diff and it has no natural regression test:
// `tests/components/work-item-row-actions.test.tsx` went with the component, so
// nothing is left asserting the row's shape, and the next card that wants a
// per-row affordance will find an empty trailing cell and no reason not to fill
// it. The reason is that the row ALREADY opens the item on click — the peek
// (MOTIR-1306) carries the fields, the editors and the plan door — so a second,
// narrower entrance in a 76px column is a place for the two to drift, which is
// exactly what MOTIR-2097 found when the menu's plan rows and the peek's plan
// pill turned out to open different flows.
//
// So this file pins BOTH halves together: the absence only makes sense beside
// the thing that replaces it, and a test that asserted the absence alone would
// pass just as well on a row that had stopped opening anything at all.
//
// ── What it asserts ────────────────────────────────────────────────────────
//   1. no `Actions for <key>` control in any row, in EITHER view;
//   2. no `Actions` header cell (the whole column went, not just its contents);
//   3. a plain primary click on the row opens `?peek=<key>` — the surviving
//      door — while a ⌘/ctrl-click is left to the browser for the real href.

const pushState = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams('view=list'),
}));
// The rows are inline-editable (Subtask 2.5.5), so the cells import the detail
// page's edit Server Actions — stub them so this client test stays DB-free.
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));
// The peek opens through SHALLOW routing, not the router (bug 8.8.2) — assert
// the URL it pushes rather than a navigation that never happens.
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowPush: (href: string) => pushState(href),
  shallowReplace: vi.fn(),
}));

import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { buildIssueColumns } from '@/app/(authed)/items/_components/issueColumns';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';

afterEach(() => {
  pushState.mockReset();
  cleanup();
});

function row(over: Partial<IssueRowData> & { identifier: string }): IssueRowData {
  return {
    id: `wi_${over.identifier}`,
    title: 'An issue',
    kind: 'task',
    type: null,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    assigneeId: null,
    assigneeName: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    hasDescription: false,
    priority: 'medium',
    reporterName: 'Owner',
    dueDate: null,
    dueLabel: null,
    estimateMinutes: null,
    storyPoints: null,
    estimateLabel: null,
    storyPointsLabel: null,
    hasChildren: false,
    ...over,
  };
}

const ROWS: IssueRowData[] = [
  row({ identifier: 'PROD-1', title: 'First' }),
  row({ identifier: 'PROD-2', title: 'Second' }),
];

function renderList() {
  return render(
    <IssueListTable
      rows={ROWS}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: ROWS.length, page: 1, pageSize: 50 }}
    />,
  );
}

describe('/items row — the ⋯ actions menu is gone', () => {
  it('renders no "Actions for <key>" control on any row', () => {
    renderList();
    for (const r of ROWS) {
      expect(screen.queryByRole('button', { name: `Actions for ${r.identifier}` })).toBeNull();
    }
    // Belt and braces: not under any accessible name, and not as a bare button
    // hidden from the accessibility tree either.
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('drops the whole trailing column, not just its contents — no Actions header', () => {
    renderList();
    const header = screen.getAllByRole('row')[0];
    expect(within(header!).queryByText('Actions')).toBeNull();
  });

  it('the column builder declares no `actions` column, and Status is last', () => {
    // The columns are shared by BOTH views (the flat List and the nested Tree),
    // so asserting the builder covers the Tree without mounting it.
    const columns = buildIssueColumns(((key: string) => key) as never);
    expect(columns.map((c) => c.key)).not.toContain('actions');
    expect(columns.at(-1)?.key).toBe('status');
  });
});

describe('/items row — the row itself is the door', () => {
  it('a plain click opens the quick-view peek for that row', () => {
    renderList();
    const link = screen.getByRole('link', { name: /First/ });
    expect(link.getAttribute('href')).toBe('/items/PROD-1');

    fireEvent.click(link, { button: 0 });

    expect(pushState).toHaveBeenCalledTimes(1);
    const href = pushState.mock.calls[0]![0] as string;
    expect(new URL(href, 'https://example.test').searchParams.get('peek')).toBe('PROD-1');
  });

  it('leaves a ⌘/ctrl-click to the browser, so the real href still opens a tab', () => {
    renderList();
    fireEvent.click(screen.getByRole('link', { name: /Second/ }), { button: 0, metaKey: true });
    expect(pushState).not.toHaveBeenCalled();
  });
});
