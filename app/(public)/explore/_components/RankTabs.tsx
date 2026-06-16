import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { TrendingUp, Star, Clock } from 'lucide-react';
import { PROJECT_SQUARE_RANKS, TRENDING_WINDOWS } from '@/lib/projectSquare/rank';
import { buildExploreHref, type ExploreQuery } from '@/lib/projectSquare/exploreParams';
import { cn } from '@/lib/utils/cn';

// The sort / rank tabs + the Trending window (Story 6.13 · Subtask 6.13.6 ·
// design Panel 2 `.seg`). Built as the design's Segmented control, but rendered
// as real `<a href>` LINKS (not the client `<Segmented onChange>`): each rank /
// window is its own server-rendered, shareable, CRAWLABLE URL — the SEO contract
// — so switching tab is a navigation, not client state. Each link resets the
// keyset cursor (a tab/window change restarts pagination). Colour via --el-*
// tokens; shape via element-semantic shape tokens.

const RANK_META = {
  trending: { icon: TrendingUp, labelKey: 'rankTrending' as const },
  popular: { icon: Star, labelKey: 'rankPopular' as const },
  recent: { icon: Clock, labelKey: 'rankNew' as const },
};

const WINDOW_META = {
  day: 'windowDay' as const,
  week: 'windowWeek' as const,
  month: 'windowMonth' as const,
};

/** A Segmented-styled track wrapper shared by the rank + window groups. */
function SegTrack({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5"
    >
      {children}
    </div>
  );
}

/** One Segmented option as a link (active = raised --el-page-bg fill). */
function SegLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] font-medium transition-colors',
        active
          ? 'bg-(--el-page-bg) text-(--el-text) shadow-(--shadow-subtle)'
          : 'text-(--el-text-muted) hover:text-(--el-text)',
      )}
    >
      {children}
    </Link>
  );
}

export async function RankTabs({ basePath, query }: { basePath: string; query: ExploreQuery }) {
  const t = await getTranslations('projectSquare');
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegTrack label={t('sortAria')}>
        {PROJECT_SQUARE_RANKS.map((rank) => {
          const { icon: Icon, labelKey } = RANK_META[rank];
          const active = query.rank === rank;
          const tint = active
            ? rank === 'trending'
              ? 'text-(--el-accent)'
              : rank === 'popular'
                ? 'text-(--el-warning)'
                : 'text-(--el-info)'
            : '';
          return (
            <SegLink key={rank} href={buildExploreHref(basePath, query, { rank })} active={active}>
              <Icon className={cn('h-3.5 w-3.5', tint)} aria-hidden />
              {t(labelKey)}
            </SegLink>
          );
        })}
      </SegTrack>

      {query.rank === 'trending' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-(--el-text-faint)">{t('windowLabel')}</span>
          <SegTrack label={t('windowAria')}>
            {TRENDING_WINDOWS.map((window) => (
              <SegLink
                key={window}
                href={buildExploreHref(basePath, query, { window })}
                active={query.window === window}
              >
                {t(WINDOW_META[window])}
              </SegLink>
            ))}
          </SegTrack>
        </div>
      ) : null}
    </div>
  );
}
