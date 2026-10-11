import type { SubmittedRequirement } from '@/lib/ai/types';
import type {
  PlannerAssumptionDto,
  SharpenedRequirementDto,
  SharpeningWriteBackInput,
  SharpeningWriteBackResult,
} from '@/lib/dto/plans';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { trimTrailingNewlines, upsertSharpenedBlock } from '@/lib/sharpening/managedBlock';
import {
  SharpeningInputInvalidError,
  SharpeningPlanClosedError,
  SharpeningTargetFinishedError,
} from '@/lib/sharpening/errors';
import { plansService } from '@/lib/services/plansService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { StaleWorkItemError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The Sharpen WRITE-BACK (Task MOTIR-1101 · Subtask MOTIR-8175) — where the
// answers a person settled in a Sharpen session land, called by motir-ai's
// grilling session through `PUT /api/internal/ai/plan-sharpening`.
//
// Every call carries the CUMULATIVE state, and every write REPLACES rather than
// appends: the plan's `sharpenedRequirement` is stored whole, and a body edit
// only ever replaces the delimited block `managedBlock` owns. So a call after
// every answer and one call at stop leave the same result, and a person's
// hand-written text is never touched.
//
// Both scopes act as the JOB TOKEN'S USER, never a system context: a person who
// may not edit the target cannot have it edited for them.
//
//   • plan scope      → `ai:view_plan` (the plan gate) + edit on the plan's
//                       project; legal while `generating`, `planned` or `stale`; the
//                       requirement and every `perItem` proposal edit in ONE
//                       transaction under the plan's row lock.
//   • work-item scope → `work_item:edit` on the item's project (the ordinary
//                       work-item update path, which also records the history
//                       row); refused on a `done`-category status.
//
// ⚠️ DELIBERATELY NOT A `modify` PROPOSAL on a committed work item: the person
// running Sharpen is the one answering, so the answers are their own direct
// edit, made under their own permission — there is nobody else to approve it.

/** The headings the two managed blocks live under. */
const ACCEPTANCE_HEADING = 'Acceptance criteria';
const ASSUMPTIONS_HEADING = 'Assumptions';

/** How a planner assumption reads in a body, so a reader can tell it from an
 *  answer the person gave. */
const PLANNER_ASSUMPTION_PREFIX = "Planner's assumption —";

/** The requirement parts that render under `## Acceptance criteria`, in order.
 *  `assumptions` renders under its own heading. */
const ACCEPTANCE_PARTS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
] as const;

/** The plan statuses a write-back lands on: the editable pair every other plan
 *  edit uses, plus `stale`, which the Sharpen door opens on (design MOTIR-8173:
 *  "Sharpening still writes to it"). A decided plan is refused. */
const EDITABLE_PLAN_STATUSES = new Set(['generating', 'planned', 'stale']);

/** How many times a work-item write is retried after a concurrent edit moved
 *  the row between the read and the write. */
const STALE_RETRIES = 3;

const WORK_ITEM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function nonBlank(text: string | undefined): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/** The `## Acceptance criteria` block's content: every present requirement
 *  part's lines, in canonical order. Empty when nothing was settled. */
export function acceptanceContent(requirement: Partial<SubmittedRequirement>): string {
  return ACCEPTANCE_PARTS.map((part) => requirement[part])
    .filter(nonBlank)
    .map(trimTrailingNewlines)
    .join('\n');
}

/** The `## Assumptions` block's content: the requirement's own assumptions
 *  lines, then each planner assumption, prefixed. */
export function assumptionsContent(
  requirement: Partial<SubmittedRequirement>,
  plannerAssumptions: readonly PlannerAssumptionDto[],
): string {
  const lines: string[] = [];
  if (nonBlank(requirement.assumptions)) lines.push(trimTrailingNewlines(requirement.assumptions));
  for (const a of plannerAssumptions) {
    lines.push(`- ${PLANNER_ASSUMPTION_PREFIX} ${a.question} — ${a.recommendation}`);
  }
  return lines.join('\n');
}

/** Write both blocks into a body; a block with no content is not written (a
 *  cumulative call never removes what an earlier one settled). */
function sharpenBody(body: string, acceptance: string, assumptions: string): string {
  let next = body;
  if (acceptance) next = upsertSharpenedBlock(next, ACCEPTANCE_HEADING, acceptance);
  if (assumptions) next = upsertSharpenedBlock(next, ASSUMPTIONS_HEADING, assumptions);
  return next;
}

function bulletLines(lines: readonly string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `- ${l}`)
    .join('\n');
}

async function writeBackToPlan(
  planId: string,
  input: SharpeningWriteBackInput,
  ctx: ServiceContext,
): Promise<string> {
  const plan = await withWorkspaceContext(ctx, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  // The project comes from the PLAN row. The plan gate first — a person who
  // may not browse sees a 404 — then the write on the project.
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');
  await projectAccessService.assertCanEdit(plan.projectId, ctx);

  const settledAt = new Date().toISOString();
  await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      const locked = await planRepository.lockById(planId, tx);
      if (!locked) throw new PlanNotFoundError(planId);
      const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
      if (!fresh) throw new PlanNotFoundError(planId);
      if (!EDITABLE_PLAN_STATUSES.has(fresh.status)) {
        throw new SharpeningPlanClosedError(planId, fresh.status);
      }

      // Judge EVERY `perItem` before writing any of them, so a bad one refuses
      // the whole call rather than leaving half of it written (the transaction
      // would roll back anyway; this keeps the refusal typed and specific).
      const edits: Array<{ planItemId: string; descriptionMd: string }> = [];
      for (const entry of input.perItem ?? []) {
        const item = await planItemRepository.findById(entry.planItemId, tx);
        if (!item || item.planId !== planId) {
          throw new SharpeningInputInvalidError(
            `Proposal ${entry.planItemId} is not a proposal of plan ${planId}.`,
          );
        }
        if (item.op !== 'add') {
          throw new SharpeningInputInvalidError(
            `Proposal ${entry.planItemId} is a \`${item.op}\`; only an \`add\` proposal's body is written.`,
          );
        }
        const fields = (item.proposedFields ?? {}) as { descriptionMd?: string | null };
        const current = fields.descriptionMd ?? '';
        const next = sharpenBody(
          current,
          bulletLines(entry.acceptance),
          bulletLines(entry.assumptions),
        );
        if (next !== current) edits.push({ planItemId: item.id, descriptionMd: next });
      }
      for (const edit of edits) {
        await plansService.sharpenProposalBodyInTx(
          fresh,
          edit.planItemId,
          edit.descriptionMd,
          ctx,
          tx,
        );
      }

      const stored: SharpenedRequirementDto = {
        ...pickRequirement(input.requirement),
        plannerAssumptions: input.plannerAssumptions.map((a) => ({
          question: a.question,
          recommendation: a.recommendation,
        })),
        settledAt,
      };
      await planRepository.setSharpenedRequirement(planId, stored, tx);
    },
  );
  return settledAt;
}

/** Only the six requirement parts, and only the ones that are strings. */
function pickRequirement(r: Partial<SubmittedRequirement>): Partial<SubmittedRequirement> {
  const out: Partial<SubmittedRequirement> = {};
  for (const part of [...ACCEPTANCE_PARTS, 'assumptions'] as const) {
    const value = r[part];
    if (typeof value === 'string') out[part] = value;
  }
  return out;
}

async function writeBackToWorkItem(
  rawKey: string,
  input: SharpeningWriteBackInput,
  ctx: ServiceContext,
): Promise<void> {
  const key = rawKey.trim().toUpperCase();
  if (!WORK_ITEM_KEY.test(key)) {
    throw new SharpeningInputInvalidError('`scope.workItemKey` must look like `MOTIR-123`.');
  }
  const project = await projectsService.getByKey(key.slice(0, key.lastIndexOf('-')), ctx);
  const acceptance = acceptanceContent(input.requirement);
  const assumptions = assumptionsContent(input.requirement, input.plannerAssumptions);

  for (let attempt = 1; ; attempt += 1) {
    const item = await workItemsService.getWorkItemByIdentifier(project.id, key, ctx);
    // Edit first, status second: a person who may not edit learns nothing
    // about where the card stands.
    await projectAccessService.assertCanEdit(item.projectId, ctx);
    const terminal = await workflowsService.getTerminalStatusKeys(item.projectId, ctx.workspaceId);
    if (terminal.has(item.status)) throw new SharpeningTargetFinishedError(item.identifier);

    const current = item.descriptionMd ?? '';
    const next = sharpenBody(current, acceptance, assumptions);
    if (next === current) return;
    try {
      // The ordinary update path: the `work_item:edit` gate, the history row and
      // the activity all apply as for any edit. `expectedUpdatedAt` turns a
      // concurrent edit (or a status move to done) between the read above and
      // this write into a retry against the fresh row, never a lost update.
      await workItemsService.updateWorkItem(item.id, { descriptionMd: next }, ctx, {
        expectedUpdatedAt: item.updatedAt,
      });
      return;
    } catch (err) {
      if (err instanceof StaleWorkItemError && attempt < STALE_RETRIES) continue;
      throw err;
    }
  }
}

export const planSharpeningService = {
  /**
   * Store what a Sharpen session has settled so far on its target. Idempotent
   * and cumulative: the same input twice leaves the same bytes; a superset
   * replaces the managed blocks rather than adding second ones.
   */
  async writeBack(
    input: SharpeningWriteBackInput,
    ctx: ServiceContext,
  ): Promise<SharpeningWriteBackResult> {
    if ('planId' in input.scope) {
      const settledAt = await writeBackToPlan(input.scope.planId, input, ctx);
      return { scope: { planId: input.scope.planId }, settledAt };
    }
    if (input.perItem && input.perItem.length > 0) {
      throw new SharpeningInputInvalidError('`perItem` is only accepted on plan scope.');
    }
    await writeBackToWorkItem(input.scope.workItemKey, input, ctx);
    return {
      scope: { workItemKey: input.scope.workItemKey },
      settledAt: new Date().toISOString(),
    };
  },
};
