// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// MOTIR-3237 — `/plans` carries ONE Plan-with-AI entrance, and it is the TOP
// BAR's. The page header used to render its own `PlanWithAILauncher` about 200px
// below the identical one `TopNav` puts on every authed screen; MOTIR-1300
// already ruled against a per-surface door, and the launcher's own header
// comment says it exists to remove them.
//
// ⚠️ THE TWO HALVES ARE ASSERTED TOGETHER, DELIBERATELY. The header's pill goes
// and the EMPTY STATE's CTA stays, and either assertion alone lets a later edit
// delete both or restore both — which is exactly the change a reader tidying
// this page would make. So every test below counts the launchers in the WHOLE
// returned tree and says where each one sits.
//
// The page is a Server Component, so this is the `roadmapPageStreaming` shape:
// mock the boundary modules, `await PlansPage()`, and assert on the element tree
// it returns. Nothing is rendered — the launcher is a client component and its
// PRESENCE, not its markup, is what this card decides.

const { getSession, getActiveProject, getCapabilities, listPlans, isMotirAiConfigured } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    getActiveProject: vi.fn(),
    getCapabilities: vi.fn(),
    listPlans: vi.fn(),
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
vi.mock('@/lib/services/plansService', () => ({ plansService: { listPlans } }));
// The row view-model builder reads users + staleness; the entrance is not its
// business, so it is stubbed to the identity of "one row per plan".
vi.mock('@/app/(authed)/plans/planRowView', () => ({
  buildPlanRowViews: async (plans: { id: string }[]) =>
    plans.map((p) => ({ id: p.id, status: 'planned', title: p.id })),
}));

import PlansPage from '@/app/(authed)/plans/page';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme' },
};

/** Every node in a returned element tree, depth-first — including the ones that
 *  ride a prop rather than `children` (`EmptyState`'s `action` is one, which is
 *  exactly where the surviving launcher lives). */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props) return out;
  out.push(el);
  for (const value of Object.values(el.props)) walk(value as ReactNode, out);
  return out;
}

/** The launcher elements anywhere in the tree. */
function launchers(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  return walk(tree).filter((el) => el.type === PlanWithAILauncher) as ReactElement<
    Record<string, unknown>
  >[];
}

/** The page `<header>`'s own subtree — what the header renders, and nothing else. */
function header(tree: ReactNode): ReactElement | undefined {
  return walk(tree).find((el) => el.type === 'header');
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getCapabilities.mockResolvedValue({ canBrowse: true });
  isMotirAiConfigured.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/plans carries ONE Plan-with-AI entrance (MOTIR-3237)', () => {
  it('a project WITH plans renders ZERO launchers from this page', async () => {
    listPlans.mockResolvedValue({ plans: [{ id: 'plan_1' }, { id: 'plan_2' }], nextCursor: null });

    const tree = await PlansPage();

    // The whole point: with plans on the surface, the top bar's pill and the
    // floating orb are the entrances, and this page adds none.
    expect(launchers(tree)).toHaveLength(0);
  });

  it('the header holds the heading and the subtitle, and nothing else', async () => {
    listPlans.mockResolvedValue({ plans: [{ id: 'plan_1' }], nextCursor: null });

    const tree = await PlansPage();
    const head = header(tree);

    expect(head).toBeDefined();
    expect(launchers(head)).toHaveLength(0);
    // The `justify-between` layout existed ONLY to push the pill to the far end.
    // Asserting its absence is what stops the pill coming back with the layout
    // that makes room for it.
    const className = String((head!.props as { className?: string }).className ?? '');
    expect(className).not.toContain('justify-between');
    expect(walk(head).some((el) => el.type === 'h1')).toBe(true);
  });

  it('a project with NO plans renders EXACTLY ONE launcher, in the empty state', async () => {
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });

    const tree = await PlansPage();
    const found = launchers(tree);

    expect(found).toHaveLength(1);
    // The first-run CTA, with its own context — `hasPlan: false` is what makes it
    // a call to action rather than a second copy of the bar's pill.
    expect(found[0]!.props.context).toEqual({ kind: 'project', hasPlan: false });
    // And it is NOT in the header.
    expect(launchers(header(tree))).toHaveLength(0);
  });

  it('with AI unconfigured, the empty state offers no launcher either', async () => {
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });
    isMotirAiConfigured.mockReturnValue(false);

    const tree = await PlansPage();

    expect(launchers(tree)).toHaveLength(0);
  });

  it('the `aiConfigured` read still runs — the empty state depends on it', async () => {
    // The removal must not take the read with it. If a later edit drops
    // `isMotirAiConfigured()` as newly-unused, the empty state silently offers
    // its CTA to a workspace that has no AI configured.
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });

    await PlansPage();

    expect(isMotirAiConfigured).toHaveBeenCalled();
  });
});
