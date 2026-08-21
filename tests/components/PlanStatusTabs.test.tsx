// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ push: vi.fn(), search: { value: '' } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams(mocks.search.value),
}));

import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanStatusTabs } from '@/app/(authed)/plans/_components/PlanStatusTabs';
import { PLAN_STATUS_PARAM, planStatusFromParam } from '@/lib/planning/planStatusFilter';

// MOTIR-3241 / MOTIR-3242 — the Plans list's STATUS TAB STRIP, built to
// `design/ai-planning/design-notes.md` Part VII §4.
//
// The page-level wiring (which read each tab makes, which empty state it picks)
// is `tests/planning/plansTabbedList.test.tsx`. What is pinned HERE is the strip
// itself: its a11y contract, the URL it writes, and the counts rule the measured
// widths decided.

const COUNTS = { generating: 2, planned: 3, approved: 9, declined: 0 };

beforeEach(() => {
  mocks.push.mockReset();
  mocks.search.value = '';
});
afterEach(cleanup);

const tab = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

describe('the strip’s a11y contract (MOTIR-3241)', () => {
  it('is a LABELLED group of four real buttons, each announcing its pressed state', () => {
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    const group = screen.getByRole('group', { name: 'Filter plans by status' });
    expect(within(group).getAllByRole('button')).toHaveLength(4);
    expect(tab('Planned').getAttribute('aria-pressed')).toBe('true');
    for (const other of ['Generating', 'Approved', 'Declined']) {
      expect(tab(other).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('is deliberately NOT an ARIA tablist', () => {
    // The rows below are a server-rendered list behind a URL-addressable FILTER,
    // not a tabpanel swapped client-side — `aria-pressed` describes a filter
    // honestly where `aria-selected` would promise a relationship the DOM does
    // not have. It is also the grammar the board group-by and the Children
    // List/Graph switcher already use.
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('one tab per member of the vocabulary, in lifecycle order', () => {
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    const labels = within(screen.getByRole('group', { name: 'Filter plans by status' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels[0]).toContain('Generating');
    expect(labels[1]).toContain('Planned');
    expect(labels[2]).toContain('Approved');
    expect(labels[3]).toContain('Declined');
  });
});

describe('the COUNTS (Part VII §4)', () => {
  it('renders one per tab, and a ZERO is rendered rather than hidden', () => {
    // A tab that silently loses its number reads as a loading state, and the
    // zero is a fact worth telling a reader before they press.
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    expect(within(tab('Declined')).getByText('0')).toBeTruthy();
    expect(within(tab('Approved')).getByText('9')).toBeTruthy();
  });

  it('the count is hidden below `sm` — the MEASURED disposition', () => {
    // Part VII §4 measured the strip at 310.3px with labels alone and 358.8px
    // with counts, against the 343px content box a 375px viewport leaves after
    // the shell's `px-4`. The labels fit; the counts overflow by 15.8px. Dropping
    // them costs a number the tab's own result set supplies the moment it is
    // pressed — a scroller would instead push `Declined` off-screen.
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    expect(within(tab('Approved')).getByText('9').className).toContain('hidden sm:inline');
  });
});

describe('the URL is the single source of truth (MOTIR-3241)', () => {
  it('choosing a non-default tab PUSHES `?status=`', () => {
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    fireEvent.click(tab('Approved'));

    expect(mocks.push).toHaveBeenCalledWith('/plans?status=approved', { scroll: false });
  });

  it('choosing the DEFAULT writes a CLEAN url with no parameter', () => {
    // `?status=planned` and `/plans` must not be two addresses for one view, and
    // every existing link to `/plans` stays byte-identical.
    mocks.search.value = 'status=approved';
    renderWithIntl(<PlanStatusTabs value="approved" counts={COUNTS} />);

    fireEvent.click(tab('Planned'));

    expect(mocks.push).toHaveBeenCalledWith('/plans', { scroll: false });
  });

  it('keeps any OTHER query parameter it finds', () => {
    mocks.search.value = 'q=payouts';
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    fireEvent.click(tab('Declined'));

    expect(mocks.push).toHaveBeenCalledWith('/plans?q=payouts&status=declined', { scroll: false });
  });

  it('never scrolls the reader to the top', () => {
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    fireEvent.click(tab('Approved'));

    expect(mocks.push.mock.calls[0]![1]).toEqual({ scroll: false });
  });

  it('pressing the tab already in view pushes nothing', () => {
    // `Segmented` short-circuits an unchanged selection; asserting it here keeps
    // a redundant navigation out of the history stack.
    renderWithIntl(<PlanStatusTabs value="planned" counts={COUNTS} />);

    fireEvent.click(tab('Planned'));

    expect(mocks.push).not.toHaveBeenCalled();
  });
});

// ⚠️ IMPORTED FROM `lib/planning/planStatusFilter`, NOT from the component
// (MOTIR-3243). They were declared in the `'use client'` component until the
// story's E2E found `/plans` 500ing on every request — a Server Component cannot
// CALL an export it reached through a client boundary, however pure the function
// is. Keeping the test's import pointed at the pure module is what makes a
// regression to the old shape a compile error here rather than a 500 in a browser.
describe('planStatusFromParam', () => {
  it('takes each member and falls back to `planned` for anything else', () => {
    for (const value of ['generating', 'planned', 'approved', 'declined'] as const) {
      expect(planStatusFromParam(value)).toBe(value);
    }
    for (const raw of [undefined, null, '', 'nonsense', 'PLANNED', 'planned ']) {
      expect(planStatusFromParam(raw)).toBe('planned');
    }
  });

  it('names its parameter `status`', () => {
    expect(PLAN_STATUS_PARAM).toBe('status');
  });
});
