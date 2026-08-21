// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// MOTIR-3241 — `/plans` is TABBED by status and STREAMED ten at a time.
//
// The page half, in the `roadmapPageStreaming` Server-Component shape: mock the
// boundary modules, `await PlansPage()`, and assert on the element tree. What is
// worth pinning here is everything a screenshot would agree with while being
// wrong — WHICH read the page made, which tab it resolved, and which of the two
// empty states it chose. (The client half — the sentinel and the guarded
// dereference — is `tests/components/PlansList-streaming.test.tsx`; the shrink-on-switch crash the
// guard prevents is not observable in happy-dom at all and belongs to the E2E.)

const {
  getSession,
  getActiveProject,
  getCapabilities,
  listPlans,
  countPlansByStatus,
  isMotirAiConfigured,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
  listPlans: vi.fn(),
  countPlansByStatus: vi.fn(),
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
vi.mock('@/lib/services/plansService', () => ({
  plansService: { listPlans, countPlansByStatus },
}));
vi.mock('@/app/(authed)/plans/planRowView', () => ({
  buildPlanRowViews: async (plans: { id: string }[]) =>
    plans.map((p) => ({ id: p.id, status: 'planned', title: p.id })),
}));

import PlansPage from '@/app/(authed)/plans/page';
import { PlansList } from '@/app/(authed)/plans/_components/PlansList';
import { PlanStatusTabs } from '@/app/(authed)/plans/_components/PlanStatusTabs';
import { planStatusFromParam } from '@/lib/planning/planStatusFilter';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme' },
};

const COUNTS = { generating: 2, planned: 3, approved: 9, declined: 8 };
const NO_PLANS = { generating: 0, planned: 0, approved: 0, declined: 0 };

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

const find = (tree: ReactNode, type: unknown) =>
  walk(tree).filter((el) => el.type === type) as ReactElement<Record<string, unknown>>[];

/** The page, with a `?status=` (or none). */
const render = (status?: string) =>
  PlansPage(status === undefined ? {} : { searchParams: Promise.resolve({ status }) });

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getCapabilities.mockResolvedValue({ canBrowse: true });
  isMotirAiConfigured.mockReturnValue(true);
  listPlans.mockResolvedValue({ plans: [{ id: 'plan_1' }], nextCursor: null });
  countPlansByStatus.mockResolvedValue(COUNTS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('planStatusFromParam — the URL is a place a person can type', () => {
  it('takes each of the four members', () => {
    for (const status of ['generating', 'planned', 'approved', 'declined'] as const) {
      expect(planStatusFromParam(status)).toBe(status);
    }
  });

  it('falls back to `planned` for absent, empty, unknown and malformed values', () => {
    for (const raw of [undefined, null, '', 'nonsense', 'APPROVED', 'planned ']) {
      expect(planStatusFromParam(raw)).toBe('planned');
    }
  });
});

describe('/plans reads the tab from the URL (MOTIR-3241)', () => {
  it('defaults to `planned` with no parameter, and asks the service for THAT status', async () => {
    await render();

    expect(listPlans).toHaveBeenCalledTimes(1);
    expect(listPlans.mock.calls[0]![2]).toEqual({ status: 'planned' });
    // Ten rows come from the READ's own default (MOTIR-3235); the page must not
    // pass a literal, or the two would drift.
    expect(listPlans.mock.calls[0]![2]).not.toHaveProperty('limit');
  });

  it('`?status=approved` opens on Approved', async () => {
    const tree = await render('approved');

    expect(listPlans.mock.calls[0]![2]).toEqual({ status: 'approved' });
    expect(find(tree, PlanStatusTabs)[0]!.props.value).toBe('approved');
    expect(find(tree, PlansList)[0]!.props.status).toBe('approved');
  });

  it('`?status=nonsense` falls back to Planned without throwing', async () => {
    const tree = await render('nonsense');

    expect(listPlans.mock.calls[0]![2]).toEqual({ status: 'planned' });
    expect(find(tree, PlanStatusTabs)[0]!.props.value).toBe('planned');
  });

  it('the list is KEYED on the status, so a switch remounts rather than appends', async () => {
    // `PlansList` seeds its rows and cursor from props in `useState`, which a
    // re-render cannot revisit. Without the key, switching tabs would leave the
    // previous tab's rows in place and append the new tab's next page to them.
    const tree = await render('declined');
    const list = find(tree, PlansList)[0]!;

    expect(list.key).toBe('declined');
  });

  it('the strip gets the counts, total over the vocabulary', async () => {
    const tree = await render();

    expect(find(tree, PlanStatusTabs)[0]!.props.counts).toEqual(COUNTS);
  });
});

describe('/plans has TWO empty states, and they are not the same one', () => {
  it('NO plans in the project at all → the project empty state, its CTA, and NO tab strip', async () => {
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });
    countPlansByStatus.mockResolvedValue(NO_PLANS);

    const tree = await render();

    expect(find(tree, PlanStatusTabs)).toHaveLength(0);
    expect(find(tree, PlansList)).toHaveLength(0);
    const empty = find(tree, EmptyState);
    expect(empty).toHaveLength(1);
    // The generate CTA is RETAINED here — `/roadmap`'s empty state carries the
    // same one and the two must not diverge.
    expect(find(empty[0]!.props.action as ReactNode, PlanWithAILauncher)).toHaveLength(1);
    expect(empty[0]!.props.title).toBe('emptyTitle');
  });

  it('plans elsewhere but NONE in this tab → the strip STAYS and the CTA does not', async () => {
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });
    countPlansByStatus.mockResolvedValue({ ...COUNTS, generating: 0 });

    const tree = await render('generating');

    // The strip stays: hiding the control that got you here is how a reader gets
    // stuck in a tab.
    expect(find(tree, PlanStatusTabs)).toHaveLength(1);
    expect(find(tree, PlansList)).toHaveLength(0);
    const empty = find(tree, EmptyState);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.props.title).toBe('tabEmpty.generatingTitle');
    // No generate CTA. A generate CTA is the wrong answer to *nothing is
    // generating* — the reader's next move is a different tab.
    expect(empty[0]!.props.action).toBeUndefined();
    expect(find(tree, PlanWithAILauncher)).toHaveLength(0);
  });

  it('the per-tab empty state names its own tab', async () => {
    listPlans.mockResolvedValue({ plans: [], nextCursor: null });
    countPlansByStatus.mockResolvedValue({ ...COUNTS, declined: 0 });

    const tree = await render('declined');

    expect(find(tree, EmptyState)[0]!.props.title).toBe('tabEmpty.declinedTitle');
  });

  it('a NON-empty tab renders the list and no empty state', async () => {
    const tree = await render('approved');

    expect(find(tree, EmptyState)).toHaveLength(0);
    expect(find(tree, PlansList)).toHaveLength(1);
  });
});
