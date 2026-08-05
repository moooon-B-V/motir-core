// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `/roadmap` page's SERVER half (MOTIR-2205), in the shape
// `planningPageStreaming.test.tsx` uses for `/planning` (Bug MOTIR-2069).
//
// MOTIR-2205 gives the planning phase card a badge that depends on what the
// project's pre-plan journey PRODUCED — a motir-ai round trip. `/roadmap` already
// pays two reads before it paints, and MOTIR-2069 is the record of what a third one
// costs on a flagship surface, so the read is deliberately NOT the page's: it belongs
// to the client canvas, which fires it AFTER mount and lets the card upgrade when it
// lands. The station level's read happens later still, on the drill.
//
// This file guards that line. The page is easy to "helpfully" grow a
// `const preplan = await …` on, so that the server can hand the badge down
// pre-resolved — which is the defect, not a tidy-up. The reads that MUST stay ahead
// of the paint (the access gates, and the two data reads the page genuinely owns)
// are asserted here too, so the guard cannot be satisfied by deferring those.

const {
  getSession,
  getActiveProject,
  getCapabilities,
  getProjectRoadmap,
  getActiveSprint,
  getPreplanState,
  fetchPreplanState,
  isMotirAiConfigured,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
  getProjectRoadmap: vi.fn(),
  getActiveSprint: vi.fn(),
  getPreplanState: vi.fn(),
  fetchPreplanState: vi.fn(),
  isMotirAiConfigured: vi.fn(),
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
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { getProjectRoadmap },
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: { getActiveSprint },
}));
// BOTH pre-plan reads are mocked and given happy values deliberately: the guard is
// that the page never calls either one EVEN WHEN it would succeed. `aiPreplanService`
// is the server read a well-meaning change would reach for; `fetchPreplanState` is
// the browser read the canvas actually owns.
vi.mock('@/lib/services/aiPreplanService', () => ({
  aiPreplanService: { getPreplanState },
}));
vi.mock('@/lib/onboarding/preplanClient', () => ({
  fetchPreplanState,
  findTierDoc: vi.fn(),
  producedTierKinds: vi.fn(() => []),
}));

import RoadmapPage from '@/app/(authed)/roadmap/page';

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

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getCapabilities.mockResolvedValue({ canBrowse: true });
  getProjectRoadmap.mockResolvedValue({ nodes: [{ id: 'wi1' }] });
  getActiveSprint.mockResolvedValue(null);
  getPreplanState.mockResolvedValue({ session: null, docs: [], catalog: null });
  fetchPreplanState.mockResolvedValue({ session: null, docs: [], catalog: null });
  isMotirAiConfigured.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the roadmap paints WITHOUT the pre-plan read (MOTIR-2205 / MOTIR-2069)', () => {
  it('never reads pre-plan — the phase card’s badge is not the page’s to resolve', async () => {
    const element = await RoadmapPage();

    expect(getPreplanState).not.toHaveBeenCalled();
    expect(fetchPreplanState).not.toHaveBeenCalled();
    // The marker gate is untouched (MOTIR-1264's contract): it still decides WHETHER
    // the card renders. What it ASSERTS is the client's, resolved late.
    expect(element.props.showPlanningOrigin).toBe(true);
    expect(element.props).not.toHaveProperty('producedTiers');
  });

  it('the page’s existing reads are not serialized behind it', async () => {
    // Were a pre-plan read reintroduced and awaited, this would HANG rather than
    // fail — so it also asserts the page's own reads run and settle without it.
    const preplan = deferred<unknown>();
    getPreplanState.mockReturnValue(preplan.promise);
    fetchPreplanState.mockReturnValue(preplan.promise);

    const element = await RoadmapPage();

    expect(element.props.projectKey).toBe('ACME');
    expect(getProjectRoadmap).toHaveBeenCalledTimes(1);
    expect(getActiveSprint).toHaveBeenCalledTimes(1);
    expect(getPreplanState).not.toHaveBeenCalled();
    expect(fetchPreplanState).not.toHaveBeenCalled();
  });

  it('an EMPTY project keeps the server empty state and still reads no pre-plan', async () => {
    getProjectRoadmap.mockResolvedValue({ nodes: [] });

    const element = await RoadmapPage();

    expect(JSON.stringify(element)).toContain('emptyTitle');
    expect(getActiveSprint).not.toHaveBeenCalled(); // the empty branch returns early
    expect(getPreplanState).not.toHaveBeenCalled();
    expect(fetchPreplanState).not.toHaveBeenCalled();
  });

  it('a never-onboarded project omits the card, without a pre-plan read either way', async () => {
    getActiveProject.mockResolvedValue({
      ...PROJECT,
      project: { ...PROJECT.project, onboardingRanAt: null },
    });

    const element = await RoadmapPage();

    expect(element.props.showPlanningOrigin).toBe(false);
    expect(getPreplanState).not.toHaveBeenCalled();
    expect(fetchPreplanState).not.toHaveBeenCalled();
  });
});

describe('the ACCESS gates still run ahead of the paint', () => {
  it('a signed-out visitor is redirected, never handed a roadmap', async () => {
    getSession.mockResolvedValue(null);
    await expect(RoadmapPage()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
  });

  it('a no-access actor gets the refusal, and the tree is never read', async () => {
    getCapabilities.mockResolvedValue({ canBrowse: false });

    const element = await RoadmapPage();

    expect(JSON.stringify(element)).toContain('noAccessTitle');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
    expect(getPreplanState).not.toHaveBeenCalled();
  });

  it('no active project renders the pick-a-project hint without reading anything', async () => {
    getActiveProject.mockResolvedValue(null);

    const element = await RoadmapPage();

    expect(JSON.stringify(element)).toContain('noProjectTitle');
    expect(getProjectRoadmap).not.toHaveBeenCalled();
    expect(getPreplanState).not.toHaveBeenCalled();
  });
});
