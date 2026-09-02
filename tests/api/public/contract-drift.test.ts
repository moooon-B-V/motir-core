import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectCategoriesSchema,
  projectSquarePageSchema,
  publicChangelogPageSchema,
  publicDuplicateMatchesSchema,
  publicFollowStateSchema,
  publicProjectOverviewSchema,
  publicRequestResultSchema,
  publicBoardSchema,
  publicProjectIndexPageSchema,
  publicRequestDetailSchema,
  publicRoadmapColumnPageSchema,
  publicRoadmapSchema,
  publicTreeLevelSchema,
  publicWorkItemDetailSchema,
  publicWorkItemPageSchema,
} from '@/lib/api/public/openapi/schemas';
import { runAsCloudBuild } from '../../helpers/cloudBuild';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

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
const getProjectTreeLevel = vi.hoisted(() => vi.fn());
const getWorkItems = vi.hoisted(() => vi.fn());
const getBoard = vi.hoisted(() => vi.fn());
const getWorkItemDetail = vi.hoisted(() => vi.fn());
const getChangelogFeed = vi.hoisted(() => vi.fn());
const listPublicIndex = vi.hoisted(() => vi.fn());
const getRequestDetail = vi.hoisted(() => vi.fn());
const getRoadmap = vi.hoisted(() => vi.fn());
const getRoadmapColumn = vi.hoisted(() => vi.fn());
const getChangelog = vi.hoisted(() => vi.fn());
const submitPublicRequest = vi.hoisted(() => vi.fn());
const findDuplicateRequests = vi.hoisted(() => vi.fn());
const followAsAccount = vi.hoisted(() => vi.fn());
const unfollowAsAccount = vi.hoisted(() => vi.fn());
const listDirectory = vi.hoisted(() => vi.fn());
const listCategories = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn(async () => null));
const requireCompliantSession = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, session: { user: { id: 'user_1' } } })),
);

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
// The rate limiters are the routes' first act, and they read a store. Passing
// them through (null = "not limited") is what lets this suite be about the WIRE
// rather than about the budget — `tests/rateLimit` owns that.
vi.mock('@/lib/rateLimit/publicWriteGuard', () => ({
  enforcePublicWriteRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/rateLimit/publicFollowGuard', () => ({
  enforcePublicFollowRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/services/publicFollowService', () => ({
  publicFollowService: { followAsAccount, unfollowAsAccount, subscribeByEmail: vi.fn() },
}));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: {
    getOverview,
    getProjectTreeLevel,
    getWorkItems,
    getBoard,
    getWorkItemDetail,
    getRequestDetail,
    getChangelogFeed,
    listPublicIndex,
    getRoadmap,
    getRoadmapColumn,
    getChangelog,
    submitPublicRequest,
    findDuplicateRequests,
  },
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
const { GET: getTree } = await import('@/app/api/public/p/[identifier]/tree/route');
const { GET: getItems } = await import('@/app/api/public/p/[identifier]/items/route');
const { GET: getBoardRoute } = await import('@/app/api/public/p/[identifier]/board/route');
const { GET: getItemDetailRoute } =
  await import('@/app/api/public/p/[identifier]/items/[key]/route');
const { GET: getRequestDetailRoute } =
  await import('@/app/api/public/p/[identifier]/requests/[requestKey]/route');
const { GET: getFeedRoute } = await import('@/app/api/public/p/[identifier]/changelog.xml/route');
const { GET: getProjectIndexRoute } = await import('@/app/api/public/projects/route');
const { GET: getRoadmapRoute } = await import('@/app/api/public/p/[identifier]/roadmap/route');
const { GET: getChangelogRoute } = await import('@/app/api/public/p/[identifier]/changelog/route');
const { POST: postFollow, DELETE: deleteFollow } =
  await import('@/app/api/public/p/[identifier]/follow/route');
const { POST: postSubscribe } = await import('@/app/api/public/p/[identifier]/subscribe/route');
const { POST: postRequest } = await import('@/app/api/public/projects/[projectId]/requests/route');
const { GET: getDuplicates } =
  await import('@/app/api/public/projects/[projectId]/requests/duplicates/route');

/** Every `/p/{identifier}` route takes the same params promise. */
const identifierParams = { params: Promise.resolve({ identifier: 'ACME' }) };
const projectIdParams = { params: Promise.resolve({ projectId: 'proj_1' }) };
const url = (path: string) => new Request(`https://app.motir.co${path}`);
const post = (path: string, body?: unknown) =>
  new Request(`https://app.motir.co${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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

  // ── MOTIR-3990: the same check over the remaining nine ────────────────────

  const treeRow = {
    id: 'wi_1',
    identifier: 'ACME-1',
    key: 1,
    title: 'A row',
    kind: 'story' as const,
    status: 'in_progress',
    statusCategory: 'in_progress' as const,
    priority: 'high' as const,
    parentId: null,
    hasChildren: true,
  };

  it('GET /api/public/p/{identifier}/tree', async () => {
    getProjectTreeLevel.mockResolvedValue({ rows: [treeRow], hasMore: false, total: 1 });
    const res = await getTree(url('/api/public/p/ACME/tree'), identifierParams);
    expect(publicTreeLevelSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/p/{identifier}/items', async () => {
    const { parentId: _p, hasChildren: _h, ...listRow } = treeRow;
    getWorkItems.mockResolvedValue({ items: [listRow], nextCursor: null });
    const res = await getItems(url('/api/public/p/ACME/items'), identifierParams);
    expect(publicWorkItemPageSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/p/{identifier}/roadmap', async () => {
    getRoadmapColumn.mockResolvedValue({
      bucket: 'planned',
      cards: [
        {
          id: 'wi_2',
          identifier: 'ACME-2',
          key: 2,
          title: 'A card',
          kind: 'task',
          voteCount: 3,
          voted: false,
        },
      ],
      nextCursor: null,
    });
    const res = await getRoadmapRoute(
      url('/api/public/p/ACME/roadmap?bucket=planned&cursor=abc'),
      identifierParams,
    );
    expect(publicRoadmapColumnPageSchema.parse(await res.json())).toBeTruthy();
  });

  // ── MOTIR-4109: the board, and the roadmap's OTHER arm ────────────────────
  //
  // The roadmap operation now declares a UNION, so both arms are driven here.
  // One arm passing proves nothing about the other — they are different service
  // calls returning different shapes down one path, which is exactly the
  // configuration a drift guard is for.

  it('GET /api/public/p/{identifier}/roadmap — with NEITHER parameter, the whole tab', async () => {
    getRoadmap.mockResolvedValue({
      columns: [
        {
          key: 'planned',
          totalCount: 4,
          cards: [
            {
              id: 'wi_2',
              identifier: 'ACME-2',
              key: 2,
              title: 'A card',
              kind: 'task',
              voteCount: 3,
              voted: false,
            },
          ],
          nextCursor: 'next',
        },
      ],
    });
    const res = await getRoadmapRoute(url('/api/public/p/ACME/roadmap'), identifierParams);
    expect(res.status).toBe(200);
    expect(publicRoadmapSchema.parse(await res.json())).toBeTruthy();
    expect(getRoadmapColumn).not.toHaveBeenCalled();
  });

  it('GET /api/public/p/{identifier}/board', async () => {
    getBoard.mockResolvedValue({
      boardId: 'board_1',
      name: 'Delivery',
      columns: [
        {
          id: 'col_1',
          name: 'In progress',
          statusKeys: ['in_progress'],
          cards: [
            {
              id: 'wi_4',
              identifier: 'ACME-4',
              key: 4,
              title: 'A board card',
              kind: 'task',
              status: 'in_progress',
              statusCategory: 'in_progress',
              priority: 'medium',
            },
          ],
          totalCount: 12,
        },
      ],
      cap: 200,
      truncated: true,
    });
    const res = await getBoardRoute(url('/api/public/p/ACME/board'), identifierParams);
    expect(res.status).toBe(200);
    expect(publicBoardSchema.parse(await res.json())).toBeTruthy();
  });

  // ── MOTIR-4110: the two detail reads ─────────────────────────────────────

  it('GET /api/public/p/{identifier}/items/{key}', async () => {
    getWorkItemDetail.mockResolvedValue({
      id: 'wi_6',
      identifier: 'ACME-6',
      key: 6,
      title: 'A work item',
      kind: 'task',
      status: 'in_progress',
      statusLabel: 'In progress',
      statusCategory: 'in_progress',
      descriptionMd: '## Body',
      parent: { identifier: 'ACME-1', key: 1, title: 'A parent', kind: 'epic' },
      childrenHidden: false,
      childCount: 2,
      children: [
        {
          id: 'wi_7',
          identifier: 'ACME-7',
          key: 7,
          title: 'A child',
          kind: 'subtask',
          status: 'todo',
          statusCategory: 'todo',
          priority: 'low',
          parentId: 'wi_6',
          hasChildren: false,
        },
      ],
      childrenHasMore: true,
    });
    const res = await getItemDetailRoute(url('/api/public/p/ACME/items/ACME-6'), {
      params: Promise.resolve({ identifier: 'ACME', key: 'ACME-6' }),
    });
    expect(res.status).toBe(200);
    expect(publicWorkItemDetailSchema.parse(await res.json())).toBeTruthy();
    // The route passes the segment through UNCHANGED — it does not rebuild the
    // identifier from the project key and a number.
    expect(getWorkItemDetail).toHaveBeenCalledWith('ACME', 'ACME-6', null);
  });

  it('a ROOT item and a HIDDEN epic both parse — null parent, and the marker', async () => {
    getWorkItemDetail.mockResolvedValue({
      id: 'wi_8',
      identifier: 'ACME-8',
      key: 8,
      title: 'A private epic',
      kind: 'epic',
      status: 'todo',
      statusLabel: 'To do',
      statusCategory: 'todo',
      descriptionMd: null,
      parent: null,
      childrenHidden: true,
      childCount: 0,
      children: [],
      childrenHasMore: false,
    });
    const res = await getItemDetailRoute(url('/api/public/p/ACME/items/ACME-8'), {
      params: Promise.resolve({ identifier: 'ACME', key: 'ACME-8' }),
    });
    expect(publicWorkItemDetailSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/p/{identifier}/requests/{requestKey}', async () => {
    getRequestDetail.mockResolvedValue({
      id: 'wi_9',
      identifier: 'ACME-9',
      key: 9,
      title: 'A feature request',
      kind: 'task',
      status: 'open',
      statusLabel: 'Open',
      statusCategory: 'todo',
      descriptionMd: 'Please build this',
      openedByName: 'A Reader',
      createdAt: '2026-08-30T00:00:00.000Z',
      voteCount: 12,
      voted: false,
      comments: [
        {
          id: 'c_1',
          workItemId: 'wi_9',
          parentCommentId: null,
          author: { id: 'u_1', name: 'A Reader', image: null },
          bodyMd: 'Me too',
          editedAt: null,
          createdAt: '2026-08-30T01:00:00.000Z',
          mentionedUserIds: [],
        },
      ],
    });
    const res = await getRequestDetailRoute(url('/api/public/p/ACME/requests/ACME-9'), {
      params: Promise.resolve({ identifier: 'ACME', requestKey: 'ACME-9' }),
    });
    expect(res.status).toBe(200);
    expect(publicRequestDetailSchema.parse(await res.json())).toBeTruthy();
    expect(getRequestDetail).toHaveBeenCalledWith('ACME', 'ACME-9', null);
  });

  it('the request thread admits a REPLY — parentCommentId is not always null', async () => {
    getRequestDetail.mockResolvedValue({
      id: 'wi_9',
      identifier: 'ACME-9',
      key: 9,
      title: 'A feature request',
      kind: 'task',
      status: 'open',
      statusLabel: 'Open',
      statusCategory: 'todo',
      descriptionMd: null,
      openedByName: 'A Reader',
      createdAt: '2026-08-30T00:00:00.000Z',
      voteCount: 0,
      voted: false,
      comments: [
        {
          id: 'c_2',
          workItemId: 'wi_9',
          parentCommentId: 'c_1',
          author: { id: 'u_2', name: 'Someone', image: 'https://cdn.test/a.png' },
          bodyMd: 'Agreed',
          editedAt: '2026-08-30T02:00:00.000Z',
          createdAt: '2026-08-30T01:30:00.000Z',
          mentionedUserIds: [],
        },
      ],
    });
    const res = await getRequestDetailRoute(url('/api/public/p/ACME/requests/ACME-9'), {
      params: Promise.resolve({ identifier: 'ACME', requestKey: 'ACME-9' }),
    });
    expect(publicRequestDetailSchema.parse(await res.json())).toBeTruthy();
  });

  // ── MOTIR-4111: the crawl surface ────────────────────────────────────────

  it('GET /api/public/projects', async () => {
    listPublicIndex.mockResolvedValue({
      projects: [
        { identifier: 'ACME', updatedAt: '2026-08-30T00:00:00.000Z' },
        { identifier: 'OPEN-CORE', updatedAt: '2026-08-29T00:00:00.000Z' },
      ],
      nextCursor: 'cmt_last',
    });
    const res = await getProjectIndexRoute(url('/api/public/projects'));
    expect(res.status).toBe(200);
    expect(publicProjectIndexPageSchema.parse(await res.json())).toBeTruthy();
  });

  it('the LAST page parses too — a null cursor is a declared value, not an absence', async () => {
    listPublicIndex.mockResolvedValue({ projects: [], nextCursor: null });
    const res = await getProjectIndexRoute(url('/api/public/projects?cursor=cmt_x'));
    expect(publicProjectIndexPageSchema.parse(await res.json())).toBeTruthy();
    expect(listPublicIndex).toHaveBeenCalledWith('cmt_x');
  });

  it('GET /api/public/p/{identifier}/changelog.xml is ATOM, not JSON', async () => {
    // The one operation on this surface whose CONTENT TYPE is part of the
    // contract. A drift guard that only parsed the body would pass on a route
    // that had silently started answering JSON.
    getChangelogFeed.mockResolvedValue({
      project: { identifier: 'ACME', name: 'Acme & Co' },
      entries: [
        {
          identifier: 'ACME-3',
          key: 3,
          title: 'Shipped <something>',
          kind: 'task',
          status: 'done',
          priority: 'medium',
          shippedAt: '2026-08-30T00:00:00.000Z',
          epic: null,
          descriptionMd: 'A body',
        },
      ],
    });
    const res = await getFeedRoute(url('/api/public/p/ACME/changelog.xml'), identifierParams);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');

    const body = await res.text();
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    // The escaping the builder exists for, driven through the ROUTE rather than
    // through the builder's own unit test: an unescaped ampersand or angle
    // bracket makes the document malformed, and a reader rejects the WHOLE feed
    // rather than the one entry.
    expect(body).toContain('Acme &amp; Co');
    expect(body).toContain('Shipped &lt;something&gt;');
    expect(body).not.toMatch(/<title>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('the board carries the epic-privacy MARKER, and the schema admits it', async () => {
    // `childrenHidden` is optional and present only on a private epic's row seen
    // by a non-member. A `.strict()` schema that forgot it would reject exactly
    // the payload the public projection exists to produce.
    getBoard.mockResolvedValue({
      boardId: 'board_1',
      name: 'Delivery',
      columns: [
        {
          id: 'col_1',
          name: 'To do',
          statusKeys: ['todo'],
          cards: [
            {
              id: 'wi_5',
              identifier: 'ACME-5',
              key: 5,
              title: 'A private epic',
              kind: 'epic',
              status: 'todo',
              statusCategory: 'todo',
              priority: 'high',
              childrenHidden: true,
            },
          ],
          totalCount: 1,
        },
      ],
      cap: 200,
      truncated: false,
    });
    const res = await getBoardRoute(url('/api/public/p/ACME/board'), identifierParams);
    expect(publicBoardSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/p/{identifier}/changelog', async () => {
    getChangelog.mockResolvedValue({
      entries: [
        {
          identifier: 'ACME-3',
          key: 3,
          title: 'Shipped',
          kind: 'task',
          status: 'done',
          priority: 'medium',
          shippedAt: '2026-08-30T00:00:00.000Z',
          epic: { identifier: 'ACME-9', title: 'An epic' },
        },
      ],
      nextCursor: null,
    });
    const res = await getChangelogRoute(url('/api/public/p/ACME/changelog'), identifierParams);
    expect(publicChangelogPageSchema.parse(await res.json())).toBeTruthy();
  });

  const followState = {
    following: true,
    digestOptIn: false,
    followerCount: 12,
    digestAvailable: true,
  };

  it('POST /api/public/p/{identifier}/follow', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_1' } } as never);
    followAsAccount.mockResolvedValue(followState);
    const res = await postFollow(post('/api/public/p/ACME/follow'), identifierParams);
    expect(publicFollowStateSchema.parse(await res.json())).toBeTruthy();
    getSession.mockResolvedValue(null as never);
  });

  it('DELETE /api/public/p/{identifier}/follow', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_1' } } as never);
    unfollowAsAccount.mockResolvedValue({ ...followState, following: false });
    const res = await deleteFollow(
      new Request('https://app.motir.co/api/public/p/ACME/follow', { method: 'DELETE' }),
      identifierParams,
    );
    expect(publicFollowStateSchema.parse(await res.json())).toBeTruthy();
    getSession.mockResolvedValue(null as never);
  });

  it('POST /api/public/p/{identifier}/subscribe answers 202 with NO body, as declared', async () => {
    // The one operation whose declared response is `null`, and the assertion is
    // that there is nothing to parse: a body here would be a shape no consumer
    // was told about, and — worse — the beginning of an oracle.
    const res = await postSubscribe(
      post('/api/public/p/ACME/subscribe', { email: 'reader@example.test' }),
      identifierParams,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('POST /api/public/projects/{projectId}/requests answers 201 with the allocated item', async () => {
    submitPublicRequest.mockResolvedValue({
      id: 'wi_4',
      kind: 'bug',
      identifier: 'ACME-4',
      title: 'It breaks',
    });
    const res = await postRequest(
      post('/api/public/projects/proj_1/requests', { kind: 'bug', title: 'It breaks' }),
      projectIdParams,
    );
    expect(res.status).toBe(201);
    expect(publicRequestResultSchema.parse(await res.json())).toBeTruthy();
  });

  it('GET /api/public/projects/{projectId}/requests/duplicates', async () => {
    findDuplicateRequests.mockResolvedValue({
      candidates: [
        {
          id: 'wi_5',
          kind: 'bug',
          identifier: 'ACME-5',
          title: 'It breaks',
          status: 'triage',
          voteCount: 1,
        },
      ],
    });
    const res = await getDuplicates(
      url('/api/public/projects/proj_1/requests/duplicates?title=It%20breaks'),
      projectIdParams,
    );
    expect(publicDuplicateMatchesSchema.parse(await res.json())).toBeTruthy();
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
