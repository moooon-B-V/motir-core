import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectCategoriesSchema,
  projectSquarePageSchema,
  publicProjectOverviewSchema,
} from '@/lib/api/public/openapi/schemas';

// ⚠️ THE DRIFT GUARD, AND IT RUNS IN THIS REPOSITORY'S CI (MOTIR-3946).
//
// That placement is the whole point. A contract test living in the CONSUMER
// tells `motir-marketing` that `motir-core` broke it, after it has shipped —
// a smoke alarm in the wrong building. This one fails on the pull request that
// changes a response shape, in the repository making the change, naming the
// surface a second repository renders from.
//
// HOW IT CATCHES DRIFT: each route is called for real, with only its SERVICE
// mocked, and the response is parsed through the schema the document publishes.
// Every schema is `.strict()`, so a field ADDED to a DTO and returned by a route
// fails here rather than reaching a consumer undeclared; a field REMOVED fails
// too. The failure names the field.
//
// What it deliberately does NOT do is assert the service's own behaviour —
// that belongs to the service's tests. This is about the WIRE.

const getOverview = vi.hoisted(() => vi.fn());
const listDirectory = vi.hoisted(() => vi.fn());
const listCategories = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getOverview },
}));
vi.mock('@/lib/services/projectSquareService', () => ({
  projectSquareService: { listDirectory },
}));
vi.mock('@/lib/services/projectTagsService', () => ({
  projectTagsService: { listCategories },
}));

const { GET: getSubject } = await import('@/app/api/public/p/[identifier]/route');
const { GET: getExplore } = await import('@/app/api/public/explore/route');
const { GET: getCategories } = await import('@/app/api/public/categories/route');

afterEach(() => vi.clearAllMocks());

/** A DTO shaped exactly as the service returns one. */
const overview = {
  id: 'proj_1',
  name: 'Acme',
  identifier: 'ACME',
  workspaceName: 'Acme Inc',
  publicOverviewMd: '# Hello',
  publicTagline: null,
  publicTags: ['design'],
  stats: { publicRequests: 2, upvotes: 5, planned: 1, shipped: 3, inProgress: 0 },
  links: { website: 'https://acme.test' },
  viewerCanManage: false,
};

const page = {
  items: [
    {
      identifier: 'ACME',
      name: 'Acme',
      org: { name: 'Acme Inc', slug: 'acme' },
      description: null,
      stats: { upvotes: 5, lastActivityAt: '2026-08-30T00:00:00.000Z' },
    },
  ],
  nextCursor: null,
};

describe('the published schema matches what the route actually returns', () => {
  it('GET /api/public/p/{identifier}', async () => {
    getOverview.mockResolvedValue(overview);
    const res = await getSubject(new Request('https://app.motir.co/api/public/p/ACME'), {
      params: Promise.resolve({ identifier: 'ACME' }),
    });
    expect(publicProjectOverviewSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/explore', async () => {
    listDirectory.mockResolvedValue(page);
    const res = await getExplore(new Request('https://app.motir.co/api/public/explore'));
    expect(projectSquarePageSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/categories', async () => {
    listCategories.mockResolvedValue([{ slug: 'design', label: 'Design', projectCount: 3 }]);
    // No request parameter: the handler takes none — the categories facet has no
    // inputs at all, which is itself part of what the document declares.
    const res = await getCategories();
    expect(projectCategoriesSchema.parse(await res.json())).toBeTruthy();
  });

  // ── the guard proving the guard ──────────────────────────────────────────
  //
  // Without these two, every schema above could be permissive and each
  // assertion would still pass. `.strict()` is the property under test.
  it('FAILS when a route returns an undeclared field — the drift this exists to catch', async () => {
    getOverview.mockResolvedValue({ ...overview, secretInternalFlag: true });
    const res = await getSubject(new Request('https://app.motir.co/api/public/p/ACME'), {
      params: Promise.resolve({ identifier: 'ACME' }),
    });
    const body = await res.json();
    expect(() => publicProjectOverviewSchema.parse(body)).toThrowError(
      /secretInternalFlag|unrecognized/i,
    );
  });

  it('FAILS when a declared field disappears', async () => {
    const { publicTags: _dropped, ...without } = overview;
    getOverview.mockResolvedValue(without);
    const res = await getSubject(new Request('https://app.motir.co/api/public/p/ACME'), {
      params: Promise.resolve({ identifier: 'ACME' }),
    });
    const body = await res.json();
    expect(() => publicProjectOverviewSchema.parse(body)).toThrowError(/publicTags/i);
  });
});
