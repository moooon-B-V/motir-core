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
import { CodeSections } from '@/app/(authed)/code/_components/CodeSections';
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

/**
 * Render `/code` AT A URL — the page takes `searchParams`, so every call has to
 * say which one it is rendering.
 *
 * ⚠️ THE ARGUMENT IS THE POINT (MOTIR-1754). The section used to be read by the
 * client island out of `useSearchParams()` inside a `useState` initialiser,
 * which yields an EMPTY set during the server render — so the server always
 * painted Repositories and `/code?section=health` silently opened the wrong
 * section. It is resolved on the server now, and this harness makes the URL an
 * explicit input rather than an ambient one.
 */
const renderAt = (section?: string) =>
  renderTree(CodePage, { searchParams: Promise.resolve(section ? { section } : {}) });

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
    const tree = await renderAt();
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

    const tree = await renderAt();
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
    await renderAt();

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

    const tree = await renderAt();

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

    const tree = await renderAt();
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

    await expect(renderAt()).rejects.toThrow('reading `id` of undefined');
  });

  it('REDIRECTS rather than rendering when there is no active project', async () => {
    // ⚠️ INVERTED (MOTIR-4874), not deleted. It asserted an `EmptyState`
    // carrying `noProjectTitle`. Every member is inside a project
    // (MOTIR-4870), so the only null left is a session-less request — and a
    // page must not render a screen for a state it cannot be in.
    //
    // What the spec is really about survives unchanged and is the half worth
    // keeping: the gate runs BEFORE any code context is resolved.
    getActiveProject.mockResolvedValue(null);

    await expect(renderAt()).rejects.toThrow('REDIRECT:/sign-in');
    expect(resolveCodeContextState).not.toHaveBeenCalled();
  });

  it('⚠️ opens the section the URL asks for — `?section=health` is resolved on the SERVER', async () => {
    // THE DEEP LINK, AND THE DEFECT IT SHIPPED WITH. The planning banner's
    // "Review code health" link promises the audit in ONE click by deep-linking
    // to `/code?section=health`. `CodeSections` seeded itself with
    // `useState(() => sectionFromParam(useSearchParams().get('section')))`,
    // which reads as equivalent to this and is not: a `useState` initialiser
    // also runs during the SERVER render, where the hook yields an EMPTY set. So
    // the server painted `repositories` for every request and hydration reused
    // that state, and the link opened the repository list.
    //
    // ⚠️ IT FAILED IN THE SHAPE THAT HIDES BEST: both bodies stay MOUNTED and
    // the inactive one is `hidden`, so the Health section was in the DOM the
    // whole time. Every presence assertion passed. Only a VISIBILITY assertion
    // could see it, which is why it survived the PR lane and died in the merge
    // queue's cloud leg — `cloud-audit-coverage.spec.ts` is the one spec that
    // follows the banner's link rather than clicking the segmented control.
    //
    // Asserted on the PROP, which is the seam the server owns. The island's own
    // `hidden` switching is its business; what the page must get right is
    // handing it the section the URL named.
    const sections = findFirst(await renderAt('health'), CodeSections)!;
    expect(sections).toBeDefined();
    expect(sections.props['initialSection']).toBe('health');
  });

  it('falls back to the repository list for a missing or unknown section', async () => {
    // The other half of `sectionFromParam`: absent and garbage both land on the
    // default rather than throwing, so a hand-edited URL cannot 500 the room.
    expect(findFirst(await renderAt(), CodeSections)!.props['initialSection']).toBe('repositories');
    expect(findFirst(await renderAt('nope'), CodeSections)!.props['initialSection']).toBe(
      'repositories',
    );
  });

  it('bounces a signed-out reader before anything else', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderAt()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getActiveProject).not.toHaveBeenCalled();
  });
});
