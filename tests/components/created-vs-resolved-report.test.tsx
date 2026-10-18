// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { CreatedVsResolvedDto } from '@/lib/dto/reports';

// Created vs Resolved as bars with series switches (Story MOTIR-8919 ·
// MOTIR-8926). The controls navigate through `buildReportHref`; the body picks
// the difference-area line, a single-series line, or grouped bars.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/created-vs-resolved',
}));
vi.mock('@/app/(authed)/reports/_components/ReportScopeCombobox', () => ({
  ReportScopeCombobox: () => <div data-testid="scope" />,
}));

const { CreatedVsResolvedReport } =
  await import('@/app/(authed)/reports/_components/CreatedVsResolvedReport');

const dto = (n = 5): CreatedVsResolvedDto =>
  ({
    cumulative: false,
    buckets: Array.from({ length: n }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      created: i + 2,
      resolved: i + 1,
    })),
  }) as CreatedVsResolvedDto;

const renderIt = (over: Partial<React.ComponentProps<typeof CreatedVsResolvedReport>> = {}) =>
  render(
    <CreatedVsResolvedReport
      result={{ state: 'ok', data: dto() }}
      period="day"
      daysBack={30}
      cumulative={false}
      form="line"
      series="both"
      savedFilterId={null}
      projectName="Prodect"
      savedFilters={[]}
      {...over}
    />,
  );

beforeEach(() => push.mockClear());
afterEach(() => cleanup());

const chart = (c: HTMLElement) => c.querySelector('svg[role="img"]')!;

describe('CreatedVsResolvedReport form and series', () => {
  it('Bars draws one Created and one Resolved bar per bucket', () => {
    const { container } = renderIt({ form: 'bars' });
    const text = chart(container).textContent ?? '';
    expect(text).toContain('Created');
    expect(text).toContain('Resolved');
    expect(chart(container).querySelectorAll('rect[fill="var(--el-chart-created)"]')).toHaveLength(
      5,
    );
    expect(chart(container).querySelectorAll('rect[fill="var(--el-chart-resolved)"]')).toHaveLength(
      5,
    );
  });

  it('the default line form keeps the backlog / catching-up legend', () => {
    renderIt();
    expect(screen.getByText('Backlog growing')).toBeTruthy();
    expect(screen.getByText('Catching up')).toBeTruthy();
  });

  it('switching Created off pushes ?series=resolved', () => {
    renderIt();
    fireEvent.click(screen.getByRole('switch', { name: 'Created' }));
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved?series=resolved');
  });

  it('with Created off, Resolved is locked on with the reason visible, and Created can return', () => {
    renderIt({ series: 'resolved' });
    expect((screen.getByRole('switch', { name: 'Resolved' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('At least one series stays on.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Created' }));
    // Both on again: the series parameter is gone.
    expect(push).toHaveBeenCalledWith('/reports/created-vs-resolved');
  });

  it('line with one series draws a single line and no backlog / catching-up legend', () => {
    const { container } = renderIt({ series: 'resolved' });
    expect(screen.queryByText('Backlog growing')).toBeNull();
    expect(screen.queryByText('Catching up')).toBeNull();
    expect(
      chart(container).querySelectorAll('path[stroke="var(--el-chart-resolved)"]').length,
    ).toBeGreaterThan(0);
    expect(chart(container).querySelector('[stroke="var(--el-chart-created)"]')).toBeNull();
  });

  it('bars with one series draws only that series', () => {
    const { container } = renderIt({ form: 'bars', series: 'created' });
    expect(chart(container).querySelectorAll('rect[fill="var(--el-chart-created)"]')).toHaveLength(
      5,
    );
    expect(chart(container).querySelectorAll('rect[fill="var(--el-chart-resolved)"]')).toHaveLength(
      0,
    );
  });

  it('the data table keeps every bucket, with columns for the visible series and Net only when both are on', () => {
    const both = renderIt();
    const cols = (c: HTMLElement) =>
      within(within(c).getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
    expect(cols(both.container)).toEqual(['Day', 'Created', 'Resolved', 'Net']);
    cleanup();
    const one = renderIt({ series: 'created' });
    expect(cols(one.container)).toEqual(['Day', 'Created']);
    expect(within(one.container).getAllByRole('row')).toHaveLength(6);
  });

  it('a period change keeps the form and series in the pushed href', () => {
    renderIt({ form: 'bars', series: 'resolved' });
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    const href = push.mock.calls[0]![0] as string;
    expect(href).toContain('period=week');
    expect(href).toContain('form=bars');
    expect(href).toContain('series=resolved');
  });

  it('a daily 90-bucket bar view hands every bucket to the page chart', () => {
    const { container } = renderIt({ form: 'bars', result: { state: 'ok', data: dto(90) } });
    // Page mode gives every bucket a hover title, so none is thinned away from the hover layer.
    expect(chart(container).querySelectorAll('rect > title')).toHaveLength(90);
  });
});
