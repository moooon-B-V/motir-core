// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// MOTIR-3435 — `/items/[key]`'s GATE, its read SHAPE, and its pending frame.
//
// The page went from 29 awaits, almost all sequential, to a gate of four plus
// one concurrent group. What is asserted here is the pair of properties that
// restructuring can break silently, and that a green diff looks fine under:
//
//   1. THE GATE IS STILL IN FRONT OF EVERYTHING. `getSession` → `getActiveProject`
//      → `getIssueDetail` → `getPermissions`, in that order, with NO other read
//      started until all four have settled. This page is where the product's
//      access rules are enforced — a missing item, a browse-denied item and an
//      item under a retired project key all resolve BEFORE anything renders — so
//      a read that starts early is how a hidden item becomes visible for a
//      frame. Nothing type-checks differently if one moves.
//
//   2. THE GROUP IS ACTUALLY CONCURRENT, and its conditional members are STILL
//      conditional. Skipping a query is cheaper than parallelising it, so
//      `acceptance*` must not run for a non-story and `rollupForParent` must not
//      run for a leaf — a restructure that "simplifies" a ternary away would
//      make every leaf page pay a recursive-CTE aggregate.
//
// Everything the page imports is mocked at module level, so `lib/db` and the
// service tree never load. The page is an async Server Component — a function
// returning JSX — so it is CALLED, not rendered.

const started: string[] = [];
let release: (() => void) | null = null;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
/** Resolves only when the test lets it, and records that it STARTED. */
const deferred = <T,>(name: string, value: T) =>
  vi.fn(async () => {
    started.push(name);
    await gate;
    return value;
  });
/** Resolves immediately; still records the start. */
const immediate = <T,>(name: string, value: T) =>
  vi.fn(async () => {
    started.push(name);
    return value;
  });

const redirected = vi.fn((_to: string) => {
  throw new Error('NEXT_REDIRECT');
});
const notFoundFn = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const permanentRedirected = vi.fn((_to: string) => {
  throw new Error('NEXT_PERMANENT_REDIRECT');
});

const getSession = vi.fn();
const getActiveProject = vi.fn();
const getIssueDetail = vi.fn();
const getPermissions = vi.fn();
const resolveAliasedIssueKey = vi.fn(async () => null as string | null);

const rollupForParent = deferred('rollup', null);
const acceptanceResolve = deferred('acceptanceEligibility', null);
const acceptanceEvidence = deferred('acceptanceEvidence', null);

vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirected(to),
  notFound: () => notFoundFn(),
  permanentRedirect: (to: string) => permanentRedirected(to),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: immediate('t', (k: string) => k),
  getLocale: immediate('locale', 'en'),
}));
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/projects', () => ({ getActiveProject: () => getActiveProject() }));
vi.mock('@/lib/issues/aliasRedirect', () => ({
  resolveAliasedIssueKey: () => resolveAliasedIssueKey(),
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: {
    getIssueDetail: () => getIssueDetail(),
    listLinkedPullRequests: deferred('pullRequests', []),
    listRepoDelivery: deferred('repoDelivery', []),
    resolveReferenceSummaries: deferred('workItemRefs', []),
  },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    getPermissions: () => getPermissions(),
    getCommentCapabilities: deferred('commentCaps', {}),
    getAttachmentCapabilities: deferred('attachmentCaps', {}),
  },
}));
vi.mock('@/lib/services/assignableMembersService', () => ({
  assignableMembersService: { list: deferred('members', []) },
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: { listByProject: deferred('sprints', []) },
}));
vi.mock('@/lib/services/commentsService', () => ({
  commentsService: { listComments: deferred('comments', null) },
}));
vi.mock('@/lib/services/attachmentsService', () => ({
  attachmentsService: { listForWorkItem: deferred('attachments', null) },
}));
vi.mock('@/lib/services/acceptanceEvidenceService', () => ({
  acceptanceEvidenceService: { getCurrentForStory: () => acceptanceEvidence() },
}));
vi.mock('@/lib/services/acceptanceVideoEligibilityService', () => ({
  acceptanceVideoEligibilityService: { resolve: () => acceptanceResolve() },
}));
vi.mock('@/lib/services/designEvidenceService', () => ({
  designEvidenceService: { getCurrentForWorkItem: deferred('designEvidence', null) },
}));
vi.mock('@/lib/services/estimationService', () => ({
  estimationService: {
    getEstimationConfig: deferred('estimationConfig', {}),
    rollupForParent: () => rollupForParent(),
  },
}));
vi.mock('@/lib/services/componentsService', () => ({
  componentsService: { listComponents: deferred('components', []) },
}));
vi.mock('@/lib/services/activityService', () => ({
  activityService: {
    listHistory: deferred('history', null),
    listAll: deferred('all', null),
  },
}));
vi.mock('@/lib/mentions/workItemRefs', () => ({ parseWorkItemRefs: () => [] }));
vi.mock('@/lib/utils/datetime', () => ({ formatDate: () => '' }));
vi.mock('@/lib/workItems/errors', () => ({ WorkItemNotFoundError: class extends Error {} }));
vi.mock('@/lib/projects/errors', () => ({ ProjectAccessDeniedError: class extends Error {} }));

// The JSX tree: imported, never executed.
vi.mock('@/components/issues/EstimationConfigProvider', () => ({
  EstimationConfigProvider: () => null,
}));
vi.mock('@/components/issues/ParentRollupBadge', () => ({ ParentRollupBadge: () => null }));
vi.mock('@/components/issues/IssueTypeIcon', () => ({ IssueTypeIcon: () => null }));
vi.mock('@/components/planning/WorkItemPlanEntrance', () => ({ WorkItemPlanEntrance: () => null }));
vi.mock('@/components/ui/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/components/ui/MarkdownView', () => ({ MarkdownView: () => null }));
vi.mock('@/components/ui/Pill', () => ({ Pill: () => null }));
vi.mock('@/components/markdown/WorkItemTitle', () => ({ WorkItemTitle: () => null }));

import ItemDetailLoading from '@/app/(authed)/items/[key]/loading';

const PROJECT = {
  projectId: 'p1',
  userId: 'u1',
  workspaceId: 'w1',
  project: { identifier: 'MOTIR', accessLevel: 'private' },
};
const detailFor = (over: Record<string, unknown> = {}) => ({
  item: {
    id: 'i1',
    identifier: 'MOTIR-1',
    kind: 'subtask',
    type: 'code',
    status: 'todo',
    title: 't',
    descriptionMd: null,
    explanationMd: null,
    archivedAt: null,
    targetRepos: [],
    ...over,
  },
  children: [],
  workflow: { statuses: [] },
  ancestors: [],
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  duplicates: [],
  clones: [],
  readiness: {},
});

beforeEach(() => {
  started.length = 0;
  redirected.mockClear();
  notFoundFn.mockClear();
  getSession.mockReset();
  getActiveProject.mockReset();
  getIssueDetail.mockReset();
  getPermissions.mockReset();
  rollupForParent.mockClear();
  acceptanceResolve.mockClear();
  acceptanceEvidence.mockClear();
});
afterEach(() => {
  release?.();
  cleanup();
});

const callPage = async (over: Record<string, unknown> = {}) => {
  const { default: IssueDetailPage } = await import('@/app/(authed)/items/[key]/page');
  return IssueDetailPage({
    params: Promise.resolve({ key: 'MOTIR-1' }),
    searchParams: Promise.resolve({}),
    ...over,
  } as never);
};

describe('the item-detail gate stays in front of every read (MOTIR-3435)', () => {
  it('redirects an unauthenticated request before starting anything', async () => {
    getSession.mockResolvedValue(null);
    await expect(callPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirected).toHaveBeenCalledWith('/sign-in');
    expect(started.filter((s) => s !== 't')).toEqual([]);
  });

  it('404s a missing or browse-denied item without starting a single page read', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    const { WorkItemNotFoundError } = await import('@/lib/workItems/errors');
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('nope'));

    await expect(callPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundFn).toHaveBeenCalled();
    // The permission read never ran, and neither did anything after it: a 404
    // must not be distinguishable from a denial by what the server did.
    expect(getPermissions).not.toHaveBeenCalled();
    expect(started.filter((s) => !['t', 'locale'].includes(s))).toEqual([]);
  });

  it('308-redirects an item under a retired project key', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    const { WorkItemNotFoundError } = await import('@/lib/workItems/errors');
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('nope'));
    resolveAliasedIssueKey.mockResolvedValueOnce('NIF-7');

    await expect(callPage()).rejects.toThrow('NEXT_PERMANENT_REDIRECT');
    expect(permanentRedirected).toHaveBeenCalledWith('/items/NIF-7');
    expect(getPermissions).not.toHaveBeenCalled();
  });
});

describe('the remaining reads run CONCURRENTLY (MOTIR-3435)', () => {
  it('starts them all before any resolves — a Promise.all, not a chain', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['work_item:edit']));

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the gate's own
    // four awaits resolve on the microtask queue and counting them would couple
    // this test to how many `await`s the gate happens to have.
    await new Promise((r) => setTimeout(r, 0));

    // Every non-conditional member of the group is in flight while NONE has
    // resolved. Serialised awaits would show exactly one.
    for (const name of [
      'pullRequests',
      'repoDelivery',
      'members',
      'sprints',
      'commentCaps',
      'attachmentCaps',
      'attachments',
      'designEvidence',
      'components',
      'estimationConfig',
      'workItemRefs',
    ]) {
      expect(started, `${name} should already be in flight`).toContain(name);
    }

    release?.();
    await pending.catch(() => undefined);
  });

  it('keeps the CONDITIONAL reads conditional — a leaf subtask pays neither', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor()); // subtask, todo, no children
    getPermissions.mockResolvedValue(new Set());

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the gate's own
    // four awaits resolve on the microtask queue and counting them would couple
    // this test to how many `await`s the gate happens to have.
    await new Promise((r) => setTimeout(r, 0));

    // Not a story at in_review/done → no acceptance reads at all.
    expect(acceptanceResolve).not.toHaveBeenCalled();
    expect(acceptanceEvidence).not.toHaveBeenCalled();
    // No children → no recursive-CTE roll-up. Parallelising this instead of
    // skipping it would make every leaf page pay for it.
    expect(rollupForParent).not.toHaveBeenCalled();

    release?.();
    await pending.catch(() => undefined);
  });

  it('runs the acceptance pair for a story in review, and the roll-up for a parent', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue({
      ...detailFor({ kind: 'story', status: 'in_review' }),
      children: [{ id: 'c1' }],
    });
    getPermissions.mockResolvedValue(new Set());

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the gate's own
    // four awaits resolve on the microtask queue and counting them would couple
    // this test to how many `await`s the gate happens to have.
    await new Promise((r) => setTimeout(r, 0));

    expect(acceptanceResolve).toHaveBeenCalled();
    expect(acceptanceEvidence).toHaveBeenCalled();
    expect(rollupForParent).toHaveBeenCalled();

    release?.();
    await pending.catch(() => undefined);
  });
});

describe('the route-shaped pending frame (MOTIR-3435)', () => {
  it('composes PageSkeleton — one reveal, one wrapper, no second title box', () => {
    const { container } = renderWithIntl(<ItemDetailLoading />);
    const frame = container.querySelector('[data-testid="page-skeleton"]');
    expect(frame).not.toBeNull();
    // The shared reveal, referenced not re-declared. Exactly one frame element.
    expect(frame!.className).toContain('nav-pending-reveal');
    expect(container.querySelectorAll('.nav-pending-reveal').length).toBe(1);
    expect(frame!.getAttribute('aria-busy')).toBe('true');
  });

  it('draws the eyebrow ABOVE the title, and no toolbar row', () => {
    const { container } = renderWithIntl(<ItemDetailLoading />);
    const header = container.querySelector('header')!;
    // eyebrow row + title block — and NO subtitle: this page's <h1> has no <p>
    // under it, so reserving one would settle the page 20px up.
    expect(header.children.length).toBe(2);
    expect(header.className).toContain('gap-2');
    // The generic toolbar band is suppressed: this page's controls live in the
    // eyebrow's right cluster, so a reserved band would never be filled.
    expect(container.querySelectorAll('.h-\\(--height-control\\)').length).toBe(3);
  });

  it('carries the page’s OWN two-column declaration, so it collapses identically', () => {
    const { container } = renderWithIntl(<ItemDetailLoading />);
    const grid = container.querySelector('.grid')!;
    // Not a copy of the measurements — the same declaration, so the narrow
    // breakpoint needs no second frame.
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('md:grid-cols-[1fr_18rem]');
    expect(container.querySelector('aside')).not.toBeNull();
  });
});
