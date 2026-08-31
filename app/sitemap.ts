import type { MetadataRoute } from 'next';

// The motir-core sitemap is now EMPTY (MOTIR-3951). Every crawlable public page
// this application once served — the project square (`/explore` + its ranked
// variants), the `/explore/topic/<slug>` landings, and the `/p/<identifier>`
// project + tab surfaces — MOVED to `motir.co`, which publishes its own sitemap
// for what IT serves (`docs/decisions/public-surface-hosts.md` §6). The two
// hosts never describe each other, so this host's sitemap lists nothing rather
// than advertising URLs that now 404 (or 301 off to the brand host). The empty
// list is a deliberate signal — "this host has nothing public to crawl" — and
// `robots.txt` still points at it.

// ⚠️ `force-dynamic` STAYS, even though the body no longer reads the database.
// The historical reason was that a sitemap must not be prerendered into the Fly
// image with placeholder credentials (the route READ the public-project set at
// build time and froze it). The read is gone, but the flag documents the
// contract cheaply and keeps a future author from reintroducing a build-time
// read by accident — a sitemap is a per-request truth about a host, never a
// build-time snapshot.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [];
}
