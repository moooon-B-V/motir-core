// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// THE PANE FILLS THE FOLD (MOTIR-4019, design Part XIII §2).
//
// The BEHAVIOUR is geometry and is measured in a real Chromium — the four-viewport
// table is in the pull request body, because happy-dom does no layout and a height
// cannot be asserted here. What IS assertable, and what a later edit would silently
// undo, is the STRUCTURE the geometry rests on: the budget, the TOKEN it reads, the
// way the shell's band is spent, and the inset this pane deliberately does NOT
// declare. Same split, and the same reasoning, as `RoadmapView.test.tsx`'s own
// fold block (MOTIR-3839).

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/workspaces', () => ({
  getWorkspaceContext: async () => ({ workspaceId: 'ws1', userId: 'u1' }),
}));
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: {
    getPlanReview: async () => ({
      id: 'plan1',
      projectId: 'proj1',
      title: 'Billing plan',
      status: 'planned',
      items: [],
      itemCount: 0,
      history: [],
      stale: false,
      staleCount: 0,
      revision: null,
    }),
  },
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { assertProjectInWorkspace: async () => ({ identifier: 'MOTIR' }) },
}));
vi.mock('@/lib/services/projectRepoEstablishService', () => ({
  projectRepoEstablishService: { getEstablishView: async () => null },
}));
// The island is stubbed: this card resizes the BOX around it and changes nothing
// inside it, so pulling the whole canvas+rail in would test somebody else's card.
vi.mock('@/components/planning/PlanDetail', () => ({
  PlanDetail: () => <div data-testid="plan-detail-island" />,
}));

const { default: PlanDetailPage } = await import('@/app/(authed)/plans/[id]/page');

async function renderPage(): Promise<HTMLElement> {
  const ui = await PlanDetailPage({ params: Promise.resolve({ id: 'plan1' }) });
  render(ui);
  const island = document.querySelector('[data-testid="plan-detail-island"]');
  return island!.parentElement as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('the plan detail’s canvas box — the vertical budget', () => {
  it('subtracts the MEASURED 133px of chrome and no longer double-spends the shell’s band', async () => {
    const cls = (await renderPage()).className;
    // 57 (top nav h-14 + its hairline) + 24 (the shell's pt-6) + 16 (this
    // stack's gap-4) + the header, which is one control tall.
    expect(cls).toContain(
      'h-[calc(100dvh_-_3.5rem_-_1px_-_1.5rem_-_1rem_-_var(--height-control))]',
    );
    // The shipped value subtracted 8.5rem — 3px MORE than the chrome costs — and
    // then `--shell-bottom-clearance` a SECOND time, which the shell has already
    // spent as `pb-(--shell-bottom-clearance)`.
    expect(cls).not.toContain('8.5rem');
    expect(cls).not.toContain('h-[calc(100dvh_-_8.5rem');
  });

  it('READS `--height-control` rather than baking a rem, because the header is one control tall', async () => {
    const cls = (await renderPage()).className;
    // Every `[data-style]` axis redefines the token — 34 / 36 / 38 / 40 — so a
    // constant is wrong by up to 4px on seven of the nine styles, in a `calc`
    // whose error mode is a pane that overruns its budget. This is the one place
    // this box must differ from `RoadmapView`'s otherwise identical block, whose
    // header is an h1 + subtitle stack that no style axis moves.
    expect(cls).toContain('var(--height-control)');
    expect(cls).not.toMatch(/h-\[calc\(100dvh_-_\d+(\.\d+)?rem\)\]/);
  });

  it('SPENDS the shell’s clearance band with a negative bottom margin, not by changing the shell', async () => {
    expect((await renderPage()).className).toContain(
      'mb-[calc(-1*var(--shell-bottom-clearance,1.5rem))]',
    );
  });

  it('keeps `min-h-[34rem]` — the floor that stops the pane collapsing on a short window', async () => {
    // Kept, and it no longer BINDS: 635px at 1366x768, the tightest viewport
    // measured, against a 544px floor. The measurement is in the pull request.
    expect((await renderPage()).className).toContain('min-h-[34rem]');
  });

  it('declares NO `--canvas-fold-inset` — the orb is over the RAIL here, not the canvas', async () => {
    const box = await renderPage();
    // `PlanningWorkspace` is `grid-cols-[1fr_22rem]`, so at `md` and above the
    // orb's corner sits over the 22rem review rail and the canvas column ends
    // 309px clear of it (measured at 1440x900). Declaring the inset would lift
    // `ProjectRoadmapCanvas`'s bottom-right control clear of nothing — and this
    // is exactly the line a later reader is most likely to copy from
    // `RoadmapView`, which is why it is asserted rather than merely omitted.
    expect(box.getAttribute('style') ?? '').not.toContain('--canvas-fold-inset');
    expect(box.className).not.toContain('canvas-fold-inset');
  });
});

describe('the shell is untouched — the negative margin stays local to this box', () => {
  const layout = readFileSync(join(process.cwd(), 'app/(authed)/layout.tsx'), 'utf8');

  it('still spends the band ONCE, as padding on the main area', () => {
    // If a later edit "fixes" the fold by changing the shell instead, every
    // route moves — which is the cost this card's negative margin exists to
    // avoid. Asserted on the SOURCE because the shell is not this page's render.
    expect(layout).toContain('pb-(--shell-bottom-clearance)');
  });

  it('still sets the band from the orb’s own gate', () => {
    expect(layout).toContain("'--shell-bottom-clearance': showPlanWithAi ? '6rem' : '1.5rem'");
  });
});
