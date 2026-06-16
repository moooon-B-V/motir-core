import { getTranslations } from 'next-intl/server';
import { Compass, CheckCheck } from 'lucide-react';
import type { ExploreQuery } from '@/lib/projectSquare/exploreParams';
import { ExploreSearchForm } from './ExploreSearchForm';

// The SEO hero (Story 6.13 · Subtask 6.13.6 · design Panel 1 `.sq-hero`). Leads
// with the page's single semantic <h1> + a descriptive lede + the search, so a
// crawler / answer engine reads a clean, citable headline. A soft lavender corner
// wash; serif headline. Server component; colour via --el-* tokens.
//
// The "1,284 public projects" numeric trust chip from the mock is replaced by a
// qualitative "Open to everyone" chip: the directory read is cursor-paginated
// with no total COUNT (finding #57 — never COUNT a system-level set that could be
// thousands), so an exact live count would need a new aggregate this UI subtask
// deliberately does not add.

export async function ExploreHero({ basePath, query }: { basePath: string; query: ExploreQuery }) {
  const t = await getTranslations('projectSquare');
  return (
    <section className="relative overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-lavender) px-(--spacing-card-padding) py-10 text-center">
      <div className="mx-auto flex max-w-[44rem] flex-col items-center">
        <div className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-(--el-accent-on-surface) uppercase">
          <Compass className="h-4 w-4" aria-hidden />
          {t('heroEyebrow')}
        </div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-(--el-text) sm:text-4xl">
          {t('heroTitle')}
        </h1>
        <p className="mt-3 max-w-[40rem] text-[15px] leading-relaxed text-(--el-text-secondary)">
          {t('heroLede')}
        </p>
        <div className="mt-6 w-full max-w-[34rem]">
          <ExploreSearchForm basePath={basePath} query={query} />
        </div>
        <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[13px] text-(--el-text-muted)">
          {[t('trustCrawlable'), t('trustNoSignup'), t('trustUpdated')].map((label) => (
            <li key={label} className="inline-flex items-center gap-1.5">
              <CheckCheck className="h-3.5 w-3.5 text-(--el-success)" aria-hidden />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
