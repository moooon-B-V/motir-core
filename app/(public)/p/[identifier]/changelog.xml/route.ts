import { notFound } from 'next/navigation';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { renderAtomFeed } from '@/lib/publicProjects/atomFeed';

// The public changelog FEED (Story 8.9 · Subtask 8.9.6 · ADR §5) — the
// ANONYMOUS follower tier, and the only one that stores nothing about the
// person who uses it.
//
// ⚠️ THE EXTENSION IS `.xml` AND THE PAYLOAD IS ATOM, and that is not a
// contradiction: the extension is the URL Story 8.9's own verification recipe
// names, and the media type is what the `Content-Type` says. A file extension
// has never been a media type. `/changelog.atom` is deliberately NOT also
// served — a feed URL is copied into readers and outlives every redirect we
// would later regret, so there is exactly one.
//
// NO SESSION IS READ. The other public routes take one to decide the 6.14
// exclusion for a MEMBER; a feed is fetched by a reader daemon with no cookies,
// so passing `null` is not a limitation but the accurate description of who is
// asking. It also keeps the response cacheable, since it cannot vary by viewer.

export async function GET(_req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;

  let feed;
  try {
    feed = await publicProjectsService.getChangelogFeed(identifier, null);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const base = publicProjectUrl(feed.project.identifier);
  const body = renderAtomFeed({
    projectIdentifier: feed.project.identifier,
    projectName: feed.project.name,
    pageUrl: `${base}/changelog`,
    feedUrl: `${base}/changelog.xml`,
    itemUrl: (entryIdentifier) => `${base}/items/${entryIdentifier}`,
    entries: feed.entries,
    updated: new Date(),
  });

  return new Response(body, {
    headers: {
      // `application/atom+xml` is the registered type; the charset is explicit
      // because a reader that guesses will guess latin-1 and mangle every
      // non-ASCII title.
      'Content-Type': 'application/atom+xml; charset=utf-8',
      // Cached for five minutes, and `stale-while-revalidate` so a popular feed
      // serves instantly while it refreshes behind the request. A changelog
      // changes when something ships — minutes of staleness is invisible to a
      // reader that polls hourly, and the alternative is a database read per
      // poller per poll.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
