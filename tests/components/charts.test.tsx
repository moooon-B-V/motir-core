// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BarChart, LineChart, chartColor } from '@/components/ui/charts';

// Chart primitives (Subtask 4.6.2) — the reusable token-aware SVG viz layer.
// These are PURE presentational components: typed data props in, SVG out, no
// fetching. The tests assert (a) each series renders, (b) the a11y contract
// (role="img" + a <desc> summary + a visible text legend + a data-table
// fallback conveying every series as text+number — finding #35), and (c) that
// no charting library was pulled into the bundle.

afterEach(cleanup);

const BURNDOWN = {
  x: {
    domain: [0, 10] as [number, number],
    title: 'Sprint day',
    ticks: Array.from({ length: 11 }, (_, d) => ({ value: d, label: String(d) })),
  },
  y: {
    domain: [0, 42] as [number, number],
    title: 'Points remaining',
    ticks: [0, 10, 20, 30, 40].map((v) => ({ value: v, label: String(v) })),
  },
  series: [
    {
      id: 'guideline',
      label: 'Guideline',
      color: chartColor.guideline,
      dashed: true,
      points: [
        { x: 0, y: 42 },
        { x: 10, y: 0 },
      ],
    },
    {
      id: 'actual',
      label: 'Remaining',
      color: chartColor.actual,
      interpolation: 'step' as const,
      markers: 'endpoint' as const,
      points: [
        { x: 0, y: 42 },
        { x: 2, y: 35 },
        { x: 3, y: 39 },
        { x: 10, y: 13 },
      ],
    },
  ],
};

function renderBurndown() {
  return render(
    <LineChart
      x={BURNDOWN.x}
      y={BURNDOWN.y}
      series={BURNDOWN.series}
      description="Burndown for Sprint 6: guideline 42 to 0; actual remaining ends at 13."
      ariaLabel="Sprint 6 burndown"
      annotations={[{ x: 3, y: 39, color: chartColor.scope, shape: 'diamond', label: '+4 scope' }]}
      referenceLines={[
        { orientation: 'vertical', value: 4, color: chartColor.average, label: 'today' },
      ]}
    />,
  );
}

describe('LineChart (burndown primitive)', () => {
  it('renders a labelled role="img" SVG with a <desc> summary', () => {
    renderBurndown();
    const img = screen.getByRole('img', { name: 'Sprint 6 burndown' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    const descId = img.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = img.querySelector('desc');
    expect(desc?.id).toBe(descId);
    expect(desc?.textContent).toContain('guideline 42 to 0');
  });

  it('draws a path per series (step actual + straight guideline)', () => {
    const { container } = renderBurndown();
    const strokedPaths = Array.from(container.querySelectorAll('path[stroke]')).filter(
      (p) => p.getAttribute('stroke') !== 'none',
    );
    // one guideline + one actual line (area paths use fill, not stroke)
    expect(strokedPaths.length).toBeGreaterThanOrEqual(2);
    // the guideline is dashed; the actual is solid
    expect(strokedPaths.some((p) => p.getAttribute('stroke-dasharray'))).toBe(true);
  });

  it('shows a visible text legend naming every series (finding #35)', () => {
    const { container } = renderBurndown();
    // the legend is a <ul>; the series read as text, not colour alone
    const legend = container.querySelector('ul');
    expect(legend).toBeTruthy();
    const legendScope = within(legend as HTMLElement);
    expect(legendScope.getByText('Guideline')).toBeTruthy();
    expect(legendScope.getByText('Remaining')).toBeTruthy();
  });

  it('ships a data-table fallback conveying each series as text+number', () => {
    const { container } = renderBurndown();
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    const scope = within(table as HTMLElement);
    // column headers = the x-title + each series label
    expect(scope.getByText('Sprint day')).toBeTruthy();
    // row headers (x values) + numeric cells present
    expect(scope.getAllByRole('rowheader').length).toBeGreaterThan(0);
    // the end value 13 appears as a number in the table
    expect(scope.getAllByText('13').length).toBeGreaterThan(0);
  });
});

describe('BarChart (velocity primitive)', () => {
  function renderVelocity() {
    return render(
      <BarChart
        series={[
          { label: 'Committed', color: chartColor.committed },
          { label: 'Completed', color: chartColor.completed },
        ]}
        groups={[
          { label: 'S23', values: [30, 25] },
          { label: 'S24', values: [42, 29] },
        ]}
        yTicks={[0, 15, 30, 45].map((v) => ({ value: v, label: String(v) }))}
        yTitle="Story points"
        xTitle="Completed sprint"
        description="Velocity: S23 30/25, S24 42/29. Average completed 27."
        ariaLabel="Velocity chart"
        referenceLine={{
          value: 27,
          color: chartColor.average,
          label: 'avg 27',
          legendLabel: 'Average completed',
        }}
      />,
    );
  }

  it('renders a bar per series per group with value labels', () => {
    const { container } = renderVelocity();
    // 2 groups × 2 series = 4 bars (filter by the --el-chart fill so the
    // lucide table-icon's rounded rect in the data-table summary isn't counted)
    const bars = Array.from(container.querySelectorAll('rect')).filter((r) =>
      (r.getAttribute('fill') ?? '').includes('--el-chart'),
    );
    expect(bars.length).toBe(4);
    // value labels read as text
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getAllByText('29').length).toBeGreaterThan(0);
  });

  it('distinguishes the committed/completed pair by TEXT legend, not colour alone', () => {
    const { container } = renderVelocity();
    const legend = container.querySelector('ul');
    const legendScope = within(legend as HTMLElement);
    expect(legendScope.getByText('Committed')).toBeTruthy();
    expect(legendScope.getByText('Completed')).toBeTruthy();
    expect(legendScope.getByText('Average completed')).toBeTruthy();
  });

  it('draws the average reference line', () => {
    const { container } = renderVelocity();
    const dashed = Array.from(container.querySelectorAll('line[stroke-dasharray]'));
    expect(dashed.length).toBeGreaterThan(0);
    expect(screen.getByText('avg 27')).toBeTruthy();
  });

  it('ships a data-table fallback with the committed/completed numbers', () => {
    const { container } = renderVelocity();
    const table = container.querySelector('table');
    const scope = within(table as HTMLElement);
    expect(scope.getByText('Committed')).toBeTruthy();
    expect(scope.getByText('Completed')).toBeTruthy();
    expect(scope.getAllByText('30').length).toBeGreaterThan(0);
  });
});

describe('no charting library is bundled', () => {
  it('package.json declares no recharts / chart.js / nivo / d3 / victory', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const charting = Object.keys(deps).filter((k) =>
      /recharts|chart\.?js|chartjs|nivo|victory|^d3/.test(k),
    );
    expect(charting).toEqual([]);
  });
});
