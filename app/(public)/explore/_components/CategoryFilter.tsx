import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Tag, X, SlidersHorizontal } from 'lucide-react';
import type { ProjectCategoryDto } from '@/lib/dto/projectTags';
import { buildExploreHref, type ExploreQuery } from '@/lib/projectSquare/exploreParams';
import { cn } from '@/lib/utils/cn';

// The category / topic filter chips (Story 6.13 · Subtask 6.13.6 · design Panel 1
// + 3 `.tagchip`). Each chip is a real `<a href>` that sets / clears the
// `?category=` param (composing with the active rank + search, resetting the
// cursor) — server-rendered crawlable URLs, no client state. The selected chip
// gets the lavender tint + an `x` clear affordance; an "All topics" chip clears
// the filter. Colour via --el-* tokens; shape via element-semantic shape tokens.

const CHIP_BASE =
  'inline-flex items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) text-[13px] font-medium';

export async function CategoryFilter({
  basePath,
  query,
  categories,
}: {
  basePath: string;
  query: ExploreQuery;
  /** The browse facet (top categories by public-project count). */
  categories: ProjectCategoryDto[];
}) {
  const t = await getTranslations('projectSquare');
  const active = query.category;
  // Surface the top categories; if the active one isn't among them (it was
  // reached via search/deep-link), prepend it so it stays visible + clearable.
  const top = categories.slice(0, 6);
  if (active && !top.some((c) => c.slug === active)) {
    const found = categories.find((c) => c.slug === active);
    top.unshift(found ?? { slug: active, label: active, projectCount: 0 });
  }

  return (
    <div
      role="group"
      aria-label={t('topicFilterAria')}
      className="flex flex-wrap items-center gap-1.5"
    >
      {top.map((cat) => {
        const isActive = cat.slug === active;
        return (
          <Link
            key={cat.slug}
            href={buildExploreHref(basePath, query, { category: isActive ? null : cat.slug })}
            aria-pressed={isActive}
            className={cn(
              CHIP_BASE,
              isActive
                ? 'border-(--el-border-soft) bg-(--el-tint-lavender) text-(--el-text-strong)'
                : 'border-(--el-border-soft) bg-(--el-surface) text-(--el-text-secondary) hover:border-(--el-border)',
            )}
          >
            <Tag className="h-3.5 w-3.5" aria-hidden />
            {cat.label}
            {isActive ? <X className="h-3.5 w-3.5" aria-hidden /> : null}
          </Link>
        );
      })}
      {active ? (
        <Link
          href={buildExploreHref(basePath, query, { category: null })}
          className={cn(
            CHIP_BASE,
            'border-transparent text-(--el-text-muted) hover:text-(--el-text)',
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          {t('allTopics')}
        </Link>
      ) : null}
    </div>
  );
}
