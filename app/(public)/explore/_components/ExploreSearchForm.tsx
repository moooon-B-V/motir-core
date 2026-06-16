import { getTranslations } from 'next-intl/server';
import { Search } from 'lucide-react';
import { DEFAULT_PROJECT_SQUARE_RANK, DEFAULT_TRENDING_WINDOW } from '@/lib/projectSquare/rank';
import type { ExploreQuery } from '@/lib/projectSquare/exploreParams';

// The square's search field (Story 6.13 · Subtask 6.13.6 · design Panel 1 hero +
// Panel 3). A real GET `<form>` — it works with NO JavaScript and navigates to a
// crawlable `/explore?q=…` URL, the SEO/server-rendered posture this page
// requires. Hidden inputs preserve the active rank / window / topic so a search
// COMPOSES with them (the cursor is intentionally omitted, restarting
// pagination). Server component; colour via --el-* tokens, shape via
// element-semantic shape tokens.

export async function ExploreSearchForm({
  basePath,
  query,
  preserveCategory = true,
}: {
  /** Where the form submits — `/explore` or a topic landing path. */
  basePath: string;
  /** The current query, to seed the input + the preserved hidden params. */
  query: ExploreQuery;
  /** Topic landing pages carry the category in the PATH, so they don't preserve
   * it as a hidden `?category=` field. */
  preserveCategory?: boolean;
}) {
  const t = await getTranslations('projectSquare');
  return (
    <form
      method="get"
      action={basePath}
      role="search"
      aria-label={t('searchAria')}
      className="flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:border-(--el-border-strong)"
    >
      <Search className="h-4 w-4 flex-none text-(--el-text-muted)" aria-hidden />
      <input
        type="text"
        name="q"
        defaultValue={query.search ?? ''}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchAria')}
        className="min-w-0 flex-1 bg-transparent text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus:outline-none"
      />
      {/* Preserve the active ordering/topic so a search composes, not resets. */}
      {query.rank !== DEFAULT_PROJECT_SQUARE_RANK ? (
        <input type="hidden" name="rank" value={query.rank} />
      ) : null}
      {query.rank === 'trending' && query.window !== DEFAULT_TRENDING_WINDOW ? (
        <input type="hidden" name="window" value={query.window} />
      ) : null}
      {preserveCategory && query.category ? (
        <input type="hidden" name="category" value={query.category} />
      ) : null}
      <button type="submit" className="sr-only">
        {t('searchSubmit')}
      </button>
    </form>
  );
}
