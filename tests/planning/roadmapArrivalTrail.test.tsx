// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `/roadmap` page's ARRIVAL LEVEL (MOTIR-3836) — the server half of
// `?item=<KEY>`, in the same shape `roadmapPageStreaming.test.tsx` uses for the
// page's other server contract.
//
// `?item=MOTIR-1234` means "the canvas is showing MOTIR-1234's CHILDREN" — you are
// INSIDE it, which is where a drill leaves you — so the trail this page resolves is
// `ancestors ++ [the item itself]` and its LAST crumb is the level the canvas loads.
// That is deliberately one crumb deeper than `/planning?item=`, which opens on the
// anchor's OWN level so the anchor is visible.
//
// The other half of this file is the SILENT FALLBACK. Every way a key can fail to
// resolve — unknown, another project's, archived, not browsable — has the same
// answer: an empty trail and the project root. A stale link is not a failure, it is
// a level that no longer exists, so there is no error surface and no redirect.

const {
  getSession,
  getActiveProject,
  getCapabilities,
  getProjectRoadmap,
  getWorkItemWithAncestors,
  getActiveSprint,
  isMotirAiConfigured,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
  getProjectRoadmap: vi.fn(),
  getWorkItemWithAncestors: vi.fn(),
  getActiveSprint: vi.fn(),
  isMotirAiConfigured: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { getProjectRoadmap, getWorkItemWithAncestors },
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: { getActiveSprint },
}));

import RoadmapPage from '@/app/(authed)/roadmap/page';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme', onboardingRanAt: null },
};

const params = (q: Record<string, string>) => Promise.resolve(q);

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getCapabilities.mockResolvedValue({ canBrowse: true });
  getProjectRoadmap.mockResolvedValue({ nodes: [{ id: 'wi1' }] });
  getActiveSprint.mockResolvedValue(null);
  isMotirAiConfigured.mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe('the roadmap ARRIVAL LEVEL (?item=)', () => {
  it('resolves `ancestors ++ [the item]`, each crumb carrying its id, KEY and label', async () => {
    getWorkItemWithAncestors.mockResolvedValue({
      item: { id: 'S1', identifier: 'ACME-11', title: 'The story' },
      ancestors: [{ id: 'E1', identifier: 'ACME-1', title: 'The epic' }],
    });

    const element = await RoadmapPage({ searchParams: params({ item: 'ACME-11' }) });

    expect(getWorkItemWithAncestors).toHaveBeenCalledWith('p1', 'ACME-11', {
      userId: 'u1',
      workspaceId: 'ws1',
    });
    // The LAST crumb is the item itself — the level the canvas loads.
    expect(element.props.initialTrail).toEqual([
      { id: 'E1', crumbKey: 'ACME-1', label: 'ACME-1 · The epic' },
      { id: 'S1', crumbKey: 'ACME-11', label: 'ACME-11 · The story' },
    ]);
  });

  it('a ROOT-level item resolves to a one-crumb trail (no ancestors)', async () => {
    getWorkItemWithAncestors.mockResolvedValue({
      item: { id: 'E1', identifier: 'ACME-1', title: 'The epic' },
      ancestors: [],
    });

    const element = await RoadmapPage({ searchParams: params({ item: 'ACME-1' }) });

    expect(element.props.initialTrail).toEqual([
      { id: 'E1', crumbKey: 'ACME-1', label: 'ACME-1 · The epic' },
    ]);
  });

  it('passes an EMPTY trail and never resolves anything when `item` is absent', async () => {
    const element = await RoadmapPage({ searchParams: params({}) });

    expect(getWorkItemWithAncestors).not.toHaveBeenCalled();
    expect(element.props.initialTrail).toEqual([]);
  });

  it('passes an EMPTY trail when the page is rendered with no searchParams at all', async () => {
    const element = await RoadmapPage();

    expect(getWorkItemWithAncestors).not.toHaveBeenCalled();
    expect(element.props.initialTrail).toEqual([]);
  });

  it.each([
    ['an unknown key', new Error('WorkItemNotFound')],
    ['an item in another project', new Error('WorkItemNotFound')],
    ['an archived item', new Error('WorkItemNotFound')],
    ['an item this actor cannot browse', new Error('ProjectAccessDenied')],
  ])('falls back SILENTLY to the root level for %s', async (_case, err) => {
    getWorkItemWithAncestors.mockRejectedValue(err);

    const element = await RoadmapPage({ searchParams: params({ item: 'ACME-999' }) });

    // No throw, no redirect, no error surface — the roadmap simply opens at its root.
    expect(element.props.initialTrail).toEqual([]);
    expect(element.props.projectKey).toBe('ACME');
  });

  it('ignores a repeated `item` param rather than guessing which one is meant', async () => {
    const element = await RoadmapPage({
      searchParams: Promise.resolve({ item: ['ACME-1', 'ACME-2'] }),
    });

    expect(getWorkItemWithAncestors).not.toHaveBeenCalled();
    expect(element.props.initialTrail).toEqual([]);
  });

  it('does not resolve a trail for an EMPTY project — the empty state has no canvas', async () => {
    getProjectRoadmap.mockResolvedValue({ nodes: [] });

    const element = await RoadmapPage({ searchParams: params({ item: 'ACME-11' }) });

    // The empty branch returns before the sprint read and before any trail resolve;
    // there is no canvas to arrive on.
    expect(getActiveSprint).not.toHaveBeenCalled();
    expect(element.props.initialTrail).toBeUndefined();
  });
});
