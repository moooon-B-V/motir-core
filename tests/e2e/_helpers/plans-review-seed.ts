// Plans-review E2E seed (Subtask 7.21.5 / MOTIR-1339).
//
// The Plans review surface (Story 7.21) is ACTIVE-PROJECT scoped — `/plans`
// resolves `getActiveProject()` — so each fixture mints its own tenant (a
// sign-in-able owner + workspace + project, the project PINNED active) and seeds
// plans entirely through the SHIPPED services (the one sanctioned cross-layer
// reach for E2E setup, exactly as `backlog-seed.ts` rides `backlogService`). No
// raw inserts: every plan rides `plansService.createPlan → addProposals →
// markPlanned` (and `approvePlan`), every committed work item rides
// `workItemsService.createWorkItem` / `archiveWorkItem` — so staleness is
// produced by the SAME tree-mutation path the product uses (mirrors
// `tests/integration/plans/planStalenessService.test.ts`).
//
// Staleness is COMPUTED on read (never stored). To make a `planned` plan stale
// deterministically we mutate the committed tree AFTER `markPlanned`:
//   • parent_removed  — archive the real parent a proposed `add` hangs under.
//   • blocker_removed — archive a committed item a proposed `add` declares
//     `blocked_by`. This one hangs under the LIVING parent, which is what puts a
//     badge on the canvas level the spec inspects: the archived parent's level is
//     not drawn, so a plan whose only stale proposal is the orphan renders no
//     badge at all.
//
// ⚠️ AND ONE MUTATION THAT MUST *NOT* FLAG ANYTHING (MOTIR-3777): a new child
// lands under that same still-living parent, after `plannedAt`, and a THIRD
// proposal sits beside it there declaring no edges at all. That used to raise
// `siblings_added` — a warning about somebody else's work, on the one surface
// whose whole purpose is to be trustworthy about a decision. The rule is retired
// and the fixture keeps the mutation, so one canvas level now carries both a
// badged proposal and an unbadged one under the SAME busy parent.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Satisfies the credential-strength rule (same shape as backlog-seed's).
export const PLANS_SEED_PASSWORD = 'plans-review-e2e-pass-7';

/**
 * A token with NO line-break opportunity, carried in the stale plan's SUMMARY
 * (MOTIR-4578). A plan summary holds an agent-written planning turn, so a
 * `snake_case` identifier this long is ordinary content rather than an
 * adversarial input — and at 59 characters it is comfortably past the ~43 the
 * rail's 311px text column can hold, which is what makes the geometric
 * assertion in `plans-review.spec.ts` able to go red at all.
 *
 * ⚠️ NO `-` and NO `/`: the browser takes a break opportunity at both, which is
 * why a 47-character PATH does not overflow and this does.
 */
export const PLAN_SUMMARY_UNBREAKABLE_TOKEN =
  'plan_summary_token_with_no_break_opportunity_whatsoever_ok';

export interface PlanRef {
  id: string;
}

export interface PlansReviewSeed {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  /** A `planned` plan made STALE (blocker_removed + parent_removed) — the one the
   *  spec reviews + approves-anyway. Its three proposed adds, by title: */
  stalePlan: PlanRef;
  /** Under the LIVE parent, declaring `blocked_by` a card archived after
   *  `plannedAt` → `blocker_removed`. Renders BADGED on the canvas level. */
  staleProposalBlockerGone: string;
  staleProposalOrphan: string; // proposed add under an archived parent → parent_removed
  /** Beside it under that SAME live parent, declaring nothing — and therefore NOT
   *  stale however many unrelated children land there (MOTIR-3777). The negative
   *  half of the fixture, and the one the spec follows through to /ready. */
  cleanProposalUnderBusyParent: string;
  /** A `planned`, NON-stale plan the spec declines. */
  declinePlan: PlanRef;
  declineProposal: string;
  /** An already-`approved` plan, so the list shows an Approved row independent of
   *  what the spec does. */
  approvedPlan: PlanRef;
}

async function makeTenant(
  email: string,
  workspaceName: string,
  projectName: string,
  identifier: string,
): Promise<{ ctx: ServiceContext; projectId: string }> {
  const owner = await usersService.createUser({
    email,
    password: PLANS_SEED_PASSWORD,
    name: 'Plans Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: projectName,
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // Pin the project active for the owner so the active-project-scoped /plans
  // route resolves it on sign-in (the same pin backlog-seed does for /backlog).
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { ctx: { userId: owner.id, workspaceId: workspace.id }, projectId: project.id };
}

/** The main fixture: a stale `planned` plan (approve target), a clean `planned`
 *  plan (decline target), and an already-`approved` plan. */
export async function seedPlansReview(email: string): Promise<PlansReviewSeed> {
  const { ctx, projectId } = await makeTenant(email, 'Plans E2E', 'Plans Review', 'PLR');

  // ── Stale planned plan ────────────────────────────────────────────────────
  // Two real parent stories the proposed adds hang under.
  const livingParent = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Onboarding epic' },
    ctx,
  );
  const doomedParent = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: 'Settings epic' },
    ctx,
  );
  // A committed card the first proposal declares a dependency on, archived below
  // after `plannedAt` — the surviving reason that keeps a badge on the canvas.
  const doomedBlocker = await workItemsService.createWorkItem(
    { projectId, kind: 'task', title: 'Design spike' },
    ctx,
  );

  const staleProposalBlockerGone = 'Onboarding wizard';
  const staleProposalOrphan = 'Settings revamp';
  const cleanProposalUnderBusyParent = 'Onboarding copy pass';
  const stale = await plansService.createPlan(
    projectId,
    {
      title: 'Q3 onboarding & settings',
      summary: `Wire up onboarding and refresh settings, per ${PLAN_SUMMARY_UNBREAKABLE_TOKEN}.`,
    },
    ctx,
  );
  await plansService.addProposals(
    stale.id,
    [
      {
        op: 'add',
        proposedFields: { title: staleProposalBlockerGone, kind: 'subtask' },
        parentRef: livingParent.id,
        blockedByRefs: [doomedBlocker.id],
      },
      {
        op: 'add',
        proposedFields: { title: staleProposalOrphan, kind: 'subtask' },
        parentRef: doomedParent.id,
      },
      {
        // ⚠️ NO `blockedByRefs`, and that is the point (MOTIR-3777).
        op: 'add',
        proposedFields: { title: cleanProposalUnderBusyParent, kind: 'subtask' },
        parentRef: livingParent.id,
      },
    ],
    ctx,
  );
  await plansService.markPlanned(stale.id, ctx);

  // Drift the committed tree AFTER plannedAt:
  //   • a new sibling under the living parent → NOTHING on either add hanging
  //     there, because neither declared an edge to it (MOTIR-3777);
  //   • archive the doomed parent → `parent_removed` on the second add;
  //   • archive the declared blocker → `blocker_removed` on the first add.
  await workItemsService.createWorkItem(
    { projectId, kind: 'subtask', title: 'Late onboarding addition', parentId: livingParent.id },
    ctx,
  );
  await workItemsService.archiveWorkItem(doomedParent.id, ctx);
  await workItemsService.archiveWorkItem(doomedBlocker.id, ctx);

  // ── Clean planned plan (decline target) ───────────────────────────────────
  const declineProposal = 'Marketing microsite';
  const decline = await plansService.createPlan(projectId, { title: 'Marketing push' }, ctx);
  await plansService.addProposals(
    decline.id,
    [{ op: 'add', proposedFields: { title: declineProposal, kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(decline.id, ctx);

  // ── Already-approved plan (list shows an Approved row + when-decided) ──────
  const approved = await plansService.createPlan(projectId, { title: 'Telemetry baseline' }, ctx);
  await plansService.addProposals(
    approved.id,
    [{ op: 'add', proposedFields: { title: 'Telemetry setup', kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(approved.id, ctx);
  await plansService.approvePlan(approved.id, ctx);

  return {
    email,
    password: PLANS_SEED_PASSWORD,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId,
    stalePlan: { id: stale.id },
    staleProposalBlockerGone,
    staleProposalOrphan,
    cleanProposalUnderBusyParent,
    declinePlan: { id: decline.id },
    declineProposal,
    approvedPlan: { id: approved.id },
  };
}

/** A tenant with a project but ZERO plans — for the empty-state CTA branch. */
export async function seedEmptyPlansProject(
  email: string,
): Promise<{ email: string; password: string }> {
  await makeTenant(email, 'Plans E2E — empty', 'No Plans Yet', 'EMP');
  return { email, password: PLANS_SEED_PASSWORD };
}
