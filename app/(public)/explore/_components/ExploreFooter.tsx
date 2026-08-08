import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

// The marketing-site footer (Story 6.13 · Subtask 6.13.6 · design Panel 1
// `.site-foot`). Primarily an SEO LINK SURFACE: the "Explore by topic" column is
// real `<a href="/explore/topic/<slug>">` crawl links into the per-topic landing
// pages (so the topic pages are reachable from every square page). The Product /
// Company columns are future marketing pages and render as non-interactive
// labels (no dead links). Server component; colour via --el-* tokens.
//
// EMPTY `topics` is a first-class state, not an accident (MOTIR-2452). Two
// callers reach it: a fresh install where no public project is tagged yet, and
// the documentation shell, which passes `[]` on purpose so that published docs
// carry no database client (see `app/(public)/docs/layout.tsx`). Rendering the
// heading over an empty list would leave an orphan column AND sever the only
// crawl path from those pages into the square, so the column falls back to ONE
// link to `/explore` — where the live per-topic links live.

export async function ExploreFooter({
  topics,
}: {
  /**
   * The top topics (by public-project count) to link from the footer. An empty
   * array renders the "browse all topics" fallback link instead — see above.
   */
  topics: Array<{ slug: string; label: string }>;
}) {
  const t = await getTranslations('projectSquare');
  return (
    <footer className="mt-10 grid grid-cols-2 gap-8 border-t border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-8 md:grid-cols-4">
      <div className="col-span-2 min-w-0 md:col-span-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-xs font-extrabold text-(--el-accent-text)"
          >
            M
          </span>
          <span className="text-sm font-bold text-(--el-text)">{t('brand')}</span>
        </div>
        <p className="mt-2 max-w-[22rem] text-[13px] leading-relaxed text-(--el-text-muted)">
          {t('footerTagline')}
        </p>
      </div>

      <div className="min-w-0">
        <h2 className="mb-2.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
          {t('footExploreByTopic')}
        </h2>
        <ul className="flex flex-col gap-1.5">
          {topics.length === 0 ? (
            <li>
              <Link
                href="/explore"
                className="text-[13px] text-(--el-text-secondary) hover:text-(--el-link)"
              >
                {t('footExploreAllTopics')}
              </Link>
            </li>
          ) : (
            topics.map((topic) => (
              <li key={topic.slug}>
                <Link
                  href={`/explore/topic/${topic.slug}`}
                  className="text-[13px] text-(--el-text-secondary) hover:text-(--el-link)"
                >
                  {topic.label}
                </Link>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="min-w-0">
        <h2 className="mb-2.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
          {t('footProduct')}
        </h2>
        <ul className="flex flex-col gap-1.5 text-[13px] text-(--el-text-muted)">
          <li>{t('footProductOverview')}</li>
          <li>{t('footProductPlanning')}</li>
          <li>{t('footProductBoards')}</li>
          <li>
            <Link href="/docs/api" className="text-(--el-text-secondary) hover:text-(--el-link)">
              {t('footProductApiDocs')}
            </Link>
          </li>
          <li>{t('footProductPricing')}</li>
        </ul>
      </div>

      <div className="min-w-0">
        <h2 className="mb-2.5 text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase">
          {t('footCompany')}
        </h2>
        <ul className="flex flex-col gap-1.5 text-[13px] text-(--el-text-muted)">
          <li>{t('footCompanyAbout')}</li>
          <li>{t('footCompanyBlog')}</li>
          <li>{t('footCompanyOpenSource')}</li>
          <li>{t('footCompanyContact')}</li>
        </ul>
      </div>
    </footer>
  );
}
