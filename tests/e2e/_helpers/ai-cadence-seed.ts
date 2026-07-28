// AI-cadence E2E seed (Story 7.13 · Subtask MOTIR-921).
//
// Stands up the tenant Story 7.13's acceptance spec drives — a project with
// schedulable leaf work (so AI sprint planning has something to pack), one
// `is_blocked_by` edge (so the packing's dependency order is a real constraint,
// not decoration), and ONE childless story stub (so the auto-plan cadence has a
// target to nominate).
//
// THE TWO BOUNDARY STUBS, and why they sit where they do:
//
//  * SPRINT PLANNING is driven from the BROWSER, so its motir-ai hop is stubbed
//    at the browser with `page.route` — the same open-core seam
//    `acceptance-augment-replan.spec.ts` uses. Only the SUBMIT, its SSE and the
//    review READ are stubbed; the recorded packing is resolved for render by
//    {@link buildSprintPlanReview} through the SHIPPED repository + mapper the
//    real `reviewSprintPlan` uses, and the APPROVE is left completely real
//    (`approveSprintPlan` takes the approved delta from the request body and
//    never calls motir-ai), so what the spec asserts afterwards is genuine
//    Epic-4 sprint state.
//
//  * THE CADENCE TICK has no browser in it at all — it is a cron sweep — so it
//    is driven from the test process through the sweep's OWN documented seam,
//    `CadenceDeps.submitExpand` ("isolated behind a seam so a unit test can
//    drive the sweep's decision logic without a live motir-ai"). Every gate the
//    card cares about (the pending-proposal gate, the ready-set drain, the stub
//    nomination) therefore runs as SHIPPED, and `origin: 'cadence'` is the value
//    the sweep itself passes — {@link runCadenceTick} only forwards it into
//    `createPlan`, exactly as `submitPlanEditJob` does. Nothing about the
//    provenance under test is fabricated here.
//
// The recorded proposals are appended through the same internal seam a plan-edit
// handler's callbacks use (`createPlan → addProposals → markPlanned`), which is
// what `seedPlanChangeProposal` documents: motir-ai's `planDelta` is empty by
// construction (MOTIR-1747), so the proposals ARE the plan rows.

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import {
  autoPlanCadenceService,
  type CadenceSweepSummary,
} from '@/lib/services/autoPlanCadenceService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';
import { SPRINT_ASSIGNMENT_DELTA_VERSION, type SprintAssignmentDelta } from '@/lib/ai/types';
import type { SprintPlanReviewDto, SprintPlanReviewItemDto } from '@/lib/dto/aiSprintPlan';
import type { PlanOriginDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

export const CADENCE_SEED_PASSWORD = 'ai-cadence-e2e-pass-7';

/** The stubbed `plan_sprint` job the browser submit echoes. */
export const SPRINT_JOB_ID = 'job_e2e_plan_sprint';

/** The sprint length the spec sets in settings and the recorded packing uses. */
export const SPRINT_LENGTH_DAYS = 2;
/** The auto-plan threshold the spec sets in settings. */
export const AUTO_PLAN_THRESHOLD = 2;
/** The per-day agent budget the recorded packing was sized against. */
const AGENT_MINUTES_PER_DAY = 240;

export interface AiCadenceSeed {
  email: string;
  password: string;
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
  /** Story: "Reporting" — the childless stub the cadence sweep nominates. */
  stubKey: string;
  /** The four schedulable subtasks, in seeded order. */
  formKey: string;
  apiKey: string;
  confirmKey: string;
  receiptKey: string;
}

/**
 * A sign-in-able tenant with four schedulable subtasks (one blocked by another)
 * plus a childless story stub.
 *
 * Both cadence settings start OFF: the spec turns them on through the settings
 * UI, which is the first chapter of the acceptance recording — seeding them on
 * would skip the surface under test.
 */
export async function seedAiCadence(email: string): Promise<AiCadenceSeed> {
  const owner = await usersService.createUser({
    email,
    password: CADENCE_SEED_PASSWORD,
    name: 'Cadence Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Cadence E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Cadence Delivery',
    identifier: 'CAD',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  const pid = project.id;

  // ── The schedulable work the packing draws from ──────────────────────────
  const epic = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'epic', title: 'Delivery' },
    ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'story', title: 'Checkout', parentId: epic.id },
    ctx,
  );

  const leaf = (title: string, estimateMinutes: number) =>
    workItemsService.createWorkItem(
      { projectId: pid, kind: 'subtask', title, parentId: story.id, type: 'code', estimateMinutes },
      ctx,
    );

  const form = await leaf('Payment form', 60);
  const api = await leaf('Payment API', 90);
  const confirm = await leaf('Order confirmation', 45);
  const receipt = await leaf('Receipt email', 30);

  // "Payment API" is blocked by "Payment form" — the ordering constraint the
  // packing must respect and the review's caption names.
  await db.workItemLink.create({
    data: {
      fromId: api.id,
      toId: form.id,
      kind: 'is_blocked_by',
      workspaceId: workspace.id,
      createdById: owner.id,
    },
  });

  // ── The cadence target: a childless, non-terminal story ──────────────────
  const stub = await workItemsService.createWorkItem(
    { projectId: pid, kind: 'story', title: 'Reporting' },
    ctx,
  );

  return {
    email,
    password: CADENCE_SEED_PASSWORD,
    ctx,
    projectId: pid,
    projectKey: project.identifier,
    stubKey: stub.identifier,
    formKey: form.identifier,
    apiKey: api.identifier,
    confirmKey: confirm.identifier,
    receiptKey: receipt.identifier,
  };
}

// ── The recorded `plan_sprint` packing ───────────────────────────────────────

/**
 * The packing the stubbed run "produced" — two short sprints sized to
 * {@link SPRINT_LENGTH_DAYS}, with the blocked item scheduled strictly after its
 * blocker (the constraint `validatePacking` re-derives from the live edges on
 * approve, so an inverted order here would fail the approve rather than pass
 * quietly).
 */
export function recordedSprintPacking(seed: AiCadenceSeed): SprintAssignmentDelta {
  const capacityMinutes = SPRINT_LENGTH_DAYS * AGENT_MINUTES_PER_DAY;
  const sprint = (
    n: number,
    itemKeys: string[],
    totalEstimateMinutes: number,
    rationale: string,
  ) => ({
    tempId: `sprint:${n}`,
    // The packer names positionally; `approveSprintPlan` drops a name still
    // matching `Sprint <n>` so the project's real ordinal is assigned.
    name: `Sprint ${n}`,
    lengthDays: SPRINT_LENGTH_DAYS,
    itemKeys,
    totalEstimateMinutes,
    capacityMinutes,
    oversizedKeys: [],
    rationale,
  });

  const sprints = [
    sprint(1, [seed.formKey, seed.confirmKey], 105, 'Unblocked work first.'),
    sprint(2, [seed.apiKey, seed.receiptKey], 120, `${seed.apiKey} waits on ${seed.formKey}.`),
  ];

  return {
    deltaVersion: SPRINT_ASSIGNMENT_DELTA_VERSION,
    sprintLengthDays: SPRINT_LENGTH_DAYS,
    capacityMinutes,
    agentMinutesPerDay: AGENT_MINUTES_PER_DAY,
    sprints,
    itemCount: sprints.reduce((n, s) => n + s.itemKeys.length, 0),
    totalEstimateMinutes: sprints.reduce((n, s) => n + s.totalEstimateMinutes, 0),
    unestimatedKeys: [],
    oversizedKeys: [],
  };
}

/**
 * Resolve a recorded packing into the `SprintPlanReviewDto` the review surface
 * binds — through the SAME repository read, edge read and mapper
 * `aiSprintPlanningService.reviewSprintPlan` uses, so the stubbed response
 * carries real database facts (titles, kinds, estimates, blocker captions)
 * rather than hand-written JSON that could drift from the rows the approve then
 * writes against.
 */
export async function buildSprintPlanReview(
  projectId: string,
  delta: SprintAssignmentDelta,
): Promise<SprintPlanReviewDto> {
  const keys = delta.sprints.flatMap((s) => s.itemKeys);
  const rows = await workItemRepository.findByIdentifiers(projectId, keys);
  const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));

  const edges = await workItemLinkRepository.findBlockedByEdges([...idToKey.keys()]);
  const blockersByKey = new Map<string, string[]>();
  for (const edge of edges) {
    const blockedKey = idToKey.get(edge.blockedId);
    const blockerKey = idToKey.get(edge.blockerId);
    if (blockedKey === undefined || blockerKey === undefined) continue;
    const list = blockersByKey.get(blockedKey);
    if (list) list.push(blockerKey);
    else blockersByKey.set(blockedKey, [blockerKey]);
  }

  const items: Record<string, SprintPlanReviewItemDto> = {};
  for (const row of rows) {
    items[row.identifier] = {
      item: toWorkItemSummaryDto(row),
      blockedByKeys: (blockersByKey.get(row.identifier) ?? []).sort(),
    };
  }

  return { jobStatus: 'succeeded', proposal: delta, items };
}

// ── The cadence tick ─────────────────────────────────────────────────────────

/** Titles the recorded expansion proposes under the nominated stub. Indexed per
 *  tick so a SECOND proposal is provably a different one, not a re-render. */
export function proposedChildTitles(round: number): string[] {
  return [`Weekly digest ${round}`, `Burndown chart ${round}`, `Export to CSV ${round}`];
}

export interface CadenceTickResult {
  summary: CadenceSweepSummary;
  /** The plan the sweep opened, when it fired; null when every project skipped. */
  planId: string | null;
  /** The origin the SWEEP asked for — recorded so the spec can assert the
   *  provenance came from the shipped code path, not from this helper. */
  origin: PlanOriginDto | null;
}

/**
 * Advance the cron ONE tick.
 *
 * `runCadenceSweep` runs exactly as shipped — the same three gates, the same
 * `countReady` predicate, the same stub nomination — with only the motir-ai
 * submit swapped for a recording of it: the deps seam opens the plan through
 * `plansService.createPlan` with the origin the SWEEP supplied (mirroring
 * `submitPlanEditJob`), then appends the recorded proposals through the
 * handler's own callbacks. No work item is created — an `add` proposal lives as
 * a `PlanItem` until a human approves.
 *
 * Deterministic by construction: nothing here waits on wall-clock time, and the
 * sweep re-derives every gate from live state.
 */
export async function runCadenceTick(round: number): Promise<CadenceTickResult> {
  let planId: string | null = null;
  let origin: PlanOriginDto | null = null;

  const summary = await autoPlanCadenceService.runCadenceSweep({
    deps: {
      submitExpand: async (itemKey, ctx, opts = {}) => {
        origin = opts.origin ?? 'user';
        const jobId = `job_e2e_cadence_${round}`;
        const plan = await plansService.createPlan(
          ctx.projectId,
          {
            title: `Expand ${itemKey}`,
            summary: null,
            sourceJobId: jobId,
            ...(opts.origin ? { origin: opts.origin } : {}),
          },
          ctx,
        );
        await appendRecordedProposals(plan.id, itemKey, round, ctx);
        planId = plan.id;
        return { jobId, planId: plan.id };
      },
    },
  });

  return { summary, planId, origin };
}

/**
 * Wait until the seed's ASYNC FAN-OUT has drained, before the spec drives any UI.
 *
 * Seeding through the shipped services is the point — but `createWorkItem`
 * publishes a real `work-item/created` event per item, and this lane runs a real
 * Inngest executor, so a seed of N items lands ~2N function runs that call back
 * into the app and each open their own transaction. Navigating into that burst
 * is a genuine race, and `/backlog` (which opens a transaction of its own to
 * render) loses it: Prisma cannot acquire a pooled connection inside its
 * `maxWait`, throws P2028, and the route 500s — so the surface under test never
 * renders at all. Observed exactly that way on this spec's first green-build run.
 *
 * So the wait is on the AUTHORITATIVE signal, never a sleep (CLAUDE.md § E2E):
 * the shipped 1.6 run ledger. Settled = no `running` row AND a ledger size that
 * stopped growing across two consecutive polls — the second clause is what covers
 * the gap between "event published" and "the row for it exists", which a
 * bare `running` check would read as quiet.
 */
export async function waitForSeedJobsToSettle(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    const [running, total] = await Promise.all([
      db.jobRun.count({ where: { status: 'running' } }),
      db.jobRun.count(),
    ]);
    stableRounds = running === 0 && total === lastCount ? stableRounds + 1 : 0;
    lastCount = total;
    if (stableRounds >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Falling out is not a failure: the ledger may simply still be busy on a
  // loaded runner, and the assertions that follow carry their own timeouts. The
  // wait exists to remove the common race, not to become a second failure mode.
}

/**
 * Open a PROPOSAL the way a USER-clicked expand does — same seam, `origin:
 * 'user'`. The pending-proposal gate is origin-INDEPENDENT by design, and this
 * is what lets the spec prove it: a plan nobody's cron started must suppress the
 * tick and read as paused exactly like a cadence-fired one.
 */
export async function seedUserClickedProposal(seed: AiCadenceSeed, round: number): Promise<string> {
  const plan = await plansService.createPlan(
    seed.projectId,
    { title: `Expand ${seed.stubKey}`, summary: null, sourceJobId: `job_e2e_user_${round}` },
    seed.ctx,
  );
  await appendRecordedProposals(plan.id, seed.stubKey, round, seed.ctx);
  return plan.id;
}

/** The handler's append callbacks: proposals in, then out of `generating`. */
async function appendRecordedProposals(
  planId: string,
  parentKey: string,
  round: number,
  ctx: ServiceContext,
): Promise<void> {
  const parent = await db.workItem.findFirst({ where: { identifier: parentKey } });
  await plansService.addProposals(
    planId,
    proposedChildTitles(round).map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'subtask', type: 'code' },
      ...(parent ? { parentRef: parent.id } : {}),
    })),
    ctx,
  );
  await plansService.markPlanned(planId, ctx);
}

// ── Ready-set control ────────────────────────────────────────────────────────

/**
 * Drive the project's ready set BELOW `threshold`, and return the count it
 * settled at.
 *
 * It marks ready leaves terminal one at a time, re-reading the count through the
 * SHIPPED `countReady` after each — the very predicate cadence gate 2 consults.
 * Asking the same question the gate asks is what makes the drain deterministic:
 * a spec that hardcoded "mark three done" would silently stop draining the day
 * the ready predicate changed, and the tick would then skip for a reason the
 * assertions could not see.
 */
export async function drainReadySetBelow(threshold: number, seed: AiCadenceSeed): Promise<number> {
  for (;;) {
    const { count } = await workItemsService.countReady(seed.projectId, {}, seed.ctx);
    if (count < threshold) return count;

    const ready = await workItemsService.listReady(seed.projectId, {}, seed.ctx);
    const next = ready.items[0];
    if (!next) return count;
    await db.workItem.update({ where: { id: next.id }, data: { status: 'done' } });
  }
}
