// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  CycleGraphChart,
  cycleCutoffIndex,
} from '@/app/(authed)/backlog/_components/CycleGraphChart';
import type { CycleGraphDto } from '@/lib/dto/reports';

// Story 8.14 · Subtask 8.14.5 — the sprint CYCLE GRAPH chart. Pure presentational
// (typed `CycleGraphDto` in, SVG out — no fetching). Asserts the four series
// render, the a11y contract (role="img" + a <desc> + a visible text legend + a
// data-table fallback conveying every series — finding #35), the scope-creep
// chip, the compact variant, and the degraded/empty states. Rendered against the
// real English catalog via renderWithIntl.

afterEach(cleanup);

function cycle(over: Partial<CycleGraphDto> = {}): CycleGraphDto {
  return {
    sprintId: 'sp1',
    state: 'active',
    statistic: 'story_points',
    committedAtStart: 42,
    scopeCreepPct: 4 / 42, // ≈ 0.0952 → "10%"
    startDate: '2026-06-01T00:00:00.000Z',
    endDate: '2026-06-05T00:00:00.000Z',
    days: [
      { date: '2026-06-01', scope: 42, completed: 0, started: 6, target: 42 },
      { date: '2026-06-02', scope: 42, completed: 10, started: 18, target: 37.33 },
      { date: '2026-06-03', scope: 46, completed: 14, started: 22, target: 32.67 },
      { date: '2026-06-04', scope: 46, completed: 29, started: 38, target: 28 },
      { date: '2026-06-05', scope: null, completed: null, started: null, target: 23.33 },
    ],
    ...over,
  };
}

describe('cycleCutoffIndex', () => {
  it('is the last day with a drawn scope value', () => {
    expect(cycleCutoffIndex(cycle().days)).toBe(3); // Jun 5 is null (future)
  });
  it('is -1 for a fully-undrawn series', () => {
    expect(
      cycleCutoffIndex([{ date: 'x', scope: null, completed: null, started: null, target: 0 }]),
    ).toBe(-1);
  });
});

describe('CycleGraphChart — full', () => {
  it('renders the four series in a role="img" figure with a <desc> summary', () => {
    render(<CycleGraphChart cycle={cycle()} variant="full" />);
    const fig = screen.getByRole('img');
    expect(fig).toBeTruthy();
    // The four series legend labels (visible text — colour is never the sole signal).
    expect(screen.getAllByText('Scope').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Started').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Target').length).toBeGreaterThan(0);
    // The <desc> conveys the on/behind-pace read as text+number.
    const desc = fig.querySelector('desc');
    expect(desc?.textContent).toMatch(/completed/i);
  });

  it('shows the scope-creep chip (rounded percent)', () => {
    render(<CycleGraphChart cycle={cycle()} variant="full" />);
    expect(screen.getByText(/10% scope creep/i)).toBeTruthy();
  });

  it('renders the data-table fallback with every series as a column', () => {
    render(<CycleGraphChart cycle={cycle()} variant="full" />);
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Scope', 'Completed', 'Started', 'Target']));
  });

  it('marks the issue-count fallback on the Y axis when degraded', () => {
    render(<CycleGraphChart cycle={cycle({ statistic: 'issue_count' })} variant="full" />);
    expect(screen.getAllByText('Issues').length).toBeGreaterThan(0);
  });
});

describe('CycleGraphChart — states', () => {
  it('hides the visible legend in the compact variant but keeps the figure + chip', () => {
    render(<CycleGraphChart cycle={cycle()} variant="compact" />);
    expect(screen.getByRole('img')).toBeTruthy();
    // The scope-creep chip stays on the compact variant.
    expect(screen.getByText(/10% scope creep/i)).toBeTruthy();
  });

  // MOTIR-1329 — the scrum-header burndown slot is a fixed `w-[300px]` card, but
  // the compact chart's data-table (`<table className="w-full">`, 5 columns)
  // sizes to its min-content and used to overflow the card / push horizontal
  // scroll. The containment is structural: the data table is wrapped in an
  // `overflow-x-auto` block (so a wide/long-sprint or wide-locale table scrolls
  // INSIDE the card), and the compact chart root carries `min-w-0` (so it can
  // shrink within the slot instead of forcing overflow). These assertions lock
  // the fix so a later edit can't silently reintroduce the overflow.
  it('contains the compact data table: overflow-x-auto wrapper + min-w-0 root', () => {
    const { container } = render(<CycleGraphChart cycle={cycle()} variant="compact" />);

    // The data table scrolls inside its own block rather than overflowing.
    const table = screen.getByRole('table');
    const wrapper = table.parentElement;
    expect(wrapper?.className).toMatch(/\boverflow-x-auto\b/);
    expect(wrapper?.className).toMatch(/\bmin-w-0\b/);

    // The compact chart root can shrink within the fixed-width slot.
    const root = container.firstElementChild;
    expect(root?.className).toMatch(/\bmin-w-0\b/);
  });

  it('keeps the full variant unconstrained (no min-w-0 on the report root)', () => {
    // The full report card bounds the width itself, so the chart root stays at
    // its natural width — the compact-only `min-w-0` must not leak into `full`.
    const { container } = render(<CycleGraphChart cycle={cycle()} variant="full" />);
    const root = container.firstElementChild;
    expect(root?.className).not.toMatch(/\bmin-w-0\b/);
  });

  it('shows the empty-sprint note when there is no scope', () => {
    const empty = cycle({
      committedAtStart: 0,
      scopeCreepPct: 0,
      statistic: 'issue_count',
      days: [
        { date: '2026-06-01', scope: 0, completed: 0, started: 0, target: 0 },
        { date: '2026-06-02', scope: 0, completed: 0, started: 0, target: 0 },
      ],
    });
    render(<CycleGraphChart cycle={empty} variant="full" />);
    expect(screen.getByText(/no scope in this sprint yet/i)).toBeTruthy();
  });
});
