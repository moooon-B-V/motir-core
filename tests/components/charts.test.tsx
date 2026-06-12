// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BarChart,
  LineChart,
  DonutChart,
  DifferenceAreaChart,
  chartColor,
} from '@/components/ui/charts';

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

// 4.6.7 — the closing Story-test pass: the primitive branches the 4.6.2 suite
// above doesn't reach (horizontal reference lines + their derived legend entry,
// per-point markers, area fills, the ariaLabel→description fallback, the
// missing-value `?? 0` guard, a solid reference line, a reference-line-less
// velocity render). Same a11y bar: every variant still carries the <desc> +
// data-table fallback (finding #35).

describe('LineChart — 4.6.7 branch pass', () => {
  it('draws a HORIZONTAL reference line with its label and a derived legend entry', () => {
    const { container } = render(
      <LineChart
        x={BURNDOWN.x}
        y={BURNDOWN.y}
        series={[{ ...BURNDOWN.series[1]!, markers: 'all' as const, area: true }]}
        description="Remaining with an average rule at 20."
        referenceLines={[
          {
            orientation: 'horizontal',
            value: 20,
            color: chartColor.average,
            dashed: true,
            label: 'avg 20',
            legendLabel: 'Average',
          },
        ]}
      />,
    );
    // the horizontal rule + its text label render
    const rules = Array.from(container.querySelectorAll('line[stroke-dasharray="6 4"]'));
    expect(rules.length).toBe(1);
    expect(screen.getByText('avg 20')).toBeTruthy();
    // the reference line's legendLabel lands in the derived legend
    const legend = container.querySelector('ul');
    expect(within(legend as HTMLElement).getByText('Average')).toBeTruthy();
    // markers: 'all' puts a dot on every finite point (4 data points)
    const dots = Array.from(container.querySelectorAll('circle[r="3.5"]'));
    expect(dots.length).toBe(4);
    // area: true fills under the line (a fill path with no stroke)
    const fills = Array.from(container.querySelectorAll('path[fill-opacity]'));
    expect(fills.length).toBe(1);
  });

  it('falls back to the description as the accessible name when no ariaLabel is given', () => {
    render(
      <LineChart
        x={BURNDOWN.x}
        y={BURNDOWN.y}
        series={BURNDOWN.series}
        description="Burndown summary sentence."
      />,
    );
    expect(screen.getByRole('img', { name: 'Burndown summary sentence.' })).toBeTruthy();
  });

  it('honors host-supplied legend + dataTable overrides (kind defaults to swatch, headerless columns allowed)', () => {
    const { container } = render(
      <LineChart
        x={BURNDOWN.x}
        y={BURNDOWN.y}
        series={BURNDOWN.series}
        description="Burndown with host-driven legend and table."
        // a kind-less legend item falls back to the swatch rendering
        legend={[{ label: 'Custom entry', color: chartColor.actual }]}
        // an empty columns list renders an empty corner header, not a crash
        dataTable={{
          caption: 'Host table.',
          columns: [],
          rows: [
            // one numeric cell + one TEXT cell (the Event column shape)
            { header: 'Day 1', cells: [{ value: 42, numeric: true }, { value: '+4 scope' }] },
          ],
        }}
      />,
    );
    const legend = container.querySelector('ul');
    expect(within(legend as HTMLElement).getByText('Custom entry')).toBeTruthy();
    const table = container.querySelector('table');
    expect(within(table as HTMLElement).getByText('Day 1')).toBeTruthy();
    expect(within(table as HTMLElement).getAllByText('42').length).toBeGreaterThan(0);
  });

  it('hideLegend drops the visible legend while the data table still conveys the series', () => {
    const { container } = render(
      <LineChart
        x={BURNDOWN.x}
        y={BURNDOWN.y}
        series={BURNDOWN.series}
        description="Burndown."
        hideLegend
      />,
    );
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('table')).toBeTruthy();
  });
});

describe('BarChart — 4.6.7 branch pass', () => {
  it('renders without a reference line and treats a missing group value as 0', () => {
    const { container } = render(
      <BarChart
        series={[
          { label: 'Committed', color: chartColor.committed },
          { label: 'Completed', color: chartColor.completed },
        ]}
        // S2's values array is SHORT — the second bar must read 0, never NaN
        groups={[
          { label: 'S1', values: [10, 8] },
          { label: 'S2', values: [12] },
        ]}
        yTicks={[0, 5, 10, 15].map((v) => ({ value: v, label: String(v) }))}
        description="Velocity without an average rule."
      />,
    );
    // no reference line → no dashed rule, and no derived legend entry beyond the series
    expect(container.querySelectorAll('line[stroke-dasharray="6 4"]').length).toBe(0);
    const legend = container.querySelector('ul');
    expect(within(legend as HTMLElement).queryByText('Average completed')).toBeNull();
    // the short values row reads 0 in the value labels + the data table
    const table = container.querySelector('table');
    expect(within(table as HTMLElement).getAllByText('0').length).toBeGreaterThan(0);
  });

  it('draws a SOLID reference line when dashed is explicitly false', () => {
    const { container } = render(
      <BarChart
        series={[{ label: 'Completed', color: chartColor.completed }]}
        groups={[{ label: 'S1', values: [10] }]}
        yTicks={[0, 5, 10].map((v) => ({ value: v, label: String(v) }))}
        description="Velocity with a solid rule."
        referenceLine={{ value: 7, color: chartColor.average, dashed: false }}
      />,
    );
    // the rule renders WITHOUT a dash pattern (and without a label/legend entry)
    const solid = Array.from(container.querySelectorAll('line')).filter(
      (l) =>
        l.getAttribute('stroke')?.includes('--el-chart') && !l.getAttribute('stroke-dasharray'),
    );
    expect(solid.length).toBeGreaterThan(0);
  });

  it('renders the zero-categories state without crashing (the n=0 guards)', () => {
    const { container } = render(
      <BarChart
        series={[{ label: 'Completed', color: chartColor.completed }]}
        groups={[]}
        yTicks={[{ value: 0, label: '0' }]}
        description="No completed sprints."
      />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll('rect')).filter((r) =>
        (r.getAttribute('fill') ?? '').includes('--el-chart'),
      ).length,
    ).toBe(0);
  });
});

// 6.3.4 — the donut + difference/area forms grown into the same 4.6.2 layer.
// Same a11y bar: every form carries role="img" + a <desc> summary + a visible
// legend (count + percentage for the donut) + a data-table fallback, so the
// series read as text+number, never colour alone (finding #35).

describe('DonutChart (distribution form)', () => {
  const STATUS = [
    { label: 'To Do', value: 30 },
    { label: 'In Progress', value: 16 },
    { label: 'Done', value: 22 },
    { label: 'In Review', value: 8 },
    { label: 'Blocked', value: 4 },
  ];

  function renderDonut() {
    return render(
      <DonutChart
        data={STATUS}
        totalNoun="issues"
        statisticLabel="Status"
        description="Donut of 80 issues by status: To Do 30 (37.5%), In Progress 16 (20%), Done 22 (27.5%), In Review 8 (10%), Blocked 4 (5%)."
        ariaLabel="Issues by status"
      />,
    );
  }

  it('renders a labelled role="img" SVG with a <desc> summary + a wedge per segment', () => {
    const { container } = renderDonut();
    const img = screen.getByRole('img', { name: 'Issues by status' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img.querySelector('desc')?.textContent).toContain('80 issues by status');
    // one arc <path> per segment (the centre total/noun are <text>, not paths)
    const wedges = Array.from(container.querySelectorAll('path')).filter((p) =>
      (p.getAttribute('fill') ?? '').includes('--el-chart'),
    );
    expect(wedges).toHaveLength(5);
    // the centre hole shows the total + noun
    expect(screen.getByText('80')).toBeTruthy();
    expect(screen.getByText('issues')).toBeTruthy();
  });

  it('shows a visible legend with count AND percentage per segment (finding #35)', () => {
    const { container } = renderDonut();
    const legend = within(container.querySelector('ul') as HTMLElement);
    expect(legend.getByText('To Do')).toBeTruthy();
    expect(legend.getByText('37.5%')).toBeTruthy();
    expect(legend.getByText('20%')).toBeTruthy();
    expect(legend.getByText('5%')).toBeTruthy();
  });

  it('ships a data-table fallback re-expressing the segments as text+number', () => {
    const { container } = renderDonut();
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    const scope = within(table as HTMLElement);
    expect(scope.getByText('Status')).toBeTruthy();
    expect(scope.getByText('Count')).toBeTruthy();
    expect(scope.getAllByText('30').length).toBeGreaterThan(0);
  });

  it('rolls overflow beyond the ramp into a "+N more" legend row', () => {
    const data = Array.from({ length: 9 }, (_, i) => ({ label: `Component ${i}`, value: 10 }));
    const { container } = render(
      <DonutChart data={data} description="Nine components, capped to the ramp with a rollup." />,
    );
    const legend = within(container.querySelector('ul') as HTMLElement);
    expect(legend.getByText('+3 more')).toBeTruthy();
  });

  it('renders the empty state (no SVG) when there is no positive data', () => {
    const { container } = render(
      <DonutChart
        data={[{ label: 'None', value: 0 }]}
        description="No issues match."
        emptyState={<p>No issues match this scope.</p>}
      />,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('No issues match this scope.')).toBeTruthy();
  });

  it('falls back to a default empty message when no emptyState is given', () => {
    const { container } = render(<DonutChart data={[]} description="Nothing yet." />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('No data to chart yet.')).toBeTruthy();
  });

  it('renders the report-page layout (legend below) and falls back to the desc as the name', () => {
    // legendLayout="below" + no ariaLabel exercises both the layout + name branches;
    // rampLength beyond the ramp length drives the neutral colour fallback.
    render(
      <DonutChart
        data={Array.from({ length: 8 }, (_, i) => ({ label: `S${i}`, value: 5 }))}
        legendLayout="below"
        rampLength={9}
        description="Eight groups, report-page donut."
      />,
    );
    expect(screen.getByRole('img', { name: 'Eight groups, report-page donut.' })).toBeTruthy();
  });
});

describe('DifferenceAreaChart (created-vs-resolved form)', () => {
  const X = {
    domain: [1, 5] as [number, number],
    title: 'Week',
    ticks: [1, 3, 5].map((v) => ({ value: v, label: `W${v}` })),
  };
  const Y = {
    domain: [0, 20] as [number, number],
    title: 'Issues',
    ticks: [0, 10, 20].map((v) => ({ value: v, label: String(v) })),
  };
  // created starts above resolved (deficit), they cross, resolved ends above (surplus)
  const CREATED = [
    { x: 1, y: 14 },
    { x: 2, y: 16 },
    { x: 3, y: 12 },
    { x: 4, y: 8 },
    { x: 5, y: 6 },
  ];
  const RESOLVED = [
    { x: 1, y: 6 },
    { x: 2, y: 8 },
    { x: 3, y: 12 },
    { x: 4, y: 14 },
    { x: 5, y: 15 },
  ];

  function renderDiff() {
    return render(
      <DifferenceAreaChart
        x={X}
        y={Y}
        created={CREATED}
        resolved={RESOLVED}
        description="Created vs resolved over 5 weeks: created leads early (backlog growing), then resolved overtakes (catching up)."
        ariaLabel="Created vs resolved"
      />,
    );
  }

  it('renders a labelled role="img" SVG with both series lines', () => {
    const { container } = renderDiff();
    expect(screen.getByRole('img', { name: 'Created vs resolved' })).toBeTruthy();
    const lines = Array.from(container.querySelectorAll('path[stroke]')).filter(
      (p) => p.getAttribute('stroke') !== 'none',
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('shades the difference between the series (the deficit/surplus fills)', () => {
    const { container } = renderDiff();
    const fills = Array.from(container.querySelectorAll('path[opacity]'));
    expect(fills.length).toBeGreaterThan(0);
  });

  it('distinguishes the series + the fill meaning by TEXT legend, not colour alone', () => {
    const { container } = renderDiff();
    const legend = within(container.querySelector('ul') as HTMLElement);
    expect(legend.getByText('Created')).toBeTruthy();
    expect(legend.getByText('Resolved')).toBeTruthy();
    expect(legend.getByText('Backlog ↑')).toBeTruthy();
    expect(legend.getByText('Catching up')).toBeTruthy();
  });

  it('ships a data-table fallback with both series per bucket', () => {
    const { container } = renderDiff();
    const table = container.querySelector('table');
    const scope = within(table as HTMLElement);
    expect(scope.getByText('Week')).toBeTruthy();
    expect(scope.getAllByText('16').length).toBeGreaterThan(0);
    expect(scope.getAllByText('15').length).toBeGreaterThan(0);
  });

  it('honours hideLegend + a host legend/dataTable override, and "—" for a missing bucket', () => {
    // A bucket present in created but absent from resolved → the "—" cell;
    // an x with no title → the "Bucket" header fallback; hideLegend hides the legend.
    const { container } = render(
      <DifferenceAreaChart
        x={{ domain: [1, 2] as [number, number], ticks: [{ value: 1, label: 'W1' }] }}
        y={Y}
        created={[
          { x: 1, y: 5 },
          { x: 2, y: 7 },
        ]}
        resolved={[{ x: 1, y: 3 }]}
        description="Created leads; one bucket missing from resolved."
        hideLegend
      />,
    );
    expect(container.querySelector('ul')).toBeNull(); // legend hidden
    const scope = within(container.querySelector('table') as HTMLElement);
    expect(scope.getByText('Bucket')).toBeTruthy(); // x.title fallback
    expect(scope.getAllByText('—').length).toBeGreaterThan(0); // missing-bucket cell
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
