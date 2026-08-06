// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `/planning` host page's SERVER half (Bug MOTIR-2069). The workspace used
// to paint nothing until the roadmap read resolved: the page awaited BOTH data
// reads — serially — before returning a single element, on a segment with no
// instant-loading UI, so Next.js held the navigation on the previous surface and
// the whole populated workspace then appeared at once.
//
// The root read turned out to be REDUNDANT as well as blocking — the canvas
// reads the same root level itself — so it is gone rather than deferred, and
// the anchor lookup is the page's only remaining read.
//
// These lock in the inversion and, just as importantly, the line it must not
// cross: the ACCESS gates still run ahead of the paint. The page is easy to
// "helpfully" re-grow a `const roots = await …`, which is exactly the defect —
// and equally easy to over-correct by pushing the capability check down to get
// the shell out earlier, which would flash a workspace frame at an actor who
// cannot browse the project.
//
// `getProjectRoadmap` is mocked and given a happy value deliberately: the guard
// is that the page never calls it EVEN WHEN it would succeed.

const {
  getSession,
  getActiveProject,
  getSettingsCapabilities,
  getProjectRoadmap,
  getWorkItemWithAncestors,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getSettingsCapabilities: vi.fn(),
  getProjectRoadmap: vi.fn(),
  getWorkItemWithAncestors: vi.fn(),
}));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getSettingsCapabilities },
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { getProjectRoadmap, getWorkItemWithAncestors },
}));

import PlanningWorkspacePage from '@/app/(planning)/planning/page';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: {
    identifier: 'ACME',
    name: 'Acme',
    onboardingRanAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

/** A promise the test releases by hand — a read still in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function render(searchParams: Record<string, string> = {}) {
  return PlanningWorkspacePage({ searchParams: Promise.resolve(searchParams) });
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  // The page reads all three capabilities from ONE call (MOTIR-2250):
  // `canBrowse` gates the paint, `canManage` gates the audit-coverage banner.
  getSettingsCapabilities.mockResolvedValue({ canBrowse: true, canEdit: true, canManage: false });
  getProjectRoadmap.mockResolvedValue({ nodes: [{ id: 'wi1' }] });
  // The LINEAGE read (MOTIR-2070) replaced the bare identifier resolve: the
  // canvas's arrival level needs the anchor's ancestors, so the page asks for
  // both in the one gated read rather than adding a second.
  getWorkItemWithAncestors.mockResolvedValue({
    item: { id: 'wi_9', identifier: 'ACME-9', title: 'Billing', kind: 'story' },
    ancestors: [{ id: 'wi_1', identifier: 'ACME-1', title: 'Platform' }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the workspace opens BEFORE any canvas data (MOTIR-2069)', () => {
  it('reads NO roadmap data at all — the read that held the paint is gone', async () => {
    const element = await render();

    // The whole defect in one assertion. The page used to await
    // `getProjectRoadmap` to compute a `hasItems` boolean before it could
    // return a single element; now it never calls it. The canvas reads that
    // same root level itself, so this was a duplicate read AND the thing
    // standing between the click and the paint.
    expect(getProjectRoadmap).not.toHaveBeenCalled();
    expect(element.props).not.toHaveProperty('hasItems');
    expect(element.props.projectKey).toBe('ACME');
  });

  it('returns the host even when a roadmap read would never have settled', async () => {
    const roadmap = deferred<{ nodes: unknown[] }>();
    getProjectRoadmap.mockReturnValue(roadmap.promise);

    // Belt and braces: were the read reintroduced and awaited, this would hang
    // rather than fail — so it also asserts the call never happens.
    const element = await render();

    expect(element.props.projectName).toBe('Acme');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });

  it('the anchor lookup is the page’s ONLY data read, and it still resolves the target', async () => {
    const element = await render({ item: 'ACME-9', from: 'work-item', mode: 'contextual' });

    // One read, not two queued end to end (an item-anchored launch used to pay
    // the roadmap round-trip first and the anchor round-trip after it). It stays
    // ONE even though MOTIR-2070 now needs the ancestor chain as well — the
    // lineage read carries both, rather than a second lookup joining the queue.
    expect(getWorkItemWithAncestors).toHaveBeenCalledTimes(1);
    expect(getProjectRoadmap).not.toHaveBeenCalled();
    expect(element.props.anchorId).toBe('wi_9');
    expect(element.props.initialTarget).toMatchObject({ identifier: 'ACME-9' });
    expect(element.props.initialCanvasTrail).toEqual([{ id: 'wi_1', label: 'ACME-1 · Platform' }]);
  });

  it('an unresolvable ?item= still opens the workspace on the project conversation', async () => {
    getWorkItemWithAncestors.mockRejectedValue(new Error('not found'));

    const element = await render({ item: 'GONE-9', from: 'work-item', mode: 'contextual' });

    expect(element.props.anchorId).toBeNull();
    expect(element.props.initialTarget).toBeNull();
    // …and the canvas falls back to the root level, not a half-built trail.
    expect(element.props.initialCanvasTrail).toEqual([]);
  });
});

describe('the ACCESS gates still run ahead of the paint (MOTIR-2069)', () => {
  it('a signed-out visitor is redirected, never handed a workspace', async () => {
    getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });

  it('a no-access actor gets the refusal — no workspace frame for a project they cannot browse', async () => {
    getSettingsCapabilities.mockResolvedValue({
      canBrowse: false,
      canEdit: false,
      canManage: false,
    });

    const element = await render();

    // The refusal, and the project's tree was never read.
    expect(JSON.stringify(element)).toContain('noAccessTitle');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });

  it('a never-onboarded project still redirects to /onboarding', async () => {
    getActiveProject.mockResolvedValue({
      ...PROJECT,
      project: { ...PROJECT.project, onboardingRanAt: null },
    });

    await expect(render()).rejects.toThrow('REDIRECT:/onboarding');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });

  it('no active project renders the pick-a-project hint without reading anything', async () => {
    getActiveProject.mockResolvedValue(null);

    const element = await render();

    expect(JSON.stringify(element)).toContain('noProjectTitle');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });
});
