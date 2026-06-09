// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import { SprintPointsBadge } from '@/components/issues/SprintPointsBadge';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// Roll-up displays (Story 4.3 · Subtask 4.3.5) — the two BOUNDED roll-ups
// `estimationService` computes (4.3.3) rendered: the sprint committed-points
// figure (filling/upgrading the Story-4.2 backlog sprint-header seam to the full
// committed · done · left the design draws) and the epic/parent subtree roll-up
// badge (issue-detail header + tree parent row). Both bind to the roll-up DTO —
// NEVER a client sum of loaded rows (finding #57): the sprint badge is
// PRESENTATIONAL over the `SprintPointsDto` the shared `useSprintPoints` hook
// reads, and the parent badge reads `{ total }` from a server-computed
// `initialTotal` or `GET /api/work-items/[id]/rollup`. Rendered with the real
// `en` catalog + a controllable EstimationConfigProvider (the configured
// statistic).

const STORY_POINTS_CONFIG: EstimationConfigDto = {
  estimationStatistic: 'story_points',
  pointScale: 'fibonacci',
  customScaleValues: [],
};

function withConfig(ui: ReactElement, config: EstimationConfigDto = STORY_POINTS_CONFIG) {
  return renderWithIntl(
    <EstimationConfigProvider config={config} canEdit={false}>
      {ui}
    </EstimationConfigProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;
function stubFetch(body: unknown, ok = true) {
  fetchSpy = vi.fn().mockResolvedValue({ ok, json: async () => body });
  vi.stubGlobal('fetch', fetchSpy);
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('SprintPointsBadge — sprint committed-points roll-up', () => {
  it('renders committed · done · left for an active sprint, from the roll-up DTO', () => {
    // Presentational: handed the bounded roll-up DTO (no client sum of rows).
    withConfig(
      <SprintPointsBadge points={{ committed: 28, completed: 13, remaining: 15 }} state="active" />,
    );

    expect(screen.getByLabelText('Points: 28 committed, 13 completed, 15 remaining')).toBeTruthy();
    expect(screen.getByText('28')).toBeTruthy();
    expect(screen.getByText('13')).toBeTruthy();
    expect(screen.getByText('15')).toBeTruthy();
  });

  it('renders committed only for a planned sprint (no work done yet)', () => {
    withConfig(
      <SprintPointsBadge points={{ committed: 13, completed: 0, remaining: 13 }} state="planned" />,
    );

    expect(screen.getByLabelText('Points: 13 committed')).toBeTruthy();
    // The done / left segments are NOT shown for a planned sprint.
    expect(screen.queryByText('done')).toBeNull();
    expect(screen.queryByText('left')).toBeNull();
  });

  it('renders a muted em-dash (never NaN) for a wholly unestimated sprint', () => {
    withConfig(
      <SprintPointsBadge points={{ committed: 0, completed: 0, remaining: 0 }} state="active" />,
    );

    expect(screen.getByLabelText('Sprint has no estimated points')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('renders the muted em-dash while the points read is still null (loading/failed)', () => {
    withConfig(<SprintPointsBadge points={null} state="active" />);
    expect(screen.getByLabelText('Sprint has no estimated points')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('formats the segments under the configured statistic (time → duration)', () => {
    withConfig(
      <SprintPointsBadge
        points={{ committed: 150, completed: 90, remaining: 60 }}
        state="active"
      />,
      { ...STORY_POINTS_CONFIG, estimationStatistic: 'time_estimate' },
    );
    // 150 minutes → "2h 30m" (the time statistic), not the raw "150".
    expect(screen.getByText('2h 30m')).toBeTruthy();
    expect(screen.queryByText('150')).toBeNull();
  });
});

describe('ParentRollupBadge — epic/parent subtree roll-up', () => {
  it('renders the server-computed header total without fetching (initialTotal)', () => {
    stubFetch({ total: 999 }); // would be wrong if it ever fetched
    withConfig(<ParentRollupBadge itemId="wi_1" initialTotal={34} variant="header" />);

    expect(screen.getByLabelText('Rolled-up Story points: 34')).toBeTruthy();
    expect(screen.getByText('34')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lazily fetches the compact roll-up from the DTO when no initialTotal', async () => {
    stubFetch({ total: 34 });
    withConfig(<ParentRollupBadge itemId="wi_9" variant="compact" />);

    await waitFor(() => expect(screen.getByText('34')).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/work-items/wi_9/rollup',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    // The compact form carries the "pts" unit (story-points statistic).
    expect(screen.getByText('pts')).toBeTruthy();
  });

  it('renders the muted em-dash for a subtree with no estimated descendants', () => {
    stubFetch({ total: 0 });
    withConfig(<ParentRollupBadge itemId="wi_2" initialTotal={0} variant="compact" />);

    expect(screen.getByLabelText('No estimated descendants')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('reuses the configured statistic (issue count → plain count, no "pts")', async () => {
    stubFetch({ total: 12 });
    withConfig(<ParentRollupBadge itemId="wi_3" variant="compact" />, {
      ...STORY_POINTS_CONFIG,
      estimationStatistic: 'issue_count',
    });
    await waitFor(() => expect(screen.getByText('12')).toBeTruthy());
    expect(screen.queryByText('pts')).toBeNull();
  });
});
