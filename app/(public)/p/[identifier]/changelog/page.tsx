import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Rocket } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { getPublicOverview } from '@/lib/publicProjects/viewerContext';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicChangelog } from '@/app/(public)/_components/PublicChangelog';
import { PublicFollowControl } from '@/app/(public)/_components/PublicFollowControl';
import { publicFollowService } from '@/lib/services/publicFollowService';

// The public CHANGELOG tab (Story 8.9 · Subtask 8.9.4 · design
// `public-changelog.mock.html` Panel B) — the PUSH half of the public project,
// and the surface that retires the external `links.changelog` placeholder.
//
// Server component, like every other public tab: it runs the anonymous browse
// gate (a non-public / unknown project 404s, never 403), renders the FIRST page
// of entries into the crawlable HTML, and hands them to the client island for
// the "Load more" pager. READ is fully public — no sign-in anywhere on this
// page, and `actorUserId` only decides whether the 6.14 private-epic exclusion
// applies (a member reads the unfiltered stream, exactly as on every other tab).
//
// Nothing here is authored: an entry is DERIVED from a work item entering a
// shipped status (`docs/decisions/public-follow-and-changelog.md` §2), which is
// why the empty state says "nothing shipped yet" rather than "no entries
// written yet" — the honest statement, and the state a brand-new public project
// opens in.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ identifier: string }>;
}): Promise<Metadata> {
  const { identifier } = await params;
  const session = await getSession();
  let overview;
  try {
    overview = await getPublicOverview(identifier, session?.user.id ?? null);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return {};
    throw err;
  }
  const t = await getTranslations('publicProjects');
  // The layout supplies the site-wide OpenGraph/Twitter shape; this override
  // gives the tab its OWN title, description and canonical, so the changelog is
  // a distinct indexable URL rather than a duplicate of the project landing.
  const title = `${t('changelogTitle')} · ${overview.name}`;
  const description = t('changelogMetaDescription', { name: overview.name });
  const url = `${publicProjectUrl(overview.identifier)}/changelog`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', title, description, url, siteName: 'Motir' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function PublicChangelogPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let page;
  let overview;
  let followState;
  try {
    [page, overview, followState] = await Promise.all([
      publicProjectsService.getChangelog(identifier, actorUserId),
      getPublicOverview(identifier, actorUserId),
      publicFollowService.getFollowState(identifier, actorUserId),
    ]);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const url = `${publicProjectUrl(overview.identifier)}/changelog`;

  // JSON-LD: a `CollectionPage` whose `itemListElement` is the shipped set, so
  // an answer engine can cite WHAT shipped and WHEN rather than only that a
  // changelog exists. Only the first (server-rendered) page is described —
  // asserting entries the HTML does not carry would be a structured-data claim
  // about content that is not on the page.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${t('changelogTitle')} · ${overview.name}`,
    description: t('changelogMetaDescription', { name: overview.name }),
    url,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: page.entries.map((entry, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'CreativeWork',
          name: entry.title,
          identifier: entry.identifier,
          datePublished: entry.shippedAt,
          url: `${publicProjectUrl(overview.identifier)}/items/${entry.identifier}`,
        },
      })),
    },
  };

  return (
    <>
      <PublicTabNav identifier={identifier} active="changelog" />
      <div className="p-(--spacing-card-padding)">
        <header className="mb-1 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-[22px] font-bold text-(--el-text)">
              {t('changelogTitle')}
            </h1>
            <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-relaxed text-(--el-text-secondary)">
              {t('changelogLede')}
            </p>
          </div>
          {/* The Follow control lives here as well as in the top bar: this is
              the page a person lands on from a "follow along" link, and the
              moment they are most likely to subscribe is while reading it. */}
          <PublicFollowControl
            identifier={identifier}
            initialState={followState}
            signedIn={session !== null}
            feedUrl={`${url}.xml`}
          />
        </header>

        {page.entries.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={<Rocket className="h-12 w-12" aria-hidden />}
              title={t('changelogEmptyTitle')}
              description={t('changelogEmptyBody')}
            />
          </div>
        ) : (
          <>
            <PublicChangelog
              identifier={identifier}
              initialEntries={page.entries}
              initialCursor={page.nextCursor}
            />
            {/* The standard JSON-LD carrier. The payload is server-built from
                our own DTO and JSON-serialized, never user HTML. */}
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />
          </>
        )}
      </div>
    </>
  );
}
