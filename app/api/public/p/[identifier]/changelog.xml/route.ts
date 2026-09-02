import { NextResponse } from 'next/server';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import { renderAtomFeed } from '@/lib/publicProjects/atomFeed';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// The public changelog FEED, restored (MOTIR-4111) — the ANONYMOUS follower
// tier, and the only one that stores nothing about the person who uses it.
//
// ── ⚠️ THE BUILDER HAD NO CALLER, AND NOTHING SAID SO ──────────────────────
//
// `lib/publicProjects/atomFeed.ts` and its test survived MOTIR-3951; the route
// that served the document — `app/(public)/p/[identifier]/changelog.xml/route.ts`
// — did not. A module with no caller compiles, type-checks and passes its own
// unit tests for ever, so nothing went red: the only symptom was that everyone
// subscribed to a project's build log stopped receiving anything. This route is
// that caller. The builder is REUSED verbatim, not reimplemented and not copied
// into `motir-marketing` — `public-surface-hosts.md` §2 alternative E is why the
// consumer gets a document rather than a JSON payload to re-serialise.
//
// ── ⚠️ THE PATH PEOPLE ARE ALREADY SUBSCRIBED TO ───────────────────────────
//
// A feed URL is copied into a reader and outlives every redirect we would later
// regret, so the address matters more here than anywhere else on the surface.
// The one in the wild is `app.motir.co/p/<identifier>/changelog.xml`. That is
// inside `proxy.ts`'s `/p/:path*` matcher with `p` in `PUBLIC_REDIRECT_SEGMENTS`,
// so once the cutover (MOTIR-3910) sets `MOTIR_PUBLIC_SITE_URL` it 308s to
// `motir.co/p/<identifier>/changelog.xml` — path preserved. MOTIR-4118 must
// answer THAT path on `motir.co`; this route is the API endpoint behind it, and
// the two are deliberately different addresses with the same document.
//
// ── The extension is `.xml` and the payload is Atom ────────────────────────
//
// Not a contradiction: a file extension has never been a media type, and the
// `Content-Type` is what says so. `/changelog.atom` is deliberately NOT also
// served — see the paragraph above, there is exactly one feed URL.
//
// ── NO SESSION IS READ, and that is accuracy rather than a limitation ──────
//
// The reads beside this one take a session to apply member-visibility. A feed is
// fetched by a reader daemon with no cookies, so `null` describes who is asking.
// It also keeps the response cacheable: it cannot vary by viewer, so there is
// nothing to `Vary` on.

export async function GET(_req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST: with `MOTIR_CLOUD` unset this
  // surface does not exist. It precedes everything, as on every route here, and
  // there is no session read to precede.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { identifier } = await params;

  let feed;
  try {
    feed = await publicProjectsService.getChangelogFeed(identifier, null);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      // 404 with a bare `{ code }` — the JSON error shape every route here
      // answers with, even though the success body is XML. A consumer that has
      // to parse two error formats off one surface is a consumer that parses
      // neither reliably.
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
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
