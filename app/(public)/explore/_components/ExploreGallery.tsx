import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Plus, FolderOpen, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import type { ProjectSquarePageDto } from '@/lib/dto/projectSquare';
import {
  buildExploreHref,
  hasActiveFilters,
  type ExploreQuery,
} from '@/lib/projectSquare/exploreParams';
import { ProjectSquareCard } from './ProjectSquareCard';

// The card gallery + cursor pagination + empty/no-results states (Story 6.13 ·
// Subtask 6.13.6 · design Panel 1 `.pgrid` / `.loadmore` + Panel 5 states). The
// grid is paginated over the 6.13.2 keyset cursor — NEVER load-all (finding #57):
// "Load more" is a real `<a href="?cursor=…">` to the next crawlable page, so
// pagination works with no JS. An empty result splits on whether a filter is
// active (no-results, with a clear-filters action) vs a genuinely empty square.
// Colour via --el-* tokens; shape via element-semantic shape tokens.

export async function ExploreGallery({
  basePath,
  query,
  page,
  heading,
}: {
  basePath: string;
  query: ExploreQuery;
  page: ProjectSquarePageDto;
  /** The SEO <h2> for this gallery (varies by rank / search / topic). */
  heading: string;
}) {
  const t = await getTranslations('projectSquare');

  if (page.items.length === 0) {
    const filtered = hasActiveFilters(query);
    return (
      <section aria-labelledby="explore-gallery-heading">
        <h2 id="explore-gallery-heading" className="sr-only">
          {heading}
        </h2>
        <EmptyState
          icon={
            filtered ? (
              <SearchX className="h-6 w-6" aria-hidden />
            ) : (
              <FolderOpen className="h-6 w-6" aria-hidden />
            )
          }
          title={filtered ? t('noResultsTitle') : t('emptyTitle')}
          description={filtered ? t('noResultsBody') : t('emptyBody')}
          action={
            filtered ? (
              <Link
                href={buildExploreHref(basePath, query, { search: null, category: null })}
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                {t('clearFilters')}
              </Link>
            ) : undefined
          }
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="explore-gallery-heading">
      <h2
        id="explore-gallery-heading"
        className="font-serif text-lg font-semibold text-(--el-text)"
      >
        {heading}
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {page.items.map((card) => (
          <ProjectSquareCard key={card.identifier} card={card} />
        ))}
      </div>

      {page.nextCursor ? (
        <div className="mt-8 flex flex-col items-center gap-2">
          <Link
            href={buildExploreHref(basePath, query, { cursor: page.nextCursor })}
            className={buttonVariants({ variant: 'secondary', size: 'md' })}
            rel="next"
          >
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            {t('loadMore')}
          </Link>
          <p className="text-center font-mono text-xs text-(--el-text-faint)">
            {t('paginationNote')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
