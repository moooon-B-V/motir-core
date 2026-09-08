// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findFirst, renderTree, textOf } from '../../helpers/serverPageHarness';

// FAMILY 5 of 5 — CODE-HEALTH, "its own card" (Story MOTIR-3440 · Task MOTIR-3568).
//
// MOTIR-3446's verdict on this surface was NOTHING LEFT TO PARALLELISE, and it
// added no boundary. So there is no first flush to assert here, and this file is
// the other half of what a harness buys: the page function's own BRANCHES.
//
// ⚠️ WHAT WAS ALREADY COVERED, AND WHAT WAS NOT.
// `tests/code-health-page.test.ts` drives `loadCodeHealthSurfaces` — the
// exported read composition — against a real database, thoroughly, and this file
// does not repeat one line of it. What that test cannot reach is the DEFAULT
// EXPORT: the session redirect, the no-project state, the admin-only state, the
// per-repo containment of a `MotirAiError`, and the rethrow of anything else.
// Every one of those is a decision the page makes and nothing executed until now
// — which is the shape of the gap the whole card is about, visible on a page
// that was otherwise well tested.
//
// ⚠️ AND THE FIRST THING IT FOUND WAS A DEAD ARM (MOTIR-3719). The page used to
// keep a whole-surface `loadError` and hand it to the island. Rendering it here
// with both boundary reads rejecting showed the prop arriving `false`: the arm
// could not execute, because the per-repo containment absorbs every
// `MotirAiError` before it reaches the page's `catch`. That state, its arm and
// the island's prop are gone; what is asserted below is the containment itself.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getActiveProject } = vi.hoisted(() => ({ getActiveProject: vi.fn() }));
const { resolveCodeContextState } = vi.hoisted(() => ({ resolveCodeContextState: vi.fn() }));
const { getAudit, getConvention } = vi.hoisted(() => ({
  getAudit: vi.fn(),
  getConvention: vi.fn(),
}));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/codeContextService', () => ({ resolveCodeContextState }));
vi.mock('@/lib/services/aiConventionService', () => ({
  aiConventionService: { getAudit, getConvention },
}));

import CodePage from '@/app/(authed)/code/page';
import { CodeRepositories } from '@/app/(authed)/code/_components/CodeRepositories';
import { CodeHealthClient } from '@/app/(authed)/code/_components/CodeHealthClient';
import { EmptyState } from '@/components/ui/EmptyState';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { NotProjectAdminError } from '@/lib/projects/errors';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme', accessLevel: 'open' },
};

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  resolveCodeContextState.mockResolvedValue({
    hasCodeContext: true,
    hasImplementedWork: true,
    repos: [
      {
        repoRef: 'moooon/motir-core',
        provider: 'github',
        indexState: 'indexed',
        indexedAt: null,
        commitsBehind: null,
      },
    ],
  });
  getAudit.mockResolvedValue({ audit: null });
  getConvention.mockResolvedValue({ convention: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/code — the page’s own branches', () => {
  it('seeds the island from the resolved repo set', async () => {
    const tree = await renderTree(CodePage);
    const island = findFirst(tree, CodeHealthClient)!;

    expect(island).toBeDefined();
    expect(island.props['repoRefs']).toEqual(['moooon/motir-core']);
    // The island is seeded from a SUCCESSFUL read and carries no whole-surface
    // failure state at all — the prop does not exist (MOTIR-3719).
    expect('loadError' in island.props).toBe(false);
  });

  it('renders the header and an island with NO reads when no repo is connected', async () => {
    resolveCodeContextState.mockResolvedValue({
      hasCodeContext: false,
      hasImplementedWork: false,
      repos: [],
    });

    const tree = await renderTree(CodePage);
    const island = findFirst(tree, CodeHealthClient)!;

    expect(island.props['repoRefs']).toEqual([]);
    expect(island.props['initialSelectedRepoKey']).toBeNull();
    expect(getAudit).not.toHaveBeenCalled();
    expect(getConvention).not.toHaveBeenCalled();
    // The header is painted either way — it is the page's only unconditional copy.
    expect(textOf(tree)).toContain('title');
  });

  it('reads the PROJECT\u2019s set, not the workspace\u2019s grant list', async () => {
    // The leak \u00a71 names, asserted at the seam rather than argued. The page
    // calls `resolveCodeContextState(projectId, ctx)` \u2014 which resolves
    // `project_repository` \u2014 and hands its rows straight to the section, so
    // two projects in one workspace with different sets render different lists.
    await renderTree(CodePage);

    expect(resolveCodeContextState).toHaveBeenCalledWith('p1', {
      userId: 'u1',
      workspaceId: 'ws1',
    });
  });

  it('\u26a0\ufe0f renders the admin-only state INSIDE Health \u2014 and Repositories still works', async () => {
    // The criterion the whole collapse rests on (\u00a72.1). `/code-health` asserted
    // `ai:configure` and the old `Git` row was ungated on purpose, so a naive
    // collapse either takes a capability off every member or widens an
    // admin-only audit to everyone. The resolution is that the ROW is
    // browse-reachable and each SECTION keeps its own gate \u2014 which means the
    // project-gate error may NOT replace the page, as it did on the surface this
    // absorbed.
    getAudit.mockRejectedValue(new NotProjectAdminError('p1'));
    getConvention.mockRejectedValue(new NotProjectAdminError('p1'));

    const tree = await renderTree(CodePage);

    // Health is denied\u2026
    expect(findFirst(tree, CodeHealthClient)).toBeUndefined();
    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(textOf(tree)).toContain('adminOnlyTitle');
    // \u2026and Repositories is rendered anyway, on the same page load. This is the
    // assertion that fails if the gate ever moves back up to the page.
    expect(findFirst(tree, CodeRepositories)).toBeDefined();
  });

  it('contains an unreachable motir-ai PER ROW, and still renders the island', async () => {
    // THE page's one answer to "motir-ai is unreachable" (MOTIR-3719 AC1), made
    // to happen rather than described: both boundary reads reject, which is
    // every `aiConventionService` call site this page has.
    getConvention.mockRejectedValue(new MotirAiUnavailableError('upstream down'));
    getAudit.mockRejectedValue(new MotirAiUnavailableError('upstream down'));

    const tree = await renderTree(CodePage);
    const island = findFirst(tree, CodeHealthClient)!;

    // Containment, per MOTIR-2207: one repo's failure is that row's own state.
    // The page RENDERS — it does not degrade to a banner and does not throw.
    expect(island).toBeDefined();
    expect(island.props['initialSelectedAudit']).toBeNull();
    expect(island.props['initialConventions']).toEqual([]);
    // The failing repo keeps its place in the list carrying `surface: null` —
    // "Couldn't load this report", the `unavailable` row state Panel 7 §6 draws.
    expect(island.props['initialAudits']).toEqual([
      { repoKey: 'moooon/motir-core', surface: null },
    ]);
    // And there is no whole-surface failure state to hand over. This is the
    // assertion that would have failed before MOTIR-3719: the prop existed, and
    // it arrived `false` on the one input that was supposed to raise it.
    expect('loadError' in island.props).toBe(false);
  });

  it('RETHROWS anything that is neither the project gate nor a contained per-repo failure', async () => {
    // The `catch`'s surviving arm. A `MotirAiError` cannot reach it (the test
    // above), and a project-gate error is answered with the admin-only state —
    // so what is left is a genuine server error, and the page must not swallow
    // it into a degraded surface that says the code analysis is unavailable.
    getAudit.mockRejectedValue(new TypeError('reading `id` of undefined'));

    await expect(renderTree(CodePage)).rejects.toThrow('reading `id` of undefined');
  });

  it('renders the no-project state before it resolves any code context', async () => {
    getActiveProject.mockResolvedValue(null);

    const tree = await renderTree(CodePage);

    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(textOf(tree)).toContain('noProjectTitle');
    expect(resolveCodeContextState).not.toHaveBeenCalled();
  });

  it('bounces a signed-out reader before anything else', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(CodePage)).rejects.toThrow('REDIRECT:/sign-in');
    expect(getActiveProject).not.toHaveBeenCalled();
  });
});
