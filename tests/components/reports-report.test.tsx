// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { CreatedVsResolvedDto, DistributionDto } from '@/lib/dto/reports';

// The report-page bodies (Story 6.3 · Subtask 6.3.6) under happy-dom — the
// control↔URL wiring the card's AC calls for: every control NAVIGATES (config
// round-trips through the URL), and the per-viewer/degraded states render rather
// than crash. View state lives in the URL, so the controls just call
// router.push with the canonical href; we stub next/navigation and assert it.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/created-vs-resolved',
}));

import { CreatedVsResolvedReport } from '@/app/(authed)/reports/_components/CreatedVsResolvedReport';
import { DistributionReport } from '@/app/(authed)/reports/_components/DistributionReport';

// Combobox (Radix popover) needs a few browser APIs happy-dom lacks.
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

beforeEach(() => push.mockClear());
afterEach(cleanup);

function cvr(buckets: CreatedVsResolvedDto['buckets'], cumulative = false): CreatedVsResolvedDto {
  return {
    period: 'day',
    daysBack: 30,
    cumulative,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-02-01T00:00:00.000Z',
    buckets,
  };
}

const SAMPLE = cvr([
  { date: '2026-01-05', created: 8, resolved: 5 },
  { date: '2026-01-12', created: 4, resolved: 9 },
  { date: '2026-01-19', created: 6, resolved: 6 },
]);

function renderCvr(props: Partial<Parameters<typeof CreatedVsResolvedReport>[0]> = {}) {
  return render(
    <CreatedVsResolvedReport
      result={{ state: 'ok', data: SAMPLE }}
      period="day"
      daysBack={30}
      cumulative={false}
      savedFilterId={null}
      projectName="Motir"
      savedFilters={[]}
      {...props}
    />,
  );
}

describe('CreatedVsResolvedReport — control↔URL wiring', () => {
  it('renders the chart with the per-period totals in the legend + a data table', () => {
    renderCvr();
    // createdTotal = 8+4+6 = 18, resolvedTotal = 5+9+6 = 20.
    expect(screen.getByText('Created · 18 total')).toBeTruthy();
    expect(screen.getByText('Resolved · 20 total')).toBeTruthy();
    expect(screen.getByText('Backlog growing')).toBeTruthy();
    expect(screen.getByText('Catching up')).toBeTruthy();
  });

  it('navigates on a period change (and keeps the window valid)', () => {
    renderCvr();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved?period=month');
  });

  it('steps the days-back window through the ladder', () => {
    renderCvr();
    fireEvent.click(screen.getByRole('button', { name: 'Longer window' }));
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved?daysBack=60');
  });

  it('toggles cumulative', () => {
    renderCvr();
    fireEvent.click(screen.getByRole('button', { name: 'Cumulative' }));
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved?cumulative=true');
  });

  it('renders the no-access state, not the chart', () => {
    renderCvr({ result: { state: 'no_access' } });
    expect(screen.getByText('No access')).toBeTruthy();
    expect(screen.queryByText(/total/)).toBeNull();
  });

  it('renders the stale-filter state with a reset-to-project action', () => {
    renderCvr({ result: { state: 'stale', reason: 'filter_missing' }, savedFilterId: 'f1' });
    expect(screen.getByText('Filter missing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use project scope' }));
    // resetting drops the saved-filter scope → the bare path.
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved');
  });

  it('renders the empty state for an all-zero window', () => {
    renderCvr({
      result: { state: 'ok', data: cvr([{ date: '2026-01-05', created: 0, resolved: 0 }]) },
    });
    expect(screen.getByText('No data in this window')).toBeTruthy();
  });
});

function dist(over: Partial<DistributionDto>): DistributionDto {
  return { statistic: 'status', total: 0, segments: [], ...over };
}

function renderDist(props: Partial<Parameters<typeof DistributionReport>[0]> = {}) {
  return render(
    <DistributionReport
      result={{
        state: 'ok',
        data: dist({
          total: 12,
          segments: [
            { id: 'todo', label: 'To Do', count: 8, percentage: 66.7 },
            { id: null, label: null, count: 4, percentage: 33.3 },
          ],
        }),
      }}
      statistic="status"
      statisticLabel="Status"
      statisticOptions={[
        { value: 'status', label: 'Status', group: 'Fields' },
        { value: 'assignee', label: 'Assignee', group: 'Fields' },
      ]}
      savedFilterId={null}
      projectName="Motir"
      savedFilters={[]}
      {...props}
    />,
  );
}

describe('DistributionReport — donut + label resolution', () => {
  it('renders the donut total + the segment labels, with None for the null group', () => {
    renderDist();
    expect(screen.getByText('12')).toBeTruthy(); // centre-hole total
    expect(screen.getAllByText('To Do').length).toBeGreaterThan(0);
    expect(screen.getAllByText('None').length).toBeGreaterThan(0);
  });

  it('translates self-describing enum statistics (kind → issue-type names)', () => {
    renderDist({
      statistic: 'kind',
      statisticLabel: 'Type',
      result: {
        state: 'ok',
        data: dist({
          statistic: 'kind',
          total: 5,
          segments: [{ id: 'task', label: null, count: 5, percentage: 100 }],
        }),
      },
    });
    // labelForSegment falls to labels.issueType.task = "Task".
    expect(screen.getAllByText('Task').length).toBeGreaterThan(0);
  });

  it('renders the empty state when the scope has zero issues', () => {
    renderDist({ result: { state: 'ok', data: dist({ total: 0, segments: [] }) } });
    expect(screen.getByText('No data in this window')).toBeTruthy();
  });

  it('renders the no-access state', () => {
    renderDist({ result: { state: 'no_access' } });
    expect(screen.getByText('No access')).toBeTruthy();
  });
});
