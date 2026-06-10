import { Table as TableIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/** A single cell value (rendered right-aligned + mono when `numeric`). */
export interface DataTableCell {
  value: string | number;
  numeric?: boolean;
}

export interface DataTableRow {
  /** The row header (first cell, `<th scope="row">`). */
  header: string;
  cells: DataTableCell[];
}

export interface ChartDataTableProps {
  /** `<caption>` — a one-line summary of what the table re-expresses. */
  caption: string;
  /** Column headers; the first labels the row-header column. */
  columns: string[];
  rows: DataTableRow[];
  /** Disclosure summary text. */
  summaryLabel?: string;
  /** Open by default (e.g. when used as the sole text view). */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * ChartDataTable — the a11y fallback every chart renders (Story 4.6.2).
 *
 * A chart conveys data as colour + shape; this re-expresses the SAME numbers
 * as a real `<table>` so assistive tech (and a sighted user who opens the
 * disclosure) reads the series as text + number, never colour alone (finding
 * #35). The table is a `<details>` disclosure — collapsed by default to keep
 * the visual chart compact, but always in the DOM (not display:none behind a
 * toggle), so it is reachable and the chart is never colour-only.
 *
 * Generic over any chart: the caller supplies a caption, column headers, and
 * rows (each with a row header + numeric/text cells). The `LineChart` /
 * `BarChart` build a default table from their series; a host may pass a
 * richer one (e.g. the burndown's per-day Event column).
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
  summaryLabel = 'View data table',
  defaultOpen = false,
  className,
}: ChartDataTableProps) {
  const [first, ...rest] = columns;
  return (
    <details
      open={defaultOpen}
      className={cn('mt-3.5 border-t border-(--el-border) pt-3', className)}
    >
      <summary className="inline-flex items-center gap-1.5 cursor-pointer text-xs font-semibold text-(--el-text-secondary)">
        <TableIcon aria-hidden="true" className="w-3.5 h-3.5 text-(--el-text-muted)" />
        {summaryLabel}
      </summary>
      <table className="w-full mt-2.5 text-xs border-collapse">
        <caption className="text-left text-[11px] text-(--el-text-muted) mb-1.5">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="text-left font-semibold border border-(--el-border) px-2 py-1 bg-(--el-surface-soft) text-(--el-text)"
            >
              {first ?? ''}
            </th>
            {rest.map((col, i) => (
              <th
                key={`${col}-${i}`}
                scope="col"
                className="text-right font-semibold border border-(--el-border) px-2 py-1 bg-(--el-surface-soft) text-(--el-text)"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={`${row.header}-${ri}`}>
              <th
                scope="row"
                className="text-left font-normal border border-(--el-border) px-2 py-1 text-(--el-text-secondary)"
              >
                {row.header}
              </th>
              {row.cells.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'text-right border border-(--el-border) px-2 py-1',
                    cell.numeric ? 'font-mono text-(--el-text)' : 'text-(--el-text-secondary)',
                  )}
                >
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
