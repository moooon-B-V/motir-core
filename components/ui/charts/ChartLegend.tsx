import { cn } from '@/lib/utils/cn';
import type { ChartLegendItem } from './tokens';

export interface ChartLegendProps {
  items: ChartLegendItem[];
  className?: string;
}

/**
 * ChartLegend — the visible text legend every chart ships (Story 4.6.2).
 *
 * Colour is NEVER the sole signal (finding #35): each series/bar is named in
 * text beside its swatch, so the legend reads under greyscale and colour-
 * blindness. A `swatch` entry is a filled block (bars), `line`/`dash` are a
 * solid/dashed rule (line series + reference lines). Swatch colour comes from
 * the `--el-chart-*` token passed in `item.color` — the swatch is an inline
 * style because the colour is data, not a static class.
 */
export function ChartLegend({ items, className }: ChartLegendProps) {
  return (
    <ul className={cn('flex flex-wrap gap-x-[18px] gap-y-1.5 list-none p-0 m-0', className)}>
      {items.map((item, i) => {
        const kind = item.kind ?? 'swatch';
        return (
          <li
            key={`${item.label}-${i}`}
            className="inline-flex items-center gap-[7px] text-xs text-(--el-text-secondary)"
          >
            {kind === 'swatch' ? (
              <span
                aria-hidden="true"
                className="inline-block w-4 h-3 rounded-(--radius-badge) shrink-0"
                style={{ background: item.color }}
              />
            ) : (
              <span
                aria-hidden="true"
                className="inline-block w-[18px] shrink-0"
                style={{
                  borderTopWidth: 3,
                  borderTopStyle: kind === 'dash' ? 'dashed' : 'solid',
                  borderTopColor: item.color,
                }}
              />
            )}
            <span className={cn(item.emphasis && 'font-semibold text-(--el-text)')}>
              {item.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
