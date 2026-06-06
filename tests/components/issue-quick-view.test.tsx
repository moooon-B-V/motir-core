// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/app/(authed)/issues/_components/IssueQuickViewPanel';

// The /issues QUICK-VIEW peek (Subtask 2.5.19) under happy-dom — the client
// pieces of the card's "trigger sets ?peek + the modal renders the item + Open
// full page href is /issues/[key] + close clears the param" AC. The peek is
// URL-driven, so the trigger and the close affordances just NAVIGATE; we stub
// next/navigation (no real router under happy-dom) and assert the pushed URLs.
// The populated panel is presentational (data in), so it renders directly. The
// open→peek→Open-full-page flow end-to-end + the open-modal a11y sweep are the
// Story E2E's job (2.5.6).

const push = vi.fn();
let searchParamsString = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

import { QuickViewTrigger } from '@/app/(authed)/issues/_components/QuickViewTrigger';
import { QuickViewCloseButton } from '@/app/(authed)/issues/_components/QuickViewCloseButton';
import { IssueQuickViewPanel } from '@/app/(authed)/issues/_components/IssueQuickViewPanel';

afterEach(() => {
  push.mockReset();
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
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  dueLabel: 'Jun 12, 2026',
  estimateLabel: '8h',
  parent: { identifier: 'PROD-1', title: 'Q3 launch', kind: 'epic' },
  readiness: null,
};

describe('QuickViewTrigger — opens the peek via ?peek', () => {
  it('sets ?peek=<key>, preserving the current view/sort params', () => {
    searchParamsString = 'view=list&sort=key:asc';
    render(<QuickViewTrigger identifier="PROD-7" title="Email + password sign-in" />);
    fireEvent.click(screen.getByRole('button', { name: /Quick view PROD-7/ }));
    expect(push).toHaveBeenCalledWith('/issues?view=list&sort=key%3Aasc&peek=PROD-7', {
      scroll: false,
    });
  });

  it('adds ?peek to a bare /issues URL', () => {
    render(<QuickViewTrigger identifier="PROD-7" title="X" />);
    fireEvent.click(screen.getByRole('button', { name: /Quick view PROD-7/ }));
    expect(push).toHaveBeenCalledWith('/issues?peek=PROD-7', { scroll: false });
  });
});

describe('IssueQuickViewPanel — populated (ready)', () => {
  it('renders the item title + status + assignee', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByText('Email + password sign-in')).toBeTruthy();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('Marco Ortiz')).toBeTruthy();
  });

  it('"Open full page" + the header identifier both link to /issues/[key]', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe('/issues/PROD-7');
    expect(screen.getByRole('link', { name: 'PROD-7' }).getAttribute('href')).toBe(
      '/issues/PROD-7',
    );
  });
});

describe('IssueQuickViewPanel — readiness banner (Subtask 2.5.21)', () => {
  it('blocked: renders the Blocked banner naming open blockers as ?peek= swap-peek links', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, readiness: { ready: false, blockers: ['PROD-3', 'PROD-8'] } }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText(/Waiting on 2 work items/)).toBeTruthy();
    // A blocker link SWAPS the peek (preserves view, swaps peek), staying in-list.
    expect(screen.getByRole('link', { name: 'PROD-3' }).getAttribute('href')).toBe(
      '/issues?view=list&peek=PROD-3',
    );
    expect(screen.getByRole('link', { name: 'PROD-8' }).getAttribute('href')).toBe(
      '/issues?view=list&peek=PROD-8',
    );
  });

  it('ready: renders "Ready to start" when the item has blockers that are all resolved', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, readiness: { ready: true, blockers: [] } }}
      />,
    );
    expect(screen.getByText('Ready to start')).toBeTruthy();
    expect(screen.getByText('All blockers resolved')).toBeTruthy();
  });

  it('no blockers: renders NO readiness banner (readiness === null)', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, readiness: null }} />);
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText('Ready to start')).toBeNull();
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
    expect(push).toHaveBeenCalledWith('/issues?view=list', { scroll: false });
  });

  it('navigates to the clean /issues when peek was the only param', () => {
    searchParamsString = 'peek=PROD-7';
    render(<QuickViewCloseButton variant="button" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(push).toHaveBeenCalledWith('/issues', { scroll: false });
  });
});
