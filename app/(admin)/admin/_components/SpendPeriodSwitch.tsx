'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The console's PERIOD SWITCH (Story MOTIR-727 · MOTIR-732) — a month picker, then
 * All time, on the RIGHT of a page's toolbar row (the approved header grammar).
 *
 * The period lives in the URL (`?period=YYYY-MM|all`), so a view is linkable and
 * survives a reload; choosing one replaces only `period` and drops any list cursor,
 * which belongs to the period it was issued for. Every other parameter is kept.
 */
export function SpendPeriodSwitch({
  period,
  months,
  labels,
}: {
  period: string;
  /** `YYYY-MM`, newest first. */
  months: { value: string; label: string }[];
  labels: { month: string; allTime: string; group: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isAll = period === 'all';

  const go = (next: string) => {
    const query = new URLSearchParams(params.toString());
    query.set('period', next);
    query.delete('cursor');
    router.push(`${pathname}?${query.toString()}`);
  };

  return (
    <div role="group" aria-label={labels.group} className="flex items-center gap-2">
      <label className="sr-only" htmlFor="spend-period-month">
        {labels.month}
      </label>
      <select
        id="spend-period-month"
        value={isAll ? '' : period}
        onChange={(e) => e.target.value && go(e.target.value)}
        className={`h-(--height-input) rounded-(--radius-input) border px-2 font-sans text-sm ${
          isAll
            ? 'border-(--el-border) bg-(--el-page-bg) text-(--el-text-secondary)'
            : 'border-(--el-accent-on-surface) bg-(--el-page-bg) text-(--el-text)'
        }`}
      >
        {isAll ? <option value="">{labels.month}</option> : null}
        {months.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-pressed={isAll}
        onClick={() => go('all')}
        className={`h-(--height-input) rounded-(--radius-input) border px-3 font-sans text-sm ${
          isAll
            ? 'border-(--el-accent-on-surface) bg-(--el-surface-raised) text-(--el-text)'
            : 'border-(--el-border) text-(--el-text-secondary) hover:text-(--el-text)'
        }`}
      >
        {labels.allTime}
      </button>
    </div>
  );
}
