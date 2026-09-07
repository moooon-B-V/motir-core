import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import {
  parseSprintAssignmentDelta,
  SprintAssignmentValidationError,
} from '@/lib/ai/sprintAssignment';
import type { JobStreamEvent, SprintAssignmentDelta } from '@/lib/ai/types';
import type { SprintPlanReviewDto, SprintPlanReviewItemDto } from '@/lib/dto/aiSprintPlan';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';

import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { workflowsService } from '@/lib/services/workflowsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { readProject } from '@/lib/workspaces/tenantRead';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// AI SPRINT PLANNING (Story 7.13 · Subtask 7.13.5 · MOTIR-918) — the motir-core
// half of the `plan_sprint` seam: SUBMIT the packing job, STREAM its progress,
// and — behind a human approve — PERSIST the proposed packing by creating
// sprints and assigning their members through the SHIPPED Epic-4 sprint
// services.
//
// It REUSES Epic-4; it does not re-implement sprint CRUD. `sprintsService.
// createSprint` and `backlogService.bulkAssignToSprint` do every write, so the
// admin gate, the same-project guard, the fractional-rank append and the 1.4.6
// revisions are the ones the rest of the product already goes through. The only
// change this subtask made to them is an OPTIONAL `tx` parameter, so the whole
// approve commits atomically (below).
//
// THE GENERATE → APPROVE → PERSIST SEAM (Principle #1), applied to sprints:
// motir-ai proposes and holds NO write authority (its handler returns an empty
// `planDelta` and creates nothing); a human reviews and may EDIT the packing;
// only then does core write. Two consequences enforced here:
//
//   * RE-VALIDATE, DON'T RE-PACK. The approve body carries the APPROVED,
//     possibly human-edited packing. It is re-checked from scratch — shape
//     (`parseSprintAssignmentDelta`) then semantics (against live rows) — and
//     what persists is EXACTLY the approved packing. Approve never re-calls the
//     scheduler: that would silently discard the human's edits. Re-packing is an
//     explicit fresh submit.
//   * NEVER TRUST THE CLIENT. The delta arrives over the browser, so it is
//     untrusted input even though a job produced its ancestor. The semantic pass
//     re-derives every fact it needs (existence, project membership,
//     schedulability, the `is_blocked_by` ordering) from the database rather
//     than from anything the body asserts.
//
// 4-layer (CLAUDE.md): the routes parse and call ONE method each; this service
// owns the orchestration and the transaction; the sprint writes go through the
// Epic-4 services; no route touches Prisma.

/** Sprint planning is off for the project (`aiSprintPlanningEnabled = false`). */
export class SprintPlanningDisabledError extends Error {
  readonly code = 'SPRINT_PLANNING_DISABLED' as const;
  constructor(projectKey: string) {
    super(`AI sprint planning is not enabled for ${projectKey}`);
    this.name = 'SprintPlanningDisabledError';
  }
}

/**
 * The approved packing is well-formed but ILLEGAL against the live project — an
 * unknown / cross-project item key, a member that is not schedulable work, or an
 * assignment that inverts an `is_blocked_by` edge. Distinct from
 * `SprintAssignmentValidationError` (a malformed BODY) so the route can keep the
 * shape/semantic distinction, though both are a 400: the request is bad, and
 * nothing was written.
 */
export class SprintPlanApproveError extends Error {
  readonly code = 'SPRINT_PLAN_APPROVE_ERROR' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'SprintPlanApproveError';
  }
}

/** One sprint the approve created, tying the proposal's temp-ref to the real row. */
export interface CreatedSprintRef {
  /** The proposal's `sprint:<n>` temp-ref this resolved. */
  tempId: string;
  id: string;
  name: string;
  /** Members assigned to this sprint. */
  assignedCount: number;
}

export interface ApproveSprintPlanResult {
  sprints: CreatedSprintRef[];
  /** Total work items assigned across every created sprint. */
  assigned: number;
}

/**
 * The kinds a sprint can hold — the LEAF work the board dispatches. Epics and
 * stories are containers: they roll their children up rather than being
 * scheduled, so packing one would double-count the same estimate. This MIRRORS
 * the producer's `SCHEDULABLE_KINDS` (motir-ai's `plan_sprint` handler), which
 * is what makes the re-validation a genuine independent check of the same rule
 * rather than a different one.
 */
const SCHEDULABLE_KINDS = new Set(['subtask', 'task', 'bug']);

/**
 * Resolve the project row that carries the 7.13.2 AI-settings columns. The DTO
 * on `ProjectContext` does not project them, so the row is read here (the same
 * thing `autoPlanCadenceService` does for the auto-plan columns).
 */
async function loadProjectSettings(ctx: ProjectContext) {
  const project = await readProject(ctx.projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(ctx.projectId);
  }
  return project;
}

export const aiSprintPlanningService = {
  /**
   * Submit a `plan_sprint` job for the active project.
   *
   * This is the ONE submit path, deliberately: the manual "plan my sprints"
   * action and the 7.13.3 cadence sweep — which MAY fire sprint planning on the
   * same tick it fires an expansion — call this same method, so the two can
   * never drift on what a submit means or which settings it honours. Neither
   * creates a sprint: both land on the approve gate below.
   *
   * `aiSprintLengthDays` rides the envelope's `context.sprintPlanning` hole, so
   * motir-ai reads the project's cadence from the request and never from
   * motir-core config directly. The read-back token is freshly minted per submit
   * by `submitJob`.
   *
   * Unlike the plan-EDIT submits this opens NO `Plan`: `plan_sprint` proposes
   * sprint MEMBERSHIP, not work items, so it writes no `PlanItem` proposals and
   * has no proposal sink to bind to (its `planDelta` is empty by contract).
   *
   * Throws `SprintPlanningDisabledError` when the project has not opted in, and
   * the typed `MotirAiError`s on a submit failure (unreachable / out of credits).
   */
  async submitSprintPlan(ctx: ProjectContext): Promise<{ jobId: string }> {
    // `ai:plan` (MOTIR-2358) — ungated before this card.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const project = await loadProjectSettings(ctx);
    if (!project.aiSprintPlanningEnabled) {
      throw new SprintPlanningDisabledError(ctx.project.identifier);
    }

    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });

    // No `context.code`: the packing is a pure scheduling pass over the plan's
    // own sizing + `is_blocked_by` edges (read back over the token), so the
    // handler parses only the `sprintPlanning` hole. Sending the connected-repo
    // set would be an unread payload and a needless extra read per submit.
    return submitJob(
      'plan_sprint',
      {
        organizationId,
        isMeta,
        internalBilling,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        projectKey: ctx.project.identifier,
      },
      { sprintPlanning: { sprintLengthDays: project.aiSprintLengthDays } },
      { userId: ctx.userId },
    );
  },

  /** The live channel for a sprint-planning job — the 7.1.4 job stream, relayed
   *  by core. Browsers stream from CORE, never from motir-ai. */
  streamSprintPlan(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },

  /**
   * The REVIEW read (Subtask MOTIR-1750) — the proposed packing, RESOLVED for
   * render.
   *
   * The delta a `plan_sprint` job returns carries work-item KEYS and nothing
   * else, so the review surface needs two facts the browser cannot derive:
   *
   *  1. Each packed key's work item (title / kind / status / estimate) — the row
   *     the design draws is the shipped backlog row, which binds a
   *     `WorkItemSummaryDto`.
   *  2. The `is_blocked_by` edges AMONG the packed items — the per-row "after
   *     MOTIR-1749" caption. It is derived from the SAME
   *     `workItemLinkRepository.findBlockedByEdges` read `validatePacking` uses,
   *     so the caption can never disagree with the ordering the approve enforces.
   *     Edges to items outside the packing are dropped, exactly as there.
   *
   * READ-ONLY: it opens no transaction and writes nothing. It reuses
   * `parseSprintAssignmentDelta` as the shape gate so a malformed result is a 400
   * here too, rather than a half-rendered review — same discipline as approve,
   * one seam earlier.
   *
   * A job with no `sprintAssignment` yet (still running) or an EMPTY packing both
   * return a `null` / empty proposal rather than throwing: "nothing to schedule"
   * is a valid outcome the design draws (panel 4), not a failure.
   */
  async reviewSprintPlan(jobId: string, ctx: ProjectContext): Promise<SprintPlanReviewDto> {
    // `ai:plan` BEFORE the job read (MOTIR-2358): a gate behind `getJob` would
    // let an ungranted actor probe job ids for existence.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const job = await getJob(jobId, ctx.projectId);
    const raw = job.result?.sprintAssignment;
    if (!raw) return { jobStatus: job.status, proposal: null, items: {} };

    const delta = parseSprintAssignmentDelta(raw);
    const keys = delta.sprints.flatMap((s) => s.itemKeys);
    if (keys.length === 0) return { jobStatus: job.status, proposal: delta, items: {} };

    // `rows` are exactly the packed keys that resolve in this project, so
    // `idToKey` IS the in-packing set: an edge whose endpoint is missing from it
    // points outside the packing (or at another project), and is dropped — the
    // packing cannot order what it does not contain.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifiers(ctx.projectId, keys, tx),
    );
    const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));

    const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockedByEdges([...idToKey.keys()], tx),
    );
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
        // Stable order so two reads of the same packing render the same caption.
        blockedByKeys: (blockersByKey.get(row.identifier) ?? []).sort(),
      };
    }

    return { jobStatus: job.status, proposal: delta, items };
  },

  /**
   * Persist an APPROVED sprint packing.
   *
   * `editedDelta` is the packing the human approved — usually the job's own
   * proposal, possibly with edits. When absent, the job's result is read back
   * and used as-is (approving untouched). Either way it goes through the SAME
   * two-stage re-validation, because "it came from the job" is not a property
   * the server can verify of a request body.
   *
   * ATOMICITY: every create and every assignment runs inside ONE
   * `withWorkspaceContext` transaction, so a failure part-way through rolls the
   * WHOLE plan back — a project is never left holding half a sprint plan. That
   * is why the two Epic-4 methods grew an optional `tx`: composing them is what
   * makes the approve atomic, and re-implementing their writes here to get one
   * transaction would have been the worse trade (it would fork the sprint-write
   * rules).
   *
   * PERMISSIONS: the transaction runs as the SESSION user, so
   * `createSprint`'s owner gate (`assertSprintAdmin`) and every workspace/RLS
   * check apply exactly as they would to a hand-created sprint. A member who may
   * not create sprints cannot create them by approving an AI proposal.
   *
   * An EMPTY packing is a valid NO-OP: it opens no transaction and returns zero
   * counts, never an error.
   */
  async approveSprintPlan(
    jobId: string,
    editedDelta: unknown | undefined,
    ctx: ProjectContext,
  ): Promise<ApproveSprintPlanResult> {
    // `ai:plan`, asserted BEFORE anything is read back or materialized
    // (MOTIR-2358). Approving a sprint plan is the one write in this card whose
    // output is durable project data — real work items move into real sprints —
    // so the gate cannot sit after the plan is resolved.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    let raw: unknown;
    if (editedDelta !== undefined && editedDelta !== null) {
      raw = editedDelta;
    } else {
      const job = await getJob(jobId, ctx.projectId);
      if (!job.result?.sprintAssignment) {
        throw new SprintPlanApproveError(
          `Job ${jobId} carries no sprint-assignment result — job status is ${job.status}`,
        );
      }
      raw = job.result.sprintAssignment;
    }

    // Stage 1 — SHAPE. Throws `SprintAssignmentValidationError` (a 400) before
    // anything touches the database.
    const delta = parseSprintAssignmentDelta(raw);

    // Empty packing → nothing to do. Guarded here so the no-op costs no
    // transaction and no reads (`motir-core-coverage-gate`: the empty-input
    // branch is explicit, not incidental).
    if (delta.sprints.length === 0) return { sprints: [], assigned: 0 };

    // Stage 2 — SEMANTICS, against live rows.
    const members = await this.validatePacking(delta, ctx);

    const svcCtx: ServiceContext = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    const defaultNamePattern = /^Sprint \d+$/;

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const created: CreatedSprintRef[] = [];
        for (const proposed of delta.sprints) {
          // The packer names its sprints positionally ("Sprint 1", "Sprint 2" —
          // 1-based WITHIN the proposal), which on a project that already has
          // sprints would re-use a name and lose the project-global ordinal. So
          // a name still matching that generated pattern is DROPPED, letting
          // `createSprint` assign the project's real `Sprint <maxSequence + 1>`;
          // any other name is a human edit and is honoured verbatim (the approve
          // persists what was approved). This mirrors Jira, where the
          // auto-generated sprint name is board-global and a rename sticks.
          const name = defaultNamePattern.test(proposed.name) ? undefined : proposed.name;
          // The date WINDOW is deliberately left unset. `lengthDays` is a
          // capacity input to the packing, not a calendar commitment, and the
          // shipped lifecycle stamps the real window when the sprint actually
          // STARTS (`startSprint` overwrites `startDate` with now and takes
          // `endDate` from its own input) — so pre-filling a window here would
          // show the user dates that the start flow then discards.
          const sprint = await sprintsService.createSprint(
            ctx.projectId,
            { ...(name !== undefined ? { name } : {}) },
            svcCtx,
            tx,
          );

          // Resolve the proposal's real work-item ids IN THE PROPOSED ORDER —
          // `bulkAssignToSprint` appends in the order given, so the sprint's
          // backlog ranks come out in the scheduler's topological order.
          const itemIds = proposed.itemKeys.map((key) => {
            const id = members.get(key);
            /* c8 ignore next — validatePacking already proved every key resolves. */
            if (!id) throw new SprintPlanApproveError(`Work item ${key} vanished mid-approve`);
            return id;
          });
          await backlogService.bulkAssignToSprint(itemIds, sprint.id, svcCtx, tx);

          created.push({
            tempId: proposed.tempId,
            id: sprint.id,
            name: sprint.name,
            assignedCount: itemIds.length,
          });
        }
        return {
          sprints: created,
          assigned: created.reduce((sum, s) => sum + s.assignedCount, 0),
        };
      },
    );
  },

  /**
   * The SEMANTIC half of the re-validation: is this packing legal against the
   * live project? Runs entirely on reads, BEFORE the write transaction opens, so
   * an illegal packing is a 400 with nothing written.
   *
   * Four checks, each independent of anything the planner claimed:
   *
   *  1. EXISTS + IN THIS PROJECT — every `itemKey` resolves to a work item of
   *     `ctx.projectId`. A key from another project (or no project) is rejected,
   *     which is also the tenancy gate on this body: a cross-tenant key is
   *     indistinguishable from a typo, and neither writes.
   *  2. SCHEDULABLE KIND — a leaf kind (`subtask` / `task` / `bug`). An epic or
   *     story is a container that rolls its children up; scheduling one would
   *     double-count its estimate.
   *  3. NOT ALREADY FINISHED — not in one of the project's terminal statuses.
   *     There is nothing left to schedule, and re-sprinting done work is exactly
   *     the done-work immutability the plan-edit gate enforces one seam over.
   *  4. THE `is_blocked_by` DAG IS RESPECTED — for every edge between two packed
   *     items, the BLOCKER is positioned strictly before the item it blocks, in
   *     the flattened (sprint index, position within sprint) order. That single
   *     comparison covers both halves of the producer's guarantee: no item sits
   *     in an earlier sprint than something blocking it, AND within one sprint
   *     members are in dependency order.
   *
   * Note what is deliberately NOT checked: that a member is in the READY set.
   * The producer packs the project's schedulable OPEN LEAVES, blocked ones
   * included — putting currently-blocked work into a LATER sprint is the entire
   * point of a dependency-aware multi-sprint packing. Requiring ready-set
   * membership would reject nearly every valid plan. Check 4 is what actually
   * enforces the ordering the ready set is a proxy for.
   *
   * Returns the key → work-item-id map the persist assigns with, so the rows are
   * read once rather than re-resolved per sprint.
   */
  async validatePacking(
    delta: SprintAssignmentDelta,
    ctx: ProjectContext,
  ): Promise<Map<string, string>> {
    const keys = delta.sprints.flatMap((s) => s.itemKeys);
    if (keys.length === 0) return new Map();

    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifiers(ctx.projectId, keys, tx),
    );
    const byKey = new Map(rows.map((r) => [r.identifier, r]));

    const missing = keys.filter((k) => !byKey.has(k));
    if (missing.length > 0) {
      throw new SprintPlanApproveError(
        `unknown work item(s) in this project: ${missing.join(', ')}`,
      );
    }

    const terminalKeys = await workflowsService.getTerminalStatusKeys(
      ctx.projectId,
      ctx.workspaceId,
    );
    for (const key of keys) {
      const row = byKey.get(key)!;
      if (!SCHEDULABLE_KINDS.has(row.kind)) {
        throw new SprintPlanApproveError(
          `${key} is a ${row.kind} — only leaf work (subtask / task / bug) can be assigned to a sprint`,
        );
      }
      if (terminalKeys.has(row.status)) {
        throw new SprintPlanApproveError(`${key} is already finished (${row.status})`);
      }
    }

    // Flatten the packing into a single position axis, then assert every edge
    // points backwards along it.
    const position = new Map<string, number>();
    let next = 0;
    for (const sprint of delta.sprints) {
      for (const key of sprint.itemKeys) position.set(key, next++);
    }
    const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));
    const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockedByEdges([...idToKey.keys()], tx),
    );
    for (const edge of edges) {
      const blockedKey = idToKey.get(edge.blockedId);
      const blockerKey = idToKey.get(edge.blockerId);
      // An edge to an item OUTSIDE the packing constrains nothing here: the
      // packing cannot order what it does not contain, and readiness against
      // unpacked blockers stays the board's job (the same rule the producer's
      // scheduler applies — it ignores edges pointing outside its offered set).
      if (blockedKey === undefined || blockerKey === undefined) continue;
      const blockedAt = position.get(blockedKey)!;
      const blockerAt = position.get(blockerKey)!;
      if (blockerAt >= blockedAt) {
        throw new SprintPlanApproveError(
          `${blockedKey} is blocked by ${blockerKey}, but the packing schedules ${blockerKey} no earlier — the is_blocked_by order is inverted`,
        );
      }
    }

    return new Map(rows.map((r) => [r.identifier, r.id]));
  },
};

export { SprintAssignmentValidationError };
