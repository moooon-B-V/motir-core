import { resolveServiceProjectByKey } from '@/lib/ai/serviceAuth';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isPlannerBugHomeMarker } from '@/lib/ai/plannerBugHome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { JobRequestAuth } from '@/lib/ai/jobAuth';
import {
  NATIVE_PLANNER_HARNESS,
  PLANNER_BUG_FILED_CHANGE_KIND,
  PLANNER_BUGS_PER_JOB,
} from '@/lib/ai/plannerTenantBug';
import { NoPlanForJobError, PlannerBugCapExceededError } from '@/lib/plans/errors';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import type { PlanRevisionAgentActor } from '@/lib/services/planRevisionsService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The AI bug-filing write path (MOTIR-1450) — the ONE service method the
// internal `POST /api/internal/ai/work-items` route calls. The AI self-learning
// loop (965 inward / 967 outward, via the 1438 `log_planning_bug` engine tool)
// files a `kind: bug` into a NAMED project as the Motir SYSTEM principal.
//
// Thin by design: it RESOLVES the project + optional parent KEYS to ids and
// delegates to `workItemsService.createWorkItem`, so every guard — the
// kind-parent matrix, the 6.4 project-edit gate, the 404-not-403 tenant gate,
// the key allocation, the initial-status seed — runs in the create service
// UNCHANGED (no bypassed validation). This is the immediate-create analogue of
// the MCP `create_work_item` tool, but driven by the service-bearer principal
// (MOTIR-1451's `resolveServiceProjectByKey` + `ServiceContext`) rather than a
// cookie session or a PAT.

export interface FileServiceBugInput {
  /** The `PROD`-style key of the TARGET project (resolved within the system
   *  principal's workspace — 404-not-403 if it isn't there). */
  projectKey: string;
  title: string;
  descriptionMd?: string | null;
  /** Optional parent work-item key (e.g. `MOTIR-819`) in the SAME project, OR the
   *  drift-proof `PLANNER_BUG_HOME_MARKER` sentinel (`@planner-bug-home`), which
   *  FILES the bug into the project's PLANNER-BUG destination folder rather than
   *  parenting it (Story MOTIR-5818 · MOTIR-5822; the ladder is
   *  `bugDestinationService.resolvePlannerBug`). When omitted, the bug is filed
   *  into the project's BUG DESTINATION — its folder, or the project root (a
   *  top-level `bug` is matrix-legal). */
  parentKey?: string | null;
}

export const aiWorkItemsService = {
  async fileBug(input: FileServiceBugInput, ctx: ServiceContext): Promise<WorkItemDto> {
    const project = await resolveServiceProjectByKey(input.projectKey, ctx);

    let parentId: string | null = null;
    let plannerBug = false;
    const rawParentKey = input.parentKey?.trim() ?? '';
    if (rawParentKey !== '') {
      if (isPlannerBugHomeMarker(rawParentKey)) {
        // MOTIR-1466 — the DRIFT-PROOF path: the config carries the marker, not a
        // numeric key, so it never dangles across deploys. MOTIR-5822 — the marker
        // no longer names a PARENT at all. It used to resolve to a story found by
        // its title, and that story became a container every read treats as open
        // work (MOTIR-5296's shape, for the product bugs). It now FILES the bug
        // into the planner-bug destination, below, with `parentId` left null.
        plannerBug = true;
      } else {
        // A literal `MOTIR-<n>` identifier. The parent must live in the SAME
        // project. `getWorkItemByIdentifier` applies the tenant gate + browse check
        // and throws `WorkItemNotFoundError` (no existence leak) for an unknown /
        // cross-tenant key; the create service re-checks same-project + kind-legality.
        const parent = await workItemsService.getWorkItemByIdentifier(
          project.id,
          rawParentKey.toUpperCase(),
          ctx,
        );
        parentId = parent.id;
      }
    }

    // No parent ⇒ a FOLDER placement. The marker reads the PLANNER-bug ladder
    // (its destination → the product destination → the root, MOTIR-5822); no
    // parentKey at all reads the product BUG DESTINATION (Story MOTIR-4927 ·
    // MOTIR-4937). Every rung is legal, so neither path can fail for want of a
    // place. A named parent key is kept exactly as before, and never also filed
    // (`parentId` and `folderId` are exclusive).
    const folderId =
      parentId === null
        ? (
            await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
              plannerBug
                ? bugDestinationService.resolvePlannerBug(project.id, tx)
                : bugDestinationService.resolve(project.id, tx),
            )
          ).folderId
        : null;

    return workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'bug',
        title: input.title,
        parentId,
        folderId,
        descriptionMd: input.descriptionMd ?? null,
      },
      ctx,
    );
  },

  /**
   * File ONE `bug` into the JOB'S OWN project, as the job token's user (Story
   * MOTIR-4053 · Subtask MOTIR-4076) — the planner's `log_bug` sink, and the
   * FIRST non-proposal a planning run writes into a customer's tenant.
   * `motir-ai/docs/decisions/planner-files-tenant-bug.md` decides that it may,
   * and §3 fixes the bound this method enforces:
   *
   *   KIND     — `bug`, hard-wired; there is no kind argument to get wrong.
   *   PROJECT  — the token's `projectId` claim, never a body field. The job's
   *              plan must sit in THAT project, or the job resolves to no plan
   *              (404, the no-leak posture) — the same answer the append seam
   *              gives a job that is not this tenant's.
   *   VOLUME   — `PLANNER_BUGS_PER_JOB`, counted on the plan trail UNDER THE
   *              PLAN'S ROW LOCK, so two filings on one job cannot both pass.
   *   RECORD   — the item's native planning triple, and a `bug_filed` row on
   *              the plan's trail naming the key (the plan timeline renders it).
   *
   * ⚠️ THE CREATE RUNS INSIDE THE LOCKED TRANSACTION, THROUGH ITS OWN. The
   * outer transaction holds the plan row (`lockById`) so the count is
   * serialized; `workItemsService.createWorkItem` is not tx-injectable — it
   * owns its key allocation + insert in ONE transaction of its own, and every
   * create guard (kind-parent matrix, the edit gate, the 404-not-403 tenant
   * gate, RLS on the insert) runs there UNCHANGED. The two transactions touch
   * disjoint rows (the outer only ever locks `plan`), so there is no deadlock
   * and no lost update: a second filing blocks on the lock until this one has
   * committed its trail row, then counts it. The cost is a plan-row lock held
   * for one create (tens of milliseconds), which is what the bound is for.
   *
   * Placement (`parentKey`) is the tool's decision (MOTIR-4077); here it is
   * only resolved INSIDE the token's project — a key from anywhere else is
   * `WorkItemNotFoundError` (404), typed apart from a bad token's 401 so the
   * caller can tell "wrong project" from "not authenticated".
   */
  async filePlannerBug(
    input: FilePlannerBugInput,
    auth: JobRequestAuth,
  ): Promise<FiledPlannerBugDto> {
    const { ctx, projectId } = auth;

    // The job's plan, resolved like every seam beside it — by `sourceJobId`,
    // workspace-scoped through the bound read (a foreign tenant's plan is
    // INVISIBLE, not forbidden) — and then pinned to the TOKEN's project: a
    // token minted for project A may not file on a job whose plan is B's.
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(input.jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) throw new NoPlanForJobError(input.jobId);

    let parentId: string | null = null;
    const rawParentKey = input.parentKey?.trim() ?? '';
    if (rawParentKey !== '') {
      // Scoped to the token's project: the browse gate + tenant gate throw
      // `WorkItemNotFoundError` for a key in another project or tenant, and the
      // create service re-checks same-project + kind-legality.
      const parent = await workItemsService.getWorkItemByIdentifier(
        projectId,
        rawParentKey.toUpperCase(),
        ctx,
      );
      parentId = parent.id;
    }

    // The native planning triple (`work-item-provenance.md` Decision 5) — the
    // SAME values `materialize` stamps on a proposal, so a card the planner
    // filed and a card it proposed read the same author. The model is the
    // run's own (self-reported free text, trimmed, empty → null).
    const model = input.model?.trim() ?? '';
    const actor: PlanRevisionAgentActor = {
      source: 'native',
      harness: NATIVE_PLANNER_HARNESS,
      model: model === '' ? null : model,
    };

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const locked = await planRepository.lockById(plan.id, tx);
        if (!locked) throw new NoPlanForJobError(input.jobId);
        const filed = await planRevisionRepository.countByPlanAndKind(
          plan.id,
          PLANNER_BUG_FILED_CHANGE_KIND,
          tx,
        );
        if (filed >= PLANNER_BUGS_PER_JOB) {
          throw new PlannerBugCapExceededError(plan.id, PLANNER_BUGS_PER_JOB, filed);
        }

        // A planner bug that names no parent is one Motir files on its own, so it
        // goes where the project files those (MOTIR-4937) — read in this
        // transaction, under the same binding as the cap it is counted against.
        const folderId =
          parentId === null ? (await bugDestinationService.resolve(projectId, tx)).folderId : null;

        const dto = await workItemsService.createWorkItem(
          {
            projectId,
            kind: 'bug',
            title: input.title,
            parentId,
            folderId,
            descriptionMd: input.descriptionMd ?? null,
            provenance: {
              planning: { source: 'native', harness: actor.harness, model: actor.model },
            },
          },
          ctx,
        );

        // The RECORD, in the SAME transaction as the count it will be counted
        // by. `changedById` follows `createPlan`'s own rule: null on a `cadence`
        // plan, whose credential is the owner's and whose act is nobody's.
        await planRevisionsService.recordRevision(
          {
            planId: plan.id,
            changedById: plan.origin === 'cadence' ? null : ctx.userId,
            changeKind: PLANNER_BUG_FILED_CHANGE_KIND,
            actor,
            diff: { workItemId: dto.id, workItemKey: dto.identifier, title: dto.title },
          },
          tx,
        );

        return { key: dto.identifier, id: dto.id };
      },
    );
  },
};

/** The planner's `log_bug` input — what `POST /api/internal/ai/log-bug` carries. */
export interface FilePlannerBugInput {
  /** The planning job — resolves the plan the filing is recorded on and counted against. */
  jobId: string;
  title: string;
  descriptionMd?: string | null;
  /** Optional parent key (`MOTIR-<n>`), resolved INSIDE the token's project; omitted → the project's
   *  BUG DESTINATION, its folder or the project root (MOTIR-4937). */
  parentKey?: string | null;
  /** The run's planner model, for the item's provenance triple and the trail row. */
  model?: string | null;
}

/** What the filing returns — the KEY, because motir-ai's next act is to name it in `blockedByRefs`. */
export interface FiledPlannerBugDto {
  key: string;
  id: string;
}
