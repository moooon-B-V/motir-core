import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import {
  buildExploreHref,
  parseExploreSearchParams,
  type ExploreQuery,
  type RawSearchParams,
} from '@/lib/projectSquare/exploreParams';
import { ExploreHero } from './_components/ExploreHero';
import { RankTabs } from './_components/RankTabs';
import { CategoryFilter } from './_components/CategoryFilter';
import { ActiveFilters } from './_components/ActiveFilters';
import { ExploreGallery } from './_components/ExploreGallery';
import { CategoriesBrowse } from './_components/CategoriesBrowse';
import { ExploreFaq, exploreFaqItems } from './_components/ExploreFaq';
import { ExploreJsonLd } from './_components/ExploreJsonLd';
import { loadSquare, categoryLabel } from './_lib/loadSquare';

// The PROJECT SQUARE — the fully-public, server-rendered, SEO/GEO-optimised
// `/explore` marketing-site page (Story 6.13 · Subtask 6.13.6). Renders the SEO
// hero, the ranked + filtered card gallery (cursor-paginated), the rank/window
// tabs + search + topic filter (all real crawlable URL params), the
// browse-by-topic facet, and the GEO FAQ — for a LOGGED-OUT visitor / crawler,
// with NO session gate. 4-layer: it reads THROUGH the shipped services
// (`projectSquareService` / `projectTagsService`), no raw Prisma here.

const BASE = '/explore';

/** The absolute canonical URL for a square view (cursor dropped — page 2+
 * consolidates onto its filter/rank set so deep keyset pages don't fragment
 * the index). */
function canonicalUrl(query: ExploreQuery): string {
  return publicSiteOrigin() + buildExploreHref(BASE, { ...query, cursor: undefined });
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const t = await getTranslations('projectSquare');
  const query = parseExploreSearchParams(await searchParams);
  const title = t('metaTitle');
  const description = t('metaDescription');
  const url = canonicalUrl(query);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', title, description, url, siteName: 'Motir' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/** The SEO <h2> over the gallery — varies by search / rank so each indexable
 * state has a descriptive, distinct heading. */
async function galleryHeading(query: ExploreQuery): Promise<string> {
  const t = await getTranslations('projectSquare');
  if (query.search) return t('galleryHeadingSearch', { query: query.search });
  if (query.rank === 'popular') return t('galleryHeadingPopular');
  if (query.rank === 'recent') return t('galleryHeadingNew');
  return t('galleryHeadingTrending');
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const query = parseExploreSearchParams(await searchParams);
  const { page, categories, effectiveQuery } = await loadSquare(query);
  const heading = await galleryHeading(effectiveQuery);
  const faq = await exploreFaqItems();
  const t = await getTranslations('projectSquare');

  return (
    <>
      <ExploreHero basePath={BASE} query={effectiveQuery} />

      <div className="mt-8 flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <RankTabs basePath={BASE} query={effectiveQuery} />
          <CategoryFilter basePath={BASE} query={effectiveQuery} categories={categories} />
        </div>
        <ActiveFilters
          basePath={BASE}
          query={effectiveQuery}
          categoryLabel={categoryLabel(categories, effectiveQuery.category)}
        />
      </div>

      <div className="mt-6">
        <ExploreGallery basePath={BASE} query={effectiveQuery} page={page} heading={heading} />
      </div>

      <div className="mt-14 border-t border-(--el-border) pt-10">
        <CategoriesBrowse categories={categories} />
      </div>

      <div className="mt-10">
        <ExploreFaq />
      </div>

      <ExploreJsonLd
        pageUrl={canonicalUrl(effectiveQuery)}
        name={t('metaTitle')}
        description={t('metaDescription')}
        cards={page.items}
        faq={faq}
      />
    </>
  );
}
