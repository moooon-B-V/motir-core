import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Search, Tag, TrendingUp } from 'lucide-react';
import {
  buildExploreHref,
  hasActiveFilters,
  type ExploreQuery,
} from '@/lib/projectSquare/exploreParams';

// The active-filter summary bar (Story 6.13 · Subtask 6.13.6 · design Panel 3
// `.filterbar`). Renders the composed query/topic/rank as tone pills + a "Clear
// filters" link (a real `<a href>` back to the unfiltered square, rank/window
// preserved). Only shown when a narrowing filter (search or topic) is active.
// Colour via --el-* tokens; AA-safe coloured chips put the hue in the tint
// BACKGROUND with --el-text-strong text.

const PILL =
  'inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)';

export async function ActiveFilters({
  basePath,
  query,
  categoryLabel,
}: {
  basePath: string;
  query: ExploreQuery;
  /** The display label for the active category slug, if any. */
  categoryLabel?: string;
}) {
  if (!hasActiveFilters(query)) return null;
  const t = await getTranslations('projectSquare');
  const rankSummary =
    query.rank === 'trending'
      ? t('summaryRankTrending', { window: t(`window${cap(query.window)}` as 'windowWeek') })
      : query.rank === 'popular'
        ? t('summaryRankPopular')
        : t('summaryRankNew');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-(--el-text-faint)">{t('activeLabel')}</span>
      {query.search ? (
        <span className={`${PILL} bg-(--el-tint-sky)`}>
          <Search className="h-3 w-3" aria-hidden />
          {t('summarySearch', { query: query.search })}
        </span>
      ) : null}
      {query.category ? (
        <span className={`${PILL} bg-(--el-tint-lavender)`}>
          <Tag className="h-3 w-3" aria-hidden />
          {categoryLabel ?? query.category}
        </span>
      ) : null}
      <span className={`${PILL} bg-(--el-muted)`}>
        <TrendingUp className="h-3 w-3" aria-hidden />
        {rankSummary}
      </span>
      <Link
        href={buildExploreHref(basePath, query, { search: null, category: null })}
        className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
      >
        {t('clearFilters')}
      </Link>
    </div>
  );
}

/** Capitalise a window key to match the `window<Day|Week|Month>` message keys. */
function cap(window: string): string {
  return window.charAt(0).toUpperCase() + window.slice(1);
}
