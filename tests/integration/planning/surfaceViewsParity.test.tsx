// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// MOTIR-6187 — the surface-views INTEGRATION GATE.
//
// ── What no unit can see ────────────────────────────────────────────────────
// MOTIR-6185 and MOTIR-6186 each ship their own component tests, and both drive
// the component with a HAND-BUILT `PlanReviewDto`. That is exactly the blind
// spot this file exists for: a fixture asserts against its author's idea of the
// read's shape, so two hosts can each be "correct" against their own fixture and
// still disagree about a real plan.
//
// So everything here is driven from ONE review model that the SHIPPED read
// produced — `planReviewService.getPlanReview`, over a plan seeded through the
// shipped `plansService` calls into a real Postgres — and rendered through BOTH
// hosts. The story's central claim is that the planning surface and the plan
// page can never disagree about what a plan contains; this is where that stops
// being an architectural intention and becomes a measurement.
//
// ⚠️ The ARCHITECTURE half of this card ships separately, in
// `tests/planning/surfaceViewsOneComponent.test.ts`: neither host imports
// `PlanProposalList` / `PlanReviewCanvas` directly, and nothing but
// `PlanReviewCanvas` imports `planLevel`. That is a static read of the source,
// deliberately — a render cannot see an import a branch did not take — which is
// why it is not in this file.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };

// The plan page reads its view from the URL, so the params have to be SETTABLE:
// its switch writes the address and re-derives from it, and a frozen mock would
// leave the page on Canvas however many times the test pressed List.
const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

// ⚠️ THE CANVAS IS THE ONE THING STUBBED, and only its LEVEL READ. The parity
// claim is about the model both hosts draw from, not about the engine's
// geometry: `PlanReviewCanvas` fetches its own level over HTTP, which a Vitest
// process has no server for. The stub records the props it was handed — the
// items and the outcome — so the two hosts' canvas inputs can be compared
// exactly. `mergePlanLevel` stays the one edge engine; nothing here re-computes
// an edge.
const canvasProps: { items: unknown[]; outcome: string | null }[] = [];
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: (props: { items: unknown[]; outcome: string | null }) => {
    canvasProps.push({ items: props.items, outcome: props.outcome });
    return (
      <div data-testid="plan-review-canvas" data-count={props.items.length}>
        {props.items.map((raw) => {
          const item = raw as { planItemId: string; title: string; blockedByNodeIds: string[] };
          return (
            <div
              key={item.planItemId}
              data-node={item.planItemId}
              data-title={item.title}
              data-edges={(item.blockedByNodeIds ?? []).join(',')}
            />
          );
        })}
      </div>
    );
  },
}));

const { plansService } = await import('@/lib/services/plansService');
const { planReviewService } = await import('@/lib/services/planReviewService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanDetail } = await import('@/components/planning/PlanDetail');
const { PlanProposalViews } = await import('@/components/planning/PlanProposalViews');

let fx: WorkItemFixture;
const ctx = () => fx.ctx;

beforeEach(async () => {
  canvasProps.length = 0;
  search.value = '';
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
});

afterEach(() => cleanup());

/**
 * A plan the story's own verification recipe describes: three `add` subtasks
 * under one story, ONE OF THEM BLOCKED BY ANOTHER, plus a `modify` and a
 * `remove` of committed cards.
 *
 * ⚠️ TWO `addProposals` CALLS, and it is not a style choice: a `planItem:` ref
 * can only name a proposal the plan ALREADY HOLDS, so the blocked card's edge
 * cannot travel in the same batch as its blocker.
 */
async function seedProposedPlan(): Promise<{ planId: string; storyId: string }> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The planning surface', parentId: null },
    ctx(),
  );
  const doomed = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Superseded', parentId: story.id },
    ctx(),
  );
  const amended = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Old title', parentId: story.id },
    ctx(),
  );

  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Show the plan page views on the surface' },
    ctx(),
  );

  const first = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Lift the switch', kind: 'subtask' },
        parentRef: story.id,
      },
      { op: 'modify', workItemId: amended.id, patch: { title: 'New title' } },
      { op: 'remove', workItemId: doomed.id, reason: 'Folded into the lift' },
    ],
    ctx(),
  );
  const blockerRef = `planItem:${first.appendedItemIds[0]}`;

  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Mount it on the surface', kind: 'subtask' },
        parentRef: story.id,
        blockedByRefs: [blockerRef],
      },
      {
        op: 'add',
        proposedFields: { title: 'The E2E walk', kind: 'subtask' },
        parentRef: story.id,
      },
    ],
    ctx(),
  );
  await plansService.markPlanned(plan.id, ctx());

  return { planId: plan.id, storyId: story.id };
}

/** What the plan page's route hands its island — the SHIPPED read, once. */
const readReview = (planId: string): Promise<PlanReviewDto> =>
  planReviewService.getPlanReview(planId, ctx());

/** The canvas's node+edge model, as the host handed it to `PlanReviewCanvas`. */
function canvasModel(): { node: string; title: string; edges: string }[] {
  return [...document.querySelectorAll('[data-node]')]
    .map((el) => ({
      node: el.getAttribute('data-node')!,
      title: el.getAttribute('data-title')!,
      edges: el.getAttribute('data-edges') ?? '',
    }))
    .sort((a, b) => a.node.localeCompare(b.node));
}

describe('MOTIR-6187 · one review model, both hosts, the same drawing', () => {
  it('⭐ the surface and the plan page draw the SAME cards and the SAME edges', async () => {
    const { planId } = await seedProposedPlan();
    const review = await readReview(planId);

    // Sanity on the READ itself, so a parity of two empty renders cannot pass.
    expect(review.items.length).toBe(5);
    const pending = review.items.filter((i) => (i.blockedByNodeIds ?? []).length > 0);
    expect(pending.length).toBe(1);

    // ── the PLAN PAGE ────────────────────────────────────────────────────────
    const page = renderWithIntl(
      <PlanDetail initialReview={review} projectKey={fx.projectIdentifier} ariaLabel="Plan" />,
    );
    const pageCanvas = canvasModel();
    const pageCanvasProps = canvasProps.at(-1)!;
    page.unmount();
    cleanup();

    // ── the PLANNING SURFACE ─────────────────────────────────────────────────
    // Mounted the way `PlanningWorkspaceHost` mounts it: the same component, the
    // same review, the surface's own controlled view.
    renderWithIntl(
      <PlanProposalViews
        items={review.items}
        outcome={null}
        projectKey={fx.projectIdentifier}
        version={0}
        ariaLabel="Plan"
        view="canvas"
        onViewChange={() => {}}
        preserveCanvasLevel
      />,
    );
    const surfaceCanvas = canvasModel();
    const surfaceCanvasProps = canvasProps.at(-1)!;

    // The claim, measured rather than asserted architecturally.
    expect(surfaceCanvas).toEqual(pageCanvas);
    expect(surfaceCanvas.length).toBe(5);
    // …including the proposal's own PENDING edge, which is the part a hand-built
    // fixture is most likely to get wrong.
    expect(surfaceCanvas.filter((n) => n.edges !== '').length).toBe(1);
    expect(surfaceCanvasProps.items).toEqual(pageCanvasProps.items);
  });

  it('⭐ both hosts LIST the same rows for that one model', async () => {
    const { planId } = await seedProposedPlan();
    const review = await readReview(planId);

    const rows = () =>
      [...screen.getByTestId('plan-proposal-list').querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label')!)
        .sort();

    // The plan page, on List through its own URL contract — the very thing that
    // differs between the two hosts (Part XXI 21.4: the page owns the address
    // bar, the overlay never touches it), so it is exercised rather than bypassed.
    search.value = 'view=list';
    const page = renderWithIntl(
      <PlanDetail initialReview={review} projectKey={fx.projectIdentifier} ariaLabel="Plan" />,
    );
    const pageRows = rows();
    page.unmount();
    cleanup();

    renderWithIntl(
      <PlanProposalViews
        items={review.items}
        outcome={null}
        projectKey={fx.projectIdentifier}
        version={0}
        ariaLabel="Plan"
        view="list"
        onViewChange={() => {}}
        preserveCanvasLevel
      />,
    );

    expect(rows()).toEqual(pageRows);
    expect(pageRows.length).toBeGreaterThan(0);
  });

  it('⭐ a DECIDED plan reaches both bodies as the same outcome, from the real read', async () => {
    const { planId } = await seedProposedPlan();
    await plansService.approvePlan(planId, ctx());

    // The read AFTER the decision — the shipped one, not a mutated fixture.
    const decided = await readReview(planId);
    expect(decided.status).toBe('approved');

    renderWithIntl(
      <PlanProposalViews
        items={decided.items}
        outcome="accepted"
        projectKey={fx.projectIdentifier}
        version={1}
        ariaLabel="Plan"
        view="canvas"
        onViewChange={() => {}}
        preserveCanvasLevel
      />,
    );

    expect(canvasProps.at(-1)!.outcome).toBe('accepted');
    // …and the approve really did write the tree, which is what makes the
    // decided treatment a record of something rather than a style.
    const created = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId, title: 'Mount it on the surface' },
    });
    expect(created).toHaveLength(1);
  });

  it('⭐ approving is the same WRITE whichever body the reader was on', async () => {
    // The story's own words: "deciding from List behaves exactly as deciding from
    // Canvas". The press is the pane's, not either body's — so the committed
    // result must be identical. Two independently seeded plans, decided from the
    // two views, compared on the ROWS rather than on the call.
    const fromCanvas = await seedProposedPlan();
    await plansService.approvePlan(fromCanvas.planId, ctx());
    const canvasChildren = await adminDb.workItem.findMany({
      where: { parentId: fromCanvas.storyId, archivedAt: null },
      select: { title: true },
      orderBy: { title: 'asc' },
    });

    await truncateAuthTables();
    fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };

    const fromList = await seedProposedPlan();
    // The reader is on List; the bar is the pane's, so the same service call runs.
    renderWithIntl(
      <PlanProposalViews
        items={(await readReview(fromList.planId)).items}
        outcome={null}
        projectKey={fx.projectIdentifier}
        version={0}
        ariaLabel="Plan"
        view="list"
        onViewChange={() => {}}
        preserveCanvasLevel
      />,
    );
    expect(screen.getByTestId('plan-proposal-list')).toBeTruthy();
    await plansService.approvePlan(fromList.planId, ctx());
    const listChildren = await adminDb.workItem.findMany({
      where: { parentId: fromList.storyId, archivedAt: null },
      select: { title: true },
      orderBy: { title: 'asc' },
    });

    expect(listChildren).toEqual(canvasChildren);
    expect(listChildren.map((c) => c.title)).toContain('Mount it on the surface');
  });

  it('declining from either body writes NO work item, and ends the plan', async () => {
    const { planId, storyId } = await seedProposedPlan();
    const before = await adminDb.workItem.count({ where: { parentId: storyId } });

    await plansService.declinePlan(planId, ctx());

    const after = await adminDb.workItem.findMany({ where: { parentId: storyId } });
    expect(after).toHaveLength(before);
    expect((await readReview(planId)).status).toBe('declined');
    // …and the pre-decision review is still drawable, which is what lets the pane
    // keep the view the reader was on (MOTIR-3162).
    expect((await readReview(planId)).items.length).toBe(5);
  });

  it('the surface renders that model without importing either body itself', () => {
    // The architecture claim is asserted statically in
    // `tests/planning/surfaceViewsOneComponent.test.ts`; what is checked HERE is
    // the observable consequence, over a real model: one list, one canvas, never
    // two of either.
    renderWithIntl(
      <PlanProposalViews
        items={[]}
        outcome={null}
        projectKey={fx.projectIdentifier}
        version={0}
        ariaLabel="Plan"
        view="list"
        onViewChange={() => {}}
        preserveCanvasLevel
      />,
    );
    // Exactly ONE canvas, and it is the kept-alive one — never a second copy
    // rendered beside it, which is the shape a re-implementation would produce.
    expect(screen.getAllByTestId('plan-review-canvas')).toHaveLength(1);
    const keepalive = screen.getByTestId('plan-review-canvas-keepalive');
    expect(within(keepalive).getAllByTestId('plan-review-canvas')).toHaveLength(1);
  });
});
