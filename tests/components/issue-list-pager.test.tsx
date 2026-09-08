// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { IssueListPager } from '@/app/(authed)/items/_components/IssueListPager';

// THE SHARED PAGER, and its TRANSLATION (Story MOTIR-4850 · MOTIR-4853).
//
// ── Why this file exists at all ─────────────────────────────────────────────
// `IssueListPager` shipped for months with `Showing`, `Page N`, `Previous
// page`, `Next page` and `Pagination` written into the component as English
// literals, and its number formatting pinned to `en-US`. Nothing was wrong with
// that while its only homes were `/items` and `/items/archived`, because
// neither forced the question. The Workbench does — it is the surface that
// ships in both languages — and the whole point of COMPOSING the shipped
// control rather than writing a second one is that the product has exactly one
// pager. So the gap was paid IN the component, which means its two existing
// consumers inherit the fix and could also be regressed by it.
//
// ── What is asserted, and what would be a weaker test ───────────────────────
// The `zh` cases assert the CHINESE strings are present, not merely that the
// English ones are absent: a control that rendered an empty label would pass
// the negative form and be useless to a reader. And the range line is asserted
// as one sentence rather than as three fragments, because the sentence's ORDER
// is the part translation changes — Chinese wraps its measure words around the
// numbers (`显示第 X–Y 项，共 N 项`), which is exactly what a JSX concatenation
// could not have expressed.

afterEach(cleanup);

const en = (over: Partial<Parameters<typeof IssueListPager>[0]> = {}) =>
  renderWithIntl(
    <IssueListPager total={1234} page={13} pageSize={50} onPage={() => {}} {...over} />,
  );

const zh = (over: Partial<Parameters<typeof IssueListPager>[0]> = {}) =>
  renderWithIntl(
    <IssueListPager total={1234} page={13} pageSize={50} onPage={() => {}} {...over} />,
    { locale: 'zh', messages: zhMessages },
  );

/** The range line's text, whitespace-collapsed — one sentence, not three nodes. */
const rangeLine = () =>
  screen
    .getByText(/Showing|显示第/)
    .textContent?.replace(/\s+/g, ' ')
    .trim();

describe('the pager renders no hardcoded English (MOTIR-4853)', () => {
  it('renders the `en` range line, chevrons, page buttons and nav from the catalogue', () => {
    en();

    expect(rangeLine()).toBe('Showing 601–650 of 1,234');
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 13' })).toBeTruthy();
  });

  it('renders the SAME control in `zh` — every string, including the accessible names', () => {
    zh();

    // The measure words sit AROUND the numbers, which is the whole reason the
    // range line is one `t.rich` message rather than JSX fragments.
    expect(rangeLine()).toBe('显示第 601–650 项，共 1,234 项');
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '上一页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '第 13 页' })).toBeTruthy();

    // ⚠️ ASSERTED POSITIVELY ABOVE **AND** NEGATIVELY HERE. The positive form
    // alone passes for a control rendering the right roles with empty labels;
    // the negative form alone passes for one rendering nothing at all. The
    // English literals this card removed must not be reachable in `zh`.
    for (const english of ['Showing', 'Previous page', 'Next page', 'Pagination']) {
      expect(screen.queryByText(english), english).toBeNull();
      expect(screen.queryByRole('button', { name: english }), english).toBeNull();
    }
  });

  it('formats its numbers in the ACTIVE locale, not `en-US`', () => {
    // The grouping separator is the only place the locale shows in a number
    // here, and a four-figure total is the only input that reveals it — which
    // is why the fixture is 1,234 rather than a round hundred.
    en({ total: 1234, page: 1, pageSize: 50 });
    expect(rangeLine()).toContain('1,234');
    cleanup();

    zh({ total: 1234, page: 1, pageSize: 50 });
    expect(rangeLine()).toContain(new Intl.NumberFormat('zh').format(1234));
  });
});

describe('the pager states `design/workbench/` draws', () => {
  it('a SINGLE-PAGE set keeps the range line and loses the page nav (Panel 9)', () => {
    en({ total: 9, page: 1, pageSize: 25 });

    expect(rangeLine()).toBe('Showing 1–9 of 9');
    // A lone `[1]` would be a control that cannot do anything; "9 of 9" still
    // answers *is this all of it?*, which is the question a bounded list raises
    // whether or not it paginates.
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });

  it('an EMPTY set reads `0–0 of 0` rather than `1–0`', () => {
    // The `total === 0` arm. The Workbench never reaches it — an empty tab
    // renders its empty state and no pager at all (`design/workbench/` Panel
    // 10) — but `/items` DOES: a filter that matches nothing still renders the
    // list frame and its footer. Without the arm the range would open at 1 and
    // end at 0, which is a sentence about no rows that counts from one.
    en({ total: 0, page: 1, pageSize: 50 });
    expect(rangeLine()).toBe('Showing 0–0 of 0');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });

  it('disables prev on the first page and next on the last', () => {
    en({ total: 1234, page: 1, pageSize: 50 });
    expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(false);
    cleanup();

    en({ total: 1234, page: 25, pageSize: 50 });
    expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
  });

  it('marks the current page with `aria-current`, not colour alone', () => {
    en({ total: 1234, page: 13, pageSize: 50 });
    const current = screen.getByRole('button', { name: 'Page 13' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Page 12' }).getAttribute('aria-current')).toBeNull();
  });

  it('raises `onPage` with the page a reader asked for', () => {
    const onPage = vi.fn();
    en({ total: 1234, page: 13, pageSize: 50, onPage });

    fireEvent.click(screen.getByRole('button', { name: 'Page 14' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(onPage.mock.calls.map(([p]) => p)).toEqual([14, 12, 14]);
  });

  it('truncates the run with an ellipsis the accessibility tree does not read', () => {
    en({ total: 1234, page: 13, pageSize: 50 });
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    // `1 … 12 [13] 14 … 25` — seven slots whatever the total, which is what
    // bounds the control's width (`design/workbench/` Panel 12's wrap note).
    expect(within(nav).getAllByRole('button').length).toBe(7);
    expect(nav.textContent).toContain('…');
  });
});
