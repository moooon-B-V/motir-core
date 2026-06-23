// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

// The /items QUICK-VIEW peek (Subtask 2.5.19) under happy-dom — the client
// pieces of the card's "trigger sets ?peek + the modal renders the item + Open
// full page href is /items/[key] + close clears the param" AC. The peek is
// URL-driven, so the trigger and the close affordances just NAVIGATE; we stub
// next/navigation (no real router under happy-dom) and assert the pushed URLs.
// The populated panel is presentational (data in), so it renders directly. The
// open→peek→Open-full-page flow end-to-end + the open-modal a11y sweep are the
// Story E2E's job (2.5.6).

const push = vi.fn();
let searchParamsString = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

import { QuickViewCloseButton } from '@/app/(authed)/items/_components/QuickViewCloseButton';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

// Opening / closing the peek updates the URL via SHALLOW routing (bug 8.8.2) —
// `window.history.pushState`, NOT `router.push` — so it's a pure URL change that
// never re-renders the host server page (no underlying-list refetch). So the
// trigger/close assert against a pushState spy, not the router mock.
const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

afterEach(() => {
  push.mockReset();
  historyPush.mockClear();
  searchParamsString = '';
  cleanup();
});

const DATA: QuickViewData = {
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  kind: 'story',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'Sign in with email and password.',
  type: null,
  executor: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: 'Jun 12, 2026',
  sprintName: null,
  storyPoints: null,
  estimateLabel: '8h',
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: { identifier: 'PROD-1', title: 'Q3 launch', kind: 'epic' },
  readiness: null,
};

// The /items row peek-on-click (the per-row eye `QuickViewTrigger` was removed
// in MOTIR-1306 — a plain row click now opens the peek). The shared
// plain-click→peek guard (`usePeekRowClick`) is exercised through
// `RelationshipPeekLink` in relationships-panel.test.tsx, and the row-link wiring
// (List + Tree: plain click → peek, ⌘/ctrl-click → detail page) is covered
// end-to-end by issue-list-flow.spec.ts.

describe('IssueQuickViewPanel — populated (ready)', () => {
  it('renders the item title + status + assignee', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByText('Email + password sign-in')).toBeTruthy();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('Marco Ortiz')).toBeTruthy();
  });

  it('"Open full page" + the header identifier both link to /items/[key]', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe('/items/PROD-7');
    expect(screen.getByRole('link', { name: 'PROD-7' }).getAttribute('href')).toBe('/items/PROD-7');
  });

  it('opens every detail-page link in a NEW TAB — target=_blank + rel=noopener (8.8.31)', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    // The four links that navigate to a work-item DETAIL page (`/items/<KEY>`):
    // the header identifier, "Open full page →", the description-footer "more"
    // link (all → /items/PROD-7), and the rail Parent link (→ /items/PROD-1).
    const detailLinks = screen
      .getAllByRole('link')
      .filter((a) => /^\/items\/[A-Z]/.test(a.getAttribute('href') ?? ''));
    expect(detailLinks).toHaveLength(4);
    for (const a of detailLinks) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });
});

describe('IssueQuickViewPanel — expanded field set (Subtask 8.8.8)', () => {
  // A fully-populated leaf (subtask) so the leaf-only Type/Executor rows render
  // alongside labels, components, sprint, story points, and the audit line.
  const FULL: QuickViewData = {
    ...DATA,
    identifier: 'PROD-9',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    labels: [
      { id: 'l1', name: 'auth' },
      { id: 'l2', name: 'security' },
    ],
    components: [{ id: 'c1', name: 'API' }],
    sprintName: 'Sprint 7',
    storyPoints: 5,
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    customFields: [
      {
        id: 'f1',
        key: 'team',
        label: 'Team',
        fieldType: 'text',
        description: null,
        options: [],
        value: { text: 'Platform', number: null, date: null, option: null, user: null },
      },
      {
        id: 'f2',
        key: 'tier',
        label: 'Tier',
        fieldType: 'text',
        description: null,
        options: [],
        value: null,
      },
    ],
  };

  it('renders the work type, executor, labels, components, sprint, and story points', () => {
    render(<IssueQuickViewPanel state="ready" data={FULL} />);
    expect(screen.getByText('Code')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    // Rail field titles resolve from the `issueViews` namespace (bug 8.8.x:
    // they were read via the `labels` namespace, so the raw key path showed).
    expect(screen.getByText('Labels')).toBeTruthy();
    expect(screen.getByText('Components')).toBeTruthy();
    expect(screen.getByText('auth')).toBeTruthy();
    expect(screen.getByText('security')).toBeTruthy();
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('Sprint 7')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('shows valued custom fields and hides empty ones behind "Show more fields (N)"', () => {
    render(<IssueQuickViewPanel state="ready" data={FULL} />);
    // The valued custom field is visible; the empty one is hidden until expand.
    expect(screen.getByText('Platform')).toBeTruthy();
    expect(screen.queryByText('Tier')).toBeNull();
    const more = screen.getByRole('button', { name: /Show more fields \(1\)/ });
    fireEvent.click(more);
    expect(screen.getByText('Tier')).toBeTruthy();
  });

  it('omits the leaf-only Type/Executor rows for a container kind (story)', () => {
    // The base DATA is a story (no work type) — Type/Executor must not render.
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.queryByText('Agent')).toBeNull();
  });
});

describe('IssueQuickViewPanel — readiness banner (Subtask 2.5.21)', () => {
  // The banner shows only for a TODO-category item with blockers.
  const TODO = { ...DATA, statusLabel: 'To Do', statusCategory: 'todo' as const };

  it('blocked: renders the Blocked banner naming open blockers as new-tab detail links (8.8.32)', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...TODO, readiness: { ready: false, blockers: ['PROD-3', 'PROD-8'] } }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText(/Waiting on 2 work items/)).toBeTruthy();
    // 8.8.32 (overrides the 2.5.20 peek-swap + the 8.8.31 exclusion): each blocker
    // link now points to the blocker's DETAIL page and opens in a NEW TAB, so a
    // click leaves the current peek open in the original tab.
    const b3 = screen.getByRole('link', { name: 'PROD-3' });
    expect(b3.getAttribute('href')).toBe('/items/PROD-3');
    expect(b3.getAttribute('target')).toBe('_blank');
    expect(b3.getAttribute('rel')).toContain('noopener');
    const b8 = screen.getByRole('link', { name: 'PROD-8' });
    expect(b8.getAttribute('href')).toBe('/items/PROD-8');
    expect(b8.getAttribute('target')).toBe('_blank');
    expect(b8.getAttribute('rel')).toContain('noopener');
  });

  it('ready: renders "Ready to start" when the verdict is ready (all blockers resolved, OR none — bug-ready-banner-no-deps)', () => {
    // `{ ready: true, blockers: [] }` is the payload for BOTH "every blocker is
    // terminal" and "the item has no blockers at all" — a no-dependency todo item
    // is the most ready it can be and shows the same green banner.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...TODO, readiness: { ready: true, blockers: [] } }}
      />,
    );
    expect(screen.getByText('Ready to start')).toBeTruthy();
    expect(screen.getByText('All blockers resolved')).toBeTruthy();
  });

  it('null verdict: renders NO readiness banner (no verdict carried)', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...TODO, readiness: null }} />);
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText('Ready to start')).toBeNull();
  });

  it('non-todo status: suppresses the banner even with open blockers (moot past todo)', () => {
    // Same blocked verdict as the first case, but the item is in-progress.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...DATA,
          statusCategory: 'in_progress',
          readiness: { ready: false, blockers: ['PROD-3', 'PROD-8'] },
        }}
      />,
    );
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByRole('link', { name: 'PROD-3' })).toBeNull();
  });
});

describe('IssueQuickViewPanel — not found / no access', () => {
  it('renders the unavailable state naming the key, with no "Open full page"', () => {
    render(<IssueQuickViewPanel state="notfound" peekKey="PROD-404" />);
    expect(screen.getByText('This work item isn’t available')).toBeTruthy();
    expect(screen.getByText(/PROD-404/)).toBeTruthy();
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
  });
});

describe('QuickViewCloseButton — clears ?peek', () => {
  it('drops only the peek param, preserving the rest', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(<QuickViewCloseButton variant="icon" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(historyPush).toHaveBeenCalledWith(null, '', '/items?view=list');
  });

  it('navigates to the clean /items when peek was the only param', () => {
    searchParamsString = 'peek=PROD-7';
    render(<QuickViewCloseButton variant="button" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(historyPush).toHaveBeenCalledWith(null, '', '/items');
  });
});
