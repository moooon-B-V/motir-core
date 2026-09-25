import type { RunFoundReportOutcome } from '@/generated/prisma/client';
import { PLANNER_BUG_HOME_MARKER } from '@/lib/ai/plannerBugHome';
import { SystemPrincipalNotProvisionedError, resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { metaProjectKey } from '@/lib/ai/systemPrincipal';
import {
  RUN_FOUND_REPORT_REASON_MAX,
  RunFoundReportReasonInvalidError,
} from '@/lib/dispatchRuns/errors';
import type { WorkItemApprovedShapeVerdictDto } from '@/lib/dto/plans';
import {
  composeRunFoundPlanningBug,
  type RunFoundBugRegime,
} from '@/lib/plans/runFoundPlanningBug';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { runFoundReportRepository } from '@/lib/repositories/runFoundReportRepository';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';

// THE RUN-FOUND REPORT (Story MOTIR-5544 · Subtask MOTIR-6285) — what the server
// does when a dispatched runner stops because its target is UNBUILDABLE and says
// so through `report_unbuildable_target`. The accepted record is
// `docs/decisions/run-found-trigger-dispatched-path.md`; this header states only
// what the code does, and each rule below quotes the record.
//
// ── The permission composition ───────────────────────────────────────────────
// The MCP door checks ONE coarse key, `work_item:edit`. This service asserts the
// same key on the TARGET's project, so a caller who may not edit that card cannot
// report on it. The verdict and the approving plan are then read through
// `plansService.resolveApprovedShapeForReport`, which asserts NOTHING — in
// particular not `ai:view_plan`, which `CLI_TOKEN_GRANT` deliberately lacks. That
// is legitimate only because this service returns an ACKNOWLEDGEMENT and nothing
// else: *"what the gate protects never reaches the caller"*.
//
// ── The arms, in the record's order ──────────────────────────────────────────
// *"no open leg → nothing; `no_plan` → record; approving plan not `native` →
// record; `changed` → record; `native` and `unchanged` → record and file"*.
//
//   1. No open leg (read in the CALLER's tenant) — no row, no event, no bug.
//   2. The leg's filing row is claimed and LOCKED under `withSystemContext`
//      (the row is Motir's record, not the tenant's). A row that already carries
//      an outcome is a RETRY: *"A retried call finds the row and returns its
//      first outcome"* — same acknowledgement, nothing else done.
//   3. Otherwise the outcome is picked from the verdict and the approving plan's
//      SERVER-WRITTEN author, in that order.
//   4. On `filed` only, ONE planning bug is filed into Motir's planner-bug home
//      as the system principal, composed under the regime the caller's workspace
//      decides (verbatim in Motir's own, pointers only in a customer's).
//   5. The outcome is written onto the row, and the transaction commits.
//   6. The conclusion is recorded on the LEG, in the caller's tenant — the
//      runner's verbatim reason stays there (*"The runner's reason and the plan
//      title stay in the customer's tenant, on the leg's finding event"*).
//   7. The same acknowledgement on every leg arm.
//
// ⚠️ THE ACKNOWLEDGEMENT LEAKS NOTHING, THROUGH ITS CONTENT OR ITS SHAPE. It is
// one of two frozen constants below; neither carries the verdict, the plan, the
// outcome or a bug key, and the four leg arms return the SAME one. Whether a leg
// was open is the one bit it carries — the runner already knows whether it is
// running.

/** What the runner sends — the card and what is wrong with it, nothing more. */
export interface ReportUnbuildableTargetInput {
  /** The target's project key, resolved in the CALLER's workspace. */
  projectKey: string;
  /** The target's `KEY-<n>`, resolved inside `projectKey`. */
  targetKey: string;
  /** Why the runner cannot build it — the same text as its comment on the card. */
  reason: string;
}

/** The whole answer. Never the verdict, the plan, the outcome or a bug key. */
export interface RunFoundReportAcknowledgement {
  acknowledged: true;
  /** Whether the target had an OPEN leg on a running dispatch run. */
  recordedOnRun: boolean;
}

const NOT_ON_RUN: RunFoundReportAcknowledgement = Object.freeze({
  acknowledged: true,
  recordedOnRun: false,
});
const ON_RUN: RunFoundReportAcknowledgement = Object.freeze({
  acknowledged: true,
  recordedOnRun: true,
});

/**
 * The locked transaction's budget. The lock is HELD across the verdict read and
 * a cross-workspace create, and a concurrent report for the same leg WAITS on
 * that whole transaction inside its own — so the waiter's budget must cover the
 * holder's work, which Prisma's 5 s default does not reliably do under load.
 */
const RUN_FOUND_REPORT_TX_TIMEOUT_MS = 30_000;

type ApprovingPlan = Awaited<
  ReturnType<typeof plansService.resolveApprovedShapeForReport>
>['approvingPlan'];

/** What the locked transaction concluded, for the leg's event. Null = a retry. */
interface Concluded {
  /** Null only when the bug was owed but there is no system principal to file it. */
  outcome: RunFoundReportOutcome | null;
  verdict: WorkItemApprovedShapeVerdictDto;
  approvingPlan: ApprovingPlan;
  filingSkipped: 'no-system-principal' | null;
}

/** The record's order, and nothing else: `no_plan`, then author, then change. */
function pickOutcome(
  verdict: WorkItemApprovedShapeVerdictDto,
  approvingPlan: ApprovingPlan,
): RunFoundReportOutcome {
  // `approvingPlan` is null exactly when the verdict is `no_plan` (MOTIR-6284).
  if (approvingPlan === null) return 'no_plan';
  // Strict: `null` (a plan from before MOTIR-2996) and every non-`native`
  // member (`mcp`, `manual`, `api`) never fire — *"A plan with `mcp`, or any
  // value other than `native`, never fires a bug."*
  if (approvingPlan.authorSource !== 'native') return 'not_native';
  if (verdict.verdict === 'changed') return 'changed';
  return 'filed';
}

/**
 * The target, in the caller's workspace. An unknown project, a key from another
 * workspace and a project the caller may not browse all answer the SAME
 * `WorkItemNotFoundError` — nothing about the target's existence leaks.
 */
async function resolveTarget(
  input: ReportUnbuildableTargetInput,
  ctx: ServiceContext,
): Promise<{ id: string; projectId: string; identifier: string }> {
  const targetKey = input.targetKey.trim().toUpperCase();
  try {
    const project = await projectsService.getByKey(input.projectKey.trim(), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, targetKey, ctx);
    return { id: item.id, projectId: item.projectId, identifier: item.identifier };
  } catch (err) {
    if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(targetKey);
    throw err;
  }
}

export const runFoundReportService = {
  /**
   * Report that the caller's dispatched run found `targetKey` unbuildable. See
   * the file header for the arms; the answer is an acknowledgement only.
   *
   * @throws RunFoundReportReasonInvalidError — `reason` empty or over 4000 chars.
   * @throws WorkItemNotFoundError — the target does not exist for this caller.
   * @throws PermissionDeniedError — the caller may browse but not edit the target.
   */
  async reportUnbuildableTarget(
    input: ReportUnbuildableTargetInput,
    ctx: ServiceContext,
  ): Promise<RunFoundReportAcknowledgement> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > RUN_FOUND_REPORT_REASON_MAX) {
      throw new RunFoundReportReasonInvalidError(reason.length);
    }

    const target = await resolveTarget(input, ctx);
    await projectAccessService.assertPermission(target.projectId, ctx, 'work_item:edit');

    // Arm 1 — the leg, read in the CALLER's tenant under its own RLS.
    const leg = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => dispatchRunCardRepository.findOpenLegForWorkItem(target.id, tx),
    );
    if (!leg) return NOT_ON_RUN;

    const concluded = await withSystemContext(
      async (tx): Promise<Concluded | null> => {
        // Claim-or-lock, then decide from the LOCKED row — the
        // `dlqStandingDepthService.fileOne` shape. A concurrent report's insert
        // blocks on this one's uncommitted row, then its lock waits for this
        // whole transaction — the bug's creation included — and it reads the
        // outcome this one wrote.
        await runFoundReportRepository.insertIfAbsent(leg.id, leg.workspaceId, tx);
        const lockedId = await runFoundReportRepository.lockByLegId(leg.id, tx);
        /* v8 ignore next 3 -- unreachable: the row was inserted (or already
           present) in THIS transaction, so the lock finds it. */
        if (lockedId === null) {
          throw new Error(`run_found_report row for leg ${leg.id} vanished under its own lock`);
        }
        const row = await runFoundReportRepository.findById(lockedId, tx);
        /* v8 ignore next 3 -- unreachable: the re-read of the row just locked. */
        if (!row) {
          throw new Error(`run_found_report row for leg ${leg.id} vanished under its own lock`);
        }
        if (row.outcome !== null) return null;

        const { verdict, approvingPlan } = await plansService.resolveApprovedShapeForReport(
          target.projectId,
          target.id,
          ctx,
        );
        const outcome = pickOutcome(verdict, approvingPlan);
        if (outcome !== 'filed') {
          await runFoundReportRepository.markOutcome(row.id, { outcome }, tx);
          return { outcome, verdict, approvingPlan, filingSkipped: null };
        }

        // A deployment with no system principal (a self-hosted build, which has
        // no meta tenant) has nowhere to file. The row is left UNDECIDED, so a
        // later report on the same leg files once the principal exists; the
        // caller still gets the same acknowledgement.
        let principal: ServiceContext;
        try {
          principal = await resolveSystemPrincipal();
        } catch (err) {
          /* v8 ignore next -- defensive: any OTHER failure resolving the
             principal is an outage, and it rolls the claim back. */
          if (!(err instanceof SystemPrincipalNotProvisionedError)) throw err;
          return { outcome: null, verdict, approvingPlan, filingSkipped: 'no-system-principal' };
        }

        const regime: RunFoundBugRegime =
          ctx.workspaceId === principal.workspaceId ? 'motir_workspace' : 'customer_workspace';
        const { title, descriptionMd } = composeRunFoundPlanningBug(
          {
            workspaceId: ctx.workspaceId,
            projectId: target.projectId,
            workItemId: target.id,
            key: target.identifier,
            reason,
            verdict,
            // `filed` implies an approving plan (`pickOutcome` returns `no_plan`
            // for a null one). Its title is nullable on the row (an untitled
            // plan) and the composer takes a string, so an untitled plan maps
            // to ''. The composer's own `?? verdict.planTitle` fallback never
            // sees it — and would find null anyway: both read the same entry.
            plan: { ...approvingPlan!, title: approvingPlan!.title ?? '' },
            dispatchRunId: leg.dispatchRunId,
            dispatchRunCardId: leg.id,
            reportedAt: new Date().toISOString(),
          },
          regime,
        );

        // ⚠️ THE LOCK IS HELD ACROSS THE CREATE. `fileBug` owns its own
        // transactions and takes no `tx`, so this OUTER transaction holds the
        // filing row while the INNER ones insert the bug on disjoint rows, in
        // another workspace. A concurrent report blocks on the lock, then reads
        // the outcome and files nothing.
        //
        // ⚠️ THE ONE WINDOW THIS ACCEPTS is `reconcileIssue`'s (and
        // `dlqStandingDepthService.fileOne`'s): a crash after the bug commits and
        // before this transaction does leaves the row undecided, and the next
        // report on the leg files a second bug. Closing it would need the create
        // to join a caller's transaction, which it deliberately does not.
        const bug = await aiWorkItemsService.fileBug(
          {
            projectKey: metaProjectKey(),
            parentKey: PLANNER_BUG_HOME_MARKER,
            title,
            descriptionMd,
          },
          principal,
        );
        await runFoundReportRepository.markOutcome(
          row.id,
          { outcome, filedWorkItemId: bug.id, filedWorkItemIdentifier: bug.identifier },
          tx,
        );
        return { outcome, verdict, approvingPlan, filingSkipped: null };
      },
      { timeout: RUN_FOUND_REPORT_TX_TIMEOUT_MS },
    );

    // Arm 6 — on the LEG, in the CALLER's tenant, after the commit. Best-effort
    // like every finding (`recordFinding` swallows its own failures), and
    // idempotent per leg. A retry (`concluded === null`) records nothing more.
    if (concluded) {
      const { verdict, approvingPlan } = concluded;
      await dispatchRunService.recordFinding(
        {
          anchorWorkItemId: target.id,
          kind: 'unbuildable_reported',
          data: {
            outcome: concluded.outcome,
            verdict: verdict.verdict,
            planId: verdict.planId ?? approvingPlan?.id ?? null,
            proposalId: verdict.proposalId,
            divergingRevisionId: verdict.divergingRevision?.id ?? null,
            authorSource: approvingPlan?.authorSource ?? null,
            reason,
            ...(concluded.filingSkipped ? { filingSkipped: concluded.filingSkipped } : {}),
          },
        },
        ctx,
      );
    }

    return ON_RUN;
  },
};
