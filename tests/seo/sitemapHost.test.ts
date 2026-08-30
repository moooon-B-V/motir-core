import { describe, expect, it, vi } from 'vitest';

// MOTIR-3881 — a sitemap is HOST-SCOPED, and this one had no test saying so.
//
// `app/sitemap.ts` used to build every entry from `publicSiteOrigin()`, which
// was the same value as the application's own origin. After MOTIR-3881 splits
// them they are different hosts, and a sitemap at `app.motir.co/sitemap.xml`
// listing `motir.co` URLs is a cross-submission — honoured only from a property
// verified for both, and wrong here regardless, because this application is what
// serves these pages until MOTIR-3951 deletes them.
//
// The failure this guards is silent in the worst way: nothing throws, no page
// breaks, and a crawler is simply handed another host's URLs from this host's
// file. It is only observable when the two origins DIFFER, which is a state no
// environment is in today — so the test is the only place the difference exists.

const listPublicForSitemap = vi.hoisted(() => vi.fn());
const listCategories = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { listPublicForSitemap },
}));
vi.mock('@/lib/services/projectTagsService', () => ({
  projectTagsService: { listCategories },
}));

const { default: sitemap } = await import('@/app/sitemap');

const APP = 'https://app.motir.co';
const PUBLIC_SITE = 'https://motir.co';

describe('app/sitemap.ts is scoped to the host that serves it', () => {
  it('lists ONLY application-host URLs, even when the public origin is configured elsewhere', async () => {
    vi.stubEnv('MOTIR_BASE_URL', APP);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', PUBLIC_SITE);
    listPublicForSitemap.mockResolvedValue([{ identifier: 'ACME', updatedAt: new Date() }]);
    listCategories.mockResolvedValue([{ slug: 'design' }]);

    const entries = await sitemap();

    expect(entries.length).toBeGreaterThan(0);
    const origins = [...new Set(entries.map((e) => new URL(e.url).origin))];
    expect(origins).toEqual([APP]);
    // …and the public HOST appears nowhere in it. Compared as a parsed host
    // rather than a string prefix: `js/incomplete-url-substring-sanitization`
    // is a HIGH CodeQL alert on the substring form even in a test, and the host
    // is the stricter claim anyway — a prefix test would also pass a URL that
    // merely mentioned the origin in a path or query.
    const hosts = entries.map((e) => new URL(e.url).host);
    expect(hosts).not.toContain(new URL(PUBLIC_SITE).host);
  });

  it('still covers the whole surface — the host swap did not drop entries', async () => {
    vi.stubEnv('MOTIR_BASE_URL', APP);
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);
    listPublicForSitemap.mockResolvedValue([{ identifier: 'ACME', updatedAt: new Date() }]);
    listCategories.mockResolvedValue([{ slug: 'design' }]);

    const urls = (await sitemap()).map((e) => e.url);

    // the square, its ranked variants, the topic page, the project and its tabs
    expect(urls).toContain(`${APP}/explore`);
    expect(urls).toContain(`${APP}/explore?rank=popular`);
    expect(urls).toContain(`${APP}/explore/topic/design`);
    expect(urls).toContain(`${APP}/p/ACME`);
    for (const tab of ['board', 'items', 'tree', 'roadmap', 'changelog']) {
      expect(urls).toContain(`${APP}/p/ACME/${tab}`);
    }
  });

  it('percent-encodes an identifier inside the composed URL', async () => {
    vi.stubEnv('MOTIR_BASE_URL', APP);
    listPublicForSitemap.mockResolvedValue([{ identifier: 'a b/c', updatedAt: new Date() }]);
    listCategories.mockResolvedValue([]);

    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain(`${APP}/p/a%20b%2Fc`);
  });
});
