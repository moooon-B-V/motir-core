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
const { resolveCodeContext } = vi.hoisted(() => ({ resolveCodeContext: vi.fn() }));
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
vi.mock('@/lib/ai/codeContext', () => ({ resolveCodeContext }));
vi.mock('@/lib/services/aiConventionService', () => ({
  aiConventionService: { getAudit, getConvention },
}));

import CodeHealthPage from '@/app/(authed)/code-health/page';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
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
  resolveCodeContext.mockResolvedValue({ repos: [{ repoRef: 'moooon/motir-core' }] });
  getAudit.mockResolvedValue({ audit: null });
  getConvention.mockResolvedValue({ convention: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/code-health — the page’s own branches', () => {
  it('seeds the island from the resolved repo set', async () => {
    const tree = await renderTree(CodeHealthPage);
    const island = findFirst(tree, CodeHealthClient)!;

    expect(island).toBeDefined();
    expect(island.props['repoRefs']).toEqual(['moooon/motir-core']);
    // The island is seeded from a SUCCESSFUL read and carries no whole-surface
    // failure state at all — the prop does not exist (MOTIR-3719).
    expect('loadError' in island.props).toBe(false);
  });

  it('renders the header and an island with NO reads when no repo is connected', async () => {
    resolveCodeContext.mockResolvedValue({ repos: [] });

    const tree = await renderTree(CodeHealthPage);
    const island = findFirst(tree, CodeHealthClient)!;

    expect(island.props['repoRefs']).toEqual([]);
    expect(island.props['initialSelectedRepoKey']).toBeNull();
    expect(getAudit).not.toHaveBeenCalled();
    expect(getConvention).not.toHaveBeenCalled();
    // The header is painted either way — it is the page's only unconditional copy.
    expect(textOf(tree)).toContain('title');
  });

  it('tolerates a null code context, which is not the same as an empty one', async () => {
    // `resolveCodeContext` returns null for a project with no code context at
    // all; the page reads `code?.repos ?? []`. A regression to `code.repos`
    // throws here and nowhere else.
    resolveCodeContext.mockResolvedValue(null);

    const tree = await renderTree(CodeHealthPage);

    expect(findFirst(tree, CodeHealthClient)!.props['repoRefs']).toEqual([]);
  });

  it('renders the ADMIN-ONLY state, not the island, for a non-admin', async () => {
    // A project-gate error is a statement about the CALLER, so it replaces the
    // whole surface rather than degrading one repo's row.
    getAudit.mockRejectedValue(new NotProjectAdminError('p1'));
    getConvention.mockRejectedValue(new NotProjectAdminError('p1'));

    const tree = await renderTree(CodeHealthPage);

    expect(findFirst(tree, CodeHealthClient)).toBeUndefined();
    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(textOf(tree)).toContain('adminOnlyTitle');
  });

  it('contains an unreachable motir-ai PER ROW, and still renders the island', async () => {
    // THE page's one answer to "motir-ai is unreachable" (MOTIR-3719 AC1), made
    // to happen rather than described: both boundary reads reject, which is
    // every `aiConventionService` call site this page has.
    getConvention.mockRejectedValue(new MotirAiUnavailableError('upstream down'));
    getAudit.mockRejectedValue(new MotirAiUnavailableError('upstream down'));

    const tree = await renderTree(CodeHealthPage);
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

    await expect(renderTree(CodeHealthPage)).rejects.toThrow('reading `id` of undefined');
  });

  it('renders the no-project state before it resolves any code context', async () => {
    getActiveProject.mockResolvedValue(null);

    const tree = await renderTree(CodeHealthPage);

    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(textOf(tree)).toContain('noProjectTitle');
    expect(resolveCodeContext).not.toHaveBeenCalled();
  });

  it('bounces a signed-out reader before anything else', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(CodeHealthPage)).rejects.toThrow('REDIRECT:/sign-in');
    expect(getActiveProject).not.toHaveBeenCalled();
  });
});
