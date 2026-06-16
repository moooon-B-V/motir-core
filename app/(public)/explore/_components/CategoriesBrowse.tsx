import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Tag } from 'lucide-react';
import type { ProjectCategoryDto } from '@/lib/dto/projectTags';

// Browse-by-topic facet (Story 6.13 · Subtask 6.13.6 · design Panel 3 `.cats`).
// Every topic with at least one public project, sorted by count, each a real
// crawlable `<a href="/explore/topic/<slug>">` landing-page link (the per-topic
// SEO surface) with a proportional count bar. Rendered in a semantic <nav> so the
// topic outline is part of the page's crawlable structure. Server component;
// colour via --el-* tokens. The 6.13.5 facet read (`projectTagsService
// .listCategories`) is the source.

export async function CategoriesBrowse({ categories }: { categories: ProjectCategoryDto[] }) {
  const t = await getTranslations('projectSquare');
  if (categories.length === 0) return null;
  const max = Math.max(...categories.map((c) => c.projectCount), 1);

  return (
    <section aria-labelledby="explore-browse-heading">
      <h2 id="explore-browse-heading" className="font-serif text-lg font-semibold text-(--el-text)">
        {t('browseTitle')}
      </h2>
      <p className="mt-1 text-[13px] text-(--el-text-muted)">{t('browseSubtitle')}</p>
      <nav aria-label={t('browseTitle')} className="mt-4 flex flex-col">
        {categories.map((cat) => (
          <Link
            key={cat.slug}
            href={`/explore/topic/${cat.slug}`}
            className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface-soft)"
          >
            <Tag className="h-3.5 w-3.5 flex-none text-(--el-text-muted)" aria-hidden />
            <span className="w-40 flex-none truncate text-[13.5px] font-medium text-(--el-text)">
              {cat.label}
            </span>
            <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--el-muted)">
              <span
                className="block h-full rounded-full bg-(--el-accent)"
                style={{ width: `${Math.max(6, Math.round((cat.projectCount / max) * 100))}%` }}
              />
            </span>
            <span
              className="w-10 flex-none text-right font-mono text-xs text-(--el-text-faint)"
              aria-label={t('browseCountAria', { count: cat.projectCount })}
            >
              {cat.projectCount}
            </span>
          </Link>
        ))}
      </nav>
    </section>
  );
}
