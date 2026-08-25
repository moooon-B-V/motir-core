// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { IssueColumn } from '@/app/(authed)/items/_components/issueColumns';

// The companion to issue-tree-skeleton-grid.test.tsx. That file pins the
// fallback to TODAY's nine columns; this one asks what happens on the day a
// TENTH arrives — the event that broke this file three times before (Actions,
// Points, Type), and the reason the grid is now derived rather than restated.
//
// The registry is stubbed with two extra columns the skeleton has no drawn
// shimmer for: one flexible (no `width`) and one right-aligned. A derived grid
// must grow a `max-content` track for the first, keep a cell per track in every
// row, and give the un-drawn columns a generic stand-in rather than a hole. A
// restated constant could satisfy none of that.

vi.mock('@/app/(authed)/items/_components/issueColumns', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/(authed)/items/_components/issueColumns')>();
  const spare: IssueColumn[] = [
    // No `width` — the flexible arm of the grid expression.
    { key: 'spare', header: 'Spare', sortColumn: 'key', cell: () => null },
    { key: 'spareEnd', header: 'Spare end', width: 40, align: 'end', cell: () => null },
  ];
  return {
    ...actual,
    buildIssueColumns: (t: Parameters<typeof actual.buildIssueColumns>[0]) => [
      ...actual.buildIssueColumns(t),
      ...spare,
    ],
  };
});

import { IssueTreeSkeleton } from '@/app/(authed)/items/_components/IssueTreeSkeleton';

afterEach(cleanup);

function gridRows(container: HTMLElement): HTMLElement[] {
  const root = container.querySelector<HTMLElement>('[data-testid="issue-tree-skeleton"]');
  expect(root).not.toBeNull();
  return Array.from(
    (root as HTMLElement).querySelectorAll<HTMLElement>('[style*="grid-template-columns"]'),
  );
}

describe('IssueTreeSkeleton — a column the skeleton has never seen', () => {
  it('grows a track for it, headers it, and still gives every row one cell per track', () => {
    const rows = gridRows(render(<IssueTreeSkeleton />).container);
    const tracks = rows[0]!.style.gridTemplateColumns.split(' ');

    // Eleven columns now: the nine real ones plus the two stubs. The widthless
    // one takes `max-content`, exactly as both real tables would render it.
    expect(tracks).toHaveLength(11);
    expect(tracks.slice(-2)).toEqual(['max-content', '40px']);

    const header = rows[0]!;
    expect(header.children.length).toBe(11);
    expect(header.lastElementChild?.textContent).toBe('Spare end');

    // The un-drawn columns get a generic stand-in, so no row is short a cell.
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.children.length).toBe(11);
  });
});
