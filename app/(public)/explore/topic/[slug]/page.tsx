import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { InvalidProjectSquareCategoryError } from '@/lib/projectSquare/errors';
import type { SquareData } from '../../_lib/loadSquare';
import {
  buildExploreHref,
  parseExploreSearchParams,
  type ExploreQuery,
  type RawSearchParams,
} from '@/lib/projectSquare/exploreParams';
import { ExploreSearchForm } from '../../_components/ExploreSearchForm';
import { RankTabs } from '../../_components/RankTabs';
import { ActiveFilters } from '../../_components/ActiveFilters';
import { ExploreGallery } from '../../_components/ExploreGallery';
import { CategoriesBrowse } from '../../_components/CategoriesBrowse';
import { ExploreFaq, exploreFaqItems } from '../../_components/ExploreFaq';
import { ExploreJsonLd } from '../../_components/ExploreJsonLd';
import { loadSquare, categoryLabel } from '../../_lib/loadSquare';

// A per-topic landing page (Story 6.13 · Subtask 6.13.6 · design Panel 3 — the
// `/explore/topic/<slug>` SEO surface). The same fully-public square, narrowed to
// one topic (`category = slug`, carried in the PATH not a query param), with its
// own <h1>, a breadcrumb, and a BreadcrumbList JSON-LD — the indexable landing
// page for "{topic} projects". An UNKNOWN topic slug 404s (`strictCategory`).
// rank / window / search still compose as query params. 4-layer: reads through
// the services via `loadSquare`.

function basePathFor(slug: string): string {
  return `/explore/topic/${slug}`;
}

/** The query for a topic page: the category is pinned to the path slug. */
async function topicQuery(
  slug: string,
  searchParams: Promise<RawSearchParams>,
): Promise<ExploreQuery> {
  return parseExploreSearchParams(await searchParams, { category: slug });
}

function canonicalUrl(slug: string, query: ExploreQuery): string {
  return (
    publicSiteOrigin() +
    buildExploreHref(basePathFor(slug), { ...query, category: undefined, cursor: undefined })
  );
}

/** Read the square for a topic, turning an UNKNOWN topic slug into a 404 (the
 * `strictCategory` read throws `InvalidProjectSquareCategoryError`). */
async function loadTopicOr404(query: ExploreQuery): Promise<SquareData> {
  try {
    return await loadSquare(query, { strictCategory: true });
  } catch (err) {
    if (err instanceof InvalidProjectSquareCategoryError) notFound();
    throw err;
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations('projectSquare');
  const query = await topicQuery(slug, searchParams);
  // Resolve a human label for the topic (falls back to the slug).
  const { categories } = await loadTopicOr404(query);
  const label = categoryLabel(categories, slug) ?? slug;
  const title = t('metaTitleTopic', { topic: label });
  const description = t('metaDescriptionTopic', { topic: label });
  const url = canonicalUrl(slug, query);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', title, description, url, siteName: 'Motir' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function ExploreTopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { slug } = await params;
  const t = await getTranslations('projectSquare');
  const query = await topicQuery(slug, searchParams);
  // strictCategory → an unknown topic slug throws → Next renders not-found.
  const { page, categories, effectiveQuery } = await loadTopicOr404(query);
  const label = categoryLabel(categories, slug) ?? slug;
  const base = basePathFor(slug);
  const faq = await exploreFaqItems();

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-[13px] text-(--el-text-muted)"
      >
        <Link href="/explore" className="hover:text-(--el-link)">
          {t('topicBreadcrumbHome')}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span className="font-medium text-(--el-text)">{label}</span>
      </nav>

      <header className="mt-4">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-(--el-text)">
          {t('topicHeading', { topic: label })}
        </h1>
        <p className="mt-2 max-w-[42rem] text-[15px] leading-relaxed text-(--el-text-secondary)">
          {t('topicLede', { topic: label })}
        </p>
        <div className="mt-5 max-w-[34rem]">
          <ExploreSearchForm basePath={base} query={effectiveQuery} preserveCategory={false} />
        </div>
      </header>

      <div className="mt-8 flex flex-col gap-4">
        <RankTabs basePath={base} query={effectiveQuery} />
        <ActiveFilters basePath={base} query={effectiveQuery} categoryLabel={label} />
      </div>

      <div className="mt-6">
        <ExploreGallery
          basePath={base}
          query={effectiveQuery}
          page={page}
          heading={t('galleryHeadingTopic', { topic: label })}
        />
      </div>

      <div className="mt-14 border-t border-(--el-border) pt-10">
        <CategoriesBrowse categories={categories} />
      </div>

      <div className="mt-10">
        <ExploreFaq />
      </div>

      <ExploreJsonLd
        pageUrl={canonicalUrl(slug, effectiveQuery)}
        name={t('metaTitleTopic', { topic: label })}
        description={t('metaDescriptionTopic', { topic: label })}
        cards={page.items}
        faq={faq}
        breadcrumb={{
          topicLabel: label,
          topicUrl: canonicalUrl(slug, effectiveQuery),
          squareLabel: t('topicBreadcrumbHome'),
        }}
      />
    </>
  );
}
