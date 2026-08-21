// Plans-SURFACE E2E seed (Story MOTIR-3232 · Subtask MOTIR-3243).
//
// A tenant whose plans are arranged BY STATUS, with a known requester and a
// known decider — the axis the tabbed list, the attribution and the discard valve
// are all about. `plans-review-seed.ts` next door arranges by STALENESS, which is
// what its own spec walks; the two are deliberately separate helpers because
// they seed different things about the same table.
//
// ⚠️ THE BOUNDARY WITH THE SIBLING SPEC (MOTIR-3263). That one seeds by proposal
// TOPOLOGY — intra-plan `planItem:` parent refs, plans straddling containers —
// because the canvas legs are about a plan's SHAPE. Nothing here needs a
// topology beyond "one committed parent", and nothing there needs four statuses.
// Agreed rather than merged, so neither spec pays for the other's fixture.
//
// Everything rides the SHIPPED services (the one sanctioned cross-layer reach for
// E2E setup), so the statuses, the decision reasons and the attribution columns
// are produced by the same paths the product uses. No raw plan inserts.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

export const PLANS_SURFACE_PASSWORD = 'plans-surface-e2e-pass-7';

/** How many APPROVED plans the fixture seeds.
 *
 *  ⚠️ THIS NUMBER IS LOAD-BEARING, TWICE. It must exceed TWO pages (the read's
 *  default is ten) so the scroll-to-load leg can assert 10 → 20; and it must be
 *  enough rows that a ~600px viewport actually WINDOWS the list, which is the
 *  only way the shrink-on-tab-switch crash can occur at all. A component test
 *  cannot reach it: with no measurable viewport `useRowWindow` degrades to
 *  render-all and the stale window never bites. */
export const APPROVED_PLAN_COUNT = 22;

export interface PlansSurfaceSeed {
  email: string;
  password: string;
  /** The owner's ids — the spec decides a plan OUT OF BAND with them, to stage
   *  the 409 the surface has to survive. */
  userId: string;
  /** The OWNER — signs in, and is the DECIDER on every decided plan. */
  ownerName: string;
  /** The other person — the REQUESTER, so a decided row carries two names that
   *  are not the same name. A row showing one name twice would satisfy a weaker
   *  assertion and prove nothing. */
  requesterName: string;
  workspaceId: string;
  projectId: string;
  /** A `generating` plan holding proposals — the discard target. */
  generatingPlanId: string;
  /** A second `generating` plan, so the discard leg's tab is not left empty (an
   *  empty tab is a DIFFERENT screen, asserted on `Declined`). */
  secondGeneratingPlanId: string;
  /** A `generating` plan with NO proposals yet — the list view's own empty state.
   *
   *  ⚠️ IT HAS TO BE `generating`. A `planned` plan with no items never reaches
   *  the list at all: the detail short-circuits an empty undecided plan to the
   *  discovery hand-off, which is a different screen with different copy. The
   *  list's empty state is what a reader sees when they switch to it before the
   *  producer has written anything — so that is the state seeded. */
  emptyPlanId: string;
  /** A `planned` plan the spec decides out of band, to stage the 409. */
  concurrentlyDecidedPlanId: string;
  /** A `planned` plan under ONE committed parent — the detail leg's target, whose
   *  default view is therefore the CANVAS and whose switcher is what that leg
   *  tests (the derived list default is the sibling spec's). */
  detailPlanId: string;
  /** The titles the detail leg reads in the list view. */
  detailAddTitle: string;
  detailModifyTitle: string;
  /** One approved plan id, for the decided-row assertions — the NEWEST, so it is
   *  on the first cursor page and needs no scrolling to read. */
  decidedPlanId: string;
  /** The OLDEST approved plan — loaded only once every page has streamed, which
   *  is how the spec knows the list has reached its end without counting rows
   *  the window does not hold. */
  oldestApprovedPlanId: string;
}

async function makeTenant(email: string): Promise<{
  ctx: ServiceContext;
  projectId: string;
  ownerName: string;
}> {
  const ownerName = 'Yue Owner';
  const owner = await usersService.createUser({
    email,
    password: PLANS_SURFACE_PASSWORD,
    name: ownerName,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plans Surface E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Plans Surface',
    identifier: 'PSF',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // `/plans` is ACTIVE-PROJECT scoped, so pin it for the owner exactly as the
  // sibling seed does.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: owner.id, workspaceId: workspace.id }, projectId: project.id, ownerName };
}

export async function seedPlansSurface(email: string): Promise<PlansSurfaceSeed> {
  const { ctx, projectId, ownerName } = await makeTenant(email);

  // The REQUESTER — a second real person, so a decided row names two different
  // people and the roles are distinguishable rather than coincidentally equal.
  //
  // ⚠️ A MEMBER, not merely a row in `user`. The row resolves both parties'
  // names through `userRepository.findByIds` under the reader's workspace
  // binding; a user who is in no workspace resolves to `null`, and the
  // attribution entry renders NOTHING for an unknown requester — which is
  // correct behaviour and would make this fixture assert an absence while
  // looking like it asserted a name.
  const requesterName = 'Mara Requester';
  const requester = await usersService.createUser({
    email: `requester-${email}`,
    password: PLANS_SURFACE_PASSWORD,
    name: requesterName,
  });
  await workspacesService.addMember({ userId: requester.id, workspaceId: ctx.workspaceId });

  const plan = async (title: string) =>
    plansService.createPlan(projectId, { title, createdById: requester.id }, ctx);

  // ── APPROVED ×22 — the paging leg and the deep-scroll half of the shrink leg.
  // The list reads newest-first, so `i` counts UP as the rows go DOWN: index 21
  // is the top row and index 0 is the last row of all — which is why the OLDEST
  // is what proves the whole history has streamed.
  let decidedPlanId = '';
  let oldestApprovedPlanId = '';
  for (let i = 0; i < APPROVED_PLAN_COUNT; i += 1) {
    const p = await plan(`Approved plan ${String(i).padStart(2, '0')}`);
    await plansService.addProposals(
      p.id,
      [{ op: 'add', proposedFields: { title: `Approved proposal ${i}`, kind: 'task' } }],
      ctx,
    );
    await plansService.markPlanned(p.id, ctx);
    await plansService.approvePlan(p.id, ctx);
    if (i === APPROVED_PLAN_COUNT - 1) decidedPlanId = p.id;
    if (i === 0) oldestApprovedPlanId = p.id;
  }

  // ── PLANNED — the default tab. One of them is the DETAIL leg's target, seeded
  //    under ONE committed parent so its default view is the canvas.
  const committedParent = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Marketplace payouts' },
    ctx,
  );
  const committedTarget = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title: 'Payout ledger', parentId: committedParent.id },
    ctx,
  );

  const detailAddTitle = 'Reconciliation report';
  const detailModifyTitle = 'Payout ledger';
  const detail = await plan('Payout reconciliation');
  await plansService.addProposals(
    detail.id,
    [
      {
        op: 'add',
        proposedFields: { title: detailAddTitle, kind: 'task', type: 'code', storyPoints: 5 },
        parentRef: committedParent.id,
      },
      {
        op: 'modify',
        workItemId: committedTarget.id,
        patch: { title: 'Payout ledger + reconciliation' },
      },
    ],
    ctx,
  );
  await plansService.markPlanned(detail.id, ctx);

  const plannedIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const p = await plan(`Planned plan ${i}`);
    await plansService.addProposals(
      p.id,
      [{ op: 'add', proposedFields: { title: `Planned proposal ${i}`, kind: 'task' } }],
      ctx,
    );
    await plansService.markPlanned(p.id, ctx);
    plannedIds.push(p.id);
  }

  // ── GENERATING ×2 — the discard target, plus one that stays so the tab is not
  //    empty afterwards. `createPlan` leaves a plan `generating`; the proposals
  //    are what make the discard confirm's count non-zero.
  const generating = await plan('Stuck mid-generation');
  await plansService.addProposals(
    generating.id,
    [
      { op: 'add', proposedFields: { title: 'Half a thought', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Another half', kind: 'task' } },
    ],
    ctx,
  );
  const secondGenerating = await plan('Still going');
  await plansService.addProposals(
    secondGenerating.id,
    [{ op: 'add', proposedFields: { title: 'In progress', kind: 'task' } }],
    ctx,
  );
  // …and one that has proposed NOTHING yet — the list view's empty state.
  const emptyPlan = await plan('Nothing written yet');

  // ── DECLINED — deliberately EMPTY, so the per-tab empty state has a tab to be
  //    on. It is a different screen from the project-level one, which this
  //    project can never show because it holds plans.

  return {
    email,
    password: PLANS_SURFACE_PASSWORD,
    userId: ctx.userId,
    ownerName,
    requesterName,
    workspaceId: ctx.workspaceId,
    projectId,
    generatingPlanId: generating.id,
    secondGeneratingPlanId: secondGenerating.id,
    emptyPlanId: emptyPlan.id,
    concurrentlyDecidedPlanId: plannedIds[0]!,
    detailPlanId: detail.id,
    detailAddTitle,
    detailModifyTitle,
    decidedPlanId,
    oldestApprovedPlanId,
  };
}
