import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { runAsCloudBuild } from '../helpers/cloudBuild';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

// The CRAWL surface's two endpoints (MOTIR-4111) — the changelog Atom feed and
// the public-project index.
//
// ⚠️ BOTH OF THESE FAIL SILENTLY WHEN THEY FAIL, which is why they are tested at
// the route rather than left to the service's own suites. A feed builder with no
// caller compiles and passes its unit tests for ever — that is exactly the state
// MOTIR-3951 left it in, and nothing went red for the whole window. An index
// whose pagination reshuffles under a walk returns correct-looking pages that
// skip projects, and nothing reports that either. So what is asserted here is
// the WIRING and the ORDER GUARANTEE, not the content.

const feedSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/changelog.xml/route.ts'),
  'utf8',
);
const indexSrc = readFileSync(join(process.cwd(), 'app/api/public/projects/route.ts'), 'utf8');
const repoSrc = readFileSync(join(process.cwd(), 'lib/repositories/projectRepository.ts'), 'utf8');

const getChangelogFeed = vi.hoisted(() => vi.fn());
const listPublicIndex = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getChangelogFeed, listPublicIndex },
}));

const { GET: feedGET } = await import('@/app/api/public/p/[identifier]/changelog.xml/route');
const { GET: indexGET } = await import('@/app/api/public/projects/route');

const params = (identifier: string) => ({ params: Promise.resolve({ identifier }) });
const req = (path: string) => new Request(`https://app.motir.co${path}`);

const feed = {
  project: { identifier: 'PROD', name: 'Prodect' },
  entries: [
    {
      identifier: 'PROD-3',
      key: 3,
      title: 'Shipped a thing',
      kind: 'task',
      status: 'done',
      priority: 'medium',
      shippedAt: '2026-08-30T00:00:00.000Z',
      epic: null,
      descriptionMd: 'The body',
    },
  ],
};

afterEach(() => vi.clearAllMocks());

describe('GET /api/public/p/{identifier}/changelog.xml — the orphaned builder gains a caller', () => {
  it('serves an Atom document with the registered media type and an explicit charset', async () => {
    getChangelogFeed.mockResolvedValue(feed);

    const res = await feedGET(req('/api/public/p/PROD/changelog.xml'), params('PROD'));

    expect(res.status).toBe(200);
    // The charset is explicit because a reader that guesses guesses latin-1 and
    // mangles every non-ASCII title.
    expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');
    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  });

  it('reads NO session — a feed is fetched by a daemon with no cookies', () => {
    // Asserted at the source because there is nothing to observe at runtime: a
    // route that read a session would behave identically here and would stop
    // being cacheable in production, where the cost lands.
    expect(feedSrc).not.toContain('getSession');
    expect(feedSrc).not.toContain('@/lib/auth');
  });

  it('is CACHEABLE, and says so', async () => {
    getChangelogFeed.mockResolvedValue(feed);
    const res = await feedGET(req('/api/public/p/PROD/changelog.xml'), params('PROD'));
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=600',
    );
  });

  it('builds every URL against the PUBLIC site, not this host', async () => {
    // publicProjectUrl resolves publicSiteOrigin(), which falls back to the
    // application origin while MOTIR_PUBLIC_SITE_URL is unset — the ordering
    // guarantee in lib/publicProjects/urls.ts. What matters here is that the
    // route asks THAT module rather than hard-coding a host, so the feed's own
    // links move with the cutover instead of needing a second change.
    expect(feedSrc).toContain("from '@/lib/publicProjects/urls'");
    getChangelogFeed.mockResolvedValue(feed);
    const body = await (
      await feedGET(req('/api/public/p/PROD/changelog.xml'), params('PROD'))
    ).text();
    expect(body).toContain('/p/PROD/changelog.xml');
    expect(body).toContain('/p/PROD/items/PROD-3');
  });

  it('reuses the shipped builder rather than reimplementing it', () => {
    // The card's own criterion: the module gains a caller. A route that
    // hand-rolled the XML would pass every behavioural test above and leave the
    // builder orphaned exactly as it was.
    expect(feedSrc).toContain("from '@/lib/publicProjects/atomFeed'");
    expect(feedSrc).toContain('renderAtomFeed(');
  });

  it('answers 404 with a JSON { code } even though the success body is XML', async () => {
    getChangelogFeed.mockRejectedValue(new ProjectNotFoundError('PROD'));

    const res = await feedGET(req('/api/public/p/NOPE/changelog.xml'), params('NOPE'));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ code: 'PROJECT_NOT_FOUND' });
  });

  it('an UNEXPECTED error THROWS — a broken feed is not an empty one', async () => {
    // MOTIR-4120's coverage top-up, and the arm with the worst failure mode on
    // this route: a catch that answered 404 for everything would tell every
    // subscriber the project had been deleted the moment the database blinked,
    // and a feed reader that receives a 404 unsubscribes.
    getChangelogFeed.mockRejectedValue(new Error('the database fell over'));

    await expect(feedGET(req('/api/public/p/PROD/changelog.xml'), params('PROD'))).rejects.toThrow(
      'the database fell over',
    );
  });

  it('names the public URL and the redirect that produces it', () => {
    // The card asks for this in terms, and it is the sentence that stops the
    // next reader inventing a second feed address: a feed URL is copied into
    // readers and outlives every redirect.
    expect(feedSrc).toContain('motir.co/p/<identifier>/changelog.xml');
    expect(feedSrc).toContain('PUBLIC_REDIRECT_SEGMENTS');
  });
});

describe('GET /api/public/projects — the sitemap enumeration', () => {
  it('returns a page and passes the cursor through', async () => {
    listPublicIndex.mockResolvedValue({
      projects: [{ identifier: 'PROD', updatedAt: '2026-08-30T00:00:00.000Z' }],
      nextCursor: 'cmt_next',
    });

    const res = await indexGET(req('/api/public/projects?cursor=cmt_here'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [{ identifier: 'PROD', updatedAt: '2026-08-30T00:00:00.000Z' }],
      nextCursor: 'cmt_next',
    });
    expect(listPublicIndex).toHaveBeenCalledWith('cmt_here');
  });

  it('passes undefined — not null, not an empty string — when there is no cursor', async () => {
    listPublicIndex.mockResolvedValue({ projects: [], nextCursor: null });

    await indexGET(req('/api/public/projects'));

    expect(listPublicIndex).toHaveBeenCalledWith(undefined);
  });

  it('reads no session, and could not use one', () => {
    expect(indexSrc).not.toContain('getSession');
    expect(indexSrc).not.toContain('@/lib/auth');
  });

  it('the walk is ordered by `id`, NOT by `updatedAt` — the property the pager rests on', () => {
    // The one thing about this endpoint that cannot be observed from a single
    // response and is the whole reason it is not built on listPublic(): a walk
    // ordered by updatedAt reshuffles under itself, so a project edited between
    // page one and page two is enumerated twice or skipped, silently. Asserted
    // at the read, because that is where it would be changed.
    const method = repoSrc.slice(repoSrc.indexOf('async listPublicIndexPage'));
    const body = method.slice(0, method.indexOf('\n  },'));
    const orderBy = body.split('\n').filter((line) => line.includes('orderBy:'));
    expect(orderBy).toHaveLength(1);
    expect(orderBy[0]).toContain("id: 'asc'");
    expect(orderBy[0]).not.toContain('updatedAt');
    // updatedAt is still SELECTED — it is the <lastmod>, just not the sort key.
    expect(body).toContain('updatedAt: true');
    // And the cursor seeks on the SAME column it orders by. A keyset cursor on
    // a different column than the sort key is not a cursor, it is a coincidence.
    expect(body).toContain('cursor: { id: cursor }');
  });
});
