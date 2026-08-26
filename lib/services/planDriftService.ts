import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// PLAN DRIFT — who moves a plan between `planned` and `stale` (Bug MOTIR-3560 ·
// Subtask MOTIR-3579), implementing the transitions
// `docs/decisions/agent-authored-plans.md` AMENDMENT 9 D4/D5 ratified.
//
// ⚠️ EAGER IS WHAT SATISFIES THE INVARIANT, AND LAZY ALONE DOES NOT (D5). If a
// plan only left `planned` when somebody pressed Approve, then `planned` was
// still lying right up until the click and the queue was still full of plans
// nobody can act on — the same defect, discovered one step later. So the primary
// mover is a consumer of `work-item/transitioned`, and `approvePlan`'s
// in-transaction gate stays as the BACKSTOP for the race the listener can lose.
//
// ⚠️ EVERY METHOD HERE IS BEST-EFFORT AND RETURNS A TYPED OUTCOME. It runs
// AFTER a status change the user already made successfully; a failure here must
// never fail that transition or the job behind it. `statusDerivationService`'s
// header states the same rule for the same reason — "so an 'impossible'
// derivation never fails the job behind a status change the user already made".
// Nothing below throws for a business reason.
//
// ⚠️ THE TRIGGER IS A TRANSITION, NOT A STATE. Both entry points take the
// event's `from`/`to` and decide from them, resolved against
// `workflowsService.getTerminalStatusKeys` for the PLAN's project — never a
// hardcoded `'done'`, because `cancelled` is terminal too. A consumer keyed on
// the STATE re-fires on every later observation of it, which is the class
// MOTIR-2957 fixed in the cascade.

/** What one delivery did, for the job's log and for a test to assert on. */
export interface PlanDriftOutcome {
  /** Plans moved `planned → stale`. */
  markedStale: string[];
  /** Plans moved `stale → planned` because their drift reversed. */
  restored: string[];
  /** Plans examined and deliberately left alone (already decided, still holding
   *  another terminal target, or moved by somebody else under the lock). */
  skipped: string[];
}

const EMPTY: PlanDriftOutcome = { markedStale: [], restored: [], skipped: [] };

function outcome(over: Partial<PlanDriftOutcome>): PlanDriftOutcome {
  return { ...EMPTY, ...over };
}

/**
 * Is `statusKey` terminal in `projectId`? Resolved per project, and CACHED for
 * the life of one call: a work item can be targeted by proposals in several
 * plans, and in practice they share a project, so the naive form would ask the
 * same question once per plan on every status change in the tenant.
 */
function terminalResolver(workspaceId: string): (projectId: string) => Promise<Set<string>> {
  const cache = new Map<string, Promise<Set<string>>>();
  return (projectId: string) => {
    const hit = cache.get(projectId);
    if (hit) return hit;
    const miss = workflowsService.getTerminalStatusKeys(projectId, workspaceId);
    cache.set(projectId, miss);
    return miss;
  };
}

export const planDriftService = {
  /**
   * A work item ENTERED a terminal status: every `planned` plan proposing to
   * `modify` or `remove` it can no longer be approved, so it becomes `stale`.
   *
   * ⚠️ CONCURRENCY-SAFE BY LOCK-THEN-RE-READ, the shape `markPlanned` /
   * `approvePlan` / `declinePlan` all use. The work item's transition and the
   * plan's are two writes, so a plan can be approved, declined or already moved
   * between this listener reading it and writing it. A plan that is no longer
   * `planned` when the lock is taken is a NO-OP, not an error — it is recorded
   * in `skipped` and nothing is written.
   */
  async markStaleForTerminalTarget(
    workItemId: string,
    workspaceId: string,
    transition: { fromStatusKey: string; toStatusKey: string },
  ): Promise<PlanDriftOutcome> {
    const items = await withWorkspaceServiceContext(workspaceId, (tx) =>
      planItemRepository.findByWorkItemId(workItemId, workspaceId, tx),
    );
    if (items.length === 0) return EMPTY;

    const terminalFor = terminalResolver(workspaceId);
    const markedStale: string[] = [];
    const skipped: string[] = [];

    for (const planId of [...new Set(items.map((i) => i.planId))]) {
      const plan = await withWorkspaceServiceContext(workspaceId, (tx) =>
        planRepository.findById(planId, workspaceId, tx),
      );
      // Only a `planned` plan can go stale. A `generating` one is in front of
      // nobody and has nothing to be stale about; a decided one is over.
      if (!plan || plan.status !== 'planned') {
        if (plan) skipped.push(plan.id);
        continue;
      }

      const terminal = await terminalFor(plan.projectId);
      // ENTRY, read off the TRANSITION: it must not already have been terminal,
      // and it must be terminal now. A move BETWEEN two terminal statuses
      // (`done → cancelled`) changes nothing about approvability, and a plan
      // already stale for it was moved by the delivery that took it there.
      if (terminal.has(transition.fromStatusKey) || !terminal.has(transition.toStatusKey)) {
        skipped.push(plan.id);
        continue;
      }

      // ⚠️ `withWorkspaceServiceContext`, NOT `withWorkspaceContext` — a job has
      // no acting user to bind, and `plan`'s RLS policy is a PURE workspace gate
      // (`plan_active_workspace`), so the workspace tier is the whole predicate.
      // It opens a real transaction, which is what makes `lockById`'s
      // `FOR UPDATE` hold across the re-read below.
      const moved = await withWorkspaceServiceContext(workspaceId, async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) return false;
        const fresh = await planRepository.findById(planId, workspaceId, tx);
        // THE RE-READ IS THE RACE GUARD. Somebody may have approved or declined
        // this plan while the reads above were in flight.
        if (!fresh || fresh.status !== 'planned') return false;
        await planRepository.update(planId, { status: 'stale' }, tx);
        return true;
      });

      (moved ? markedStale : skipped).push(planId);
    }

    return outcome({ markedStale, skipped });
  },

  /**
   * A work item LEFT a terminal status: a `stale` plan whose every terminal
   * target has now revived returns to `planned`.
   *
   * ⚠️ THIS EDGE IS WHY A STATUS BEATS A FLAG (AMENDMENT 9 D4). `done →
   * in_progress` is a legal work-item transition, so a plan's premise can come
   * back — and without this a plan is punished permanently for a target that
   * was closed for an hour.
   *
   * ⚠️ IT IS *EVERY* TARGET, NOT THE ONE THAT MOVED. A plan proposing to modify
   * two items, both finished, is still unapprovable when one of them reopens —
   * `approvePlan`'s gate would refuse it on the other. Restoring on the first
   * revival would put it back in the queue wearing `planned`, which is exactly
   * the lie this whole container exists to remove.
   */
  async restoreForRevivedTarget(
    workItemId: string,
    workspaceId: string,
    transition: { fromStatusKey: string; toStatusKey: string },
  ): Promise<PlanDriftOutcome> {
    const items = await withWorkspaceServiceContext(workspaceId, (tx) =>
      planItemRepository.findByWorkItemId(workItemId, workspaceId, tx),
    );
    if (items.length === 0) return EMPTY;

    const terminalFor = terminalResolver(workspaceId);
    const restored: string[] = [];
    const skipped: string[] = [];

    for (const planId of [...new Set(items.map((i) => i.planId))]) {
      const plan = await withWorkspaceServiceContext(workspaceId, (tx) =>
        planRepository.findById(planId, workspaceId, tx),
      );
      if (!plan || plan.status !== 'stale') {
        if (plan) skipped.push(plan.id);
        continue;
      }

      const terminal = await terminalFor(plan.projectId);
      // EXIT, read off the transition: terminal before, not terminal now.
      if (!terminal.has(transition.fromStatusKey) || terminal.has(transition.toStatusKey)) {
        skipped.push(plan.id);
        continue;
      }

      // EVERY `modify`/`remove` target of THIS plan must now be non-terminal.
      const targets = await withWorkspaceServiceContext(workspaceId, (tx) =>
        planItemRepository.findByPlan(planId, tx),
      );
      const targetIds = targets
        .filter((i) => i.op !== 'add' && i.workItemId)
        .map((i) => i.workItemId!);
      const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
        workItemRepository.findByIdsInWorkspace(targetIds, workspaceId, tx),
      );
      // A target that has been DELETED cannot hold the plan back — there is
      // nothing left for approve to refuse over. An absent row is not terminal.
      const stillTerminal = rows.some((row) => terminal.has(row.status));
      if (stillTerminal) {
        skipped.push(planId);
        continue;
      }

      // ⚠️ `withWorkspaceServiceContext`, NOT `withWorkspaceContext` — a job has
      // no acting user to bind, and `plan`'s RLS policy is a PURE workspace gate
      // (`plan_active_workspace`), so the workspace tier is the whole predicate.
      // It opens a real transaction, which is what makes `lockById`'s
      // `FOR UPDATE` hold across the re-read below.
      const moved = await withWorkspaceServiceContext(workspaceId, async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) return false;
        const fresh = await planRepository.findById(planId, workspaceId, tx);
        if (!fresh || fresh.status !== 'stale') return false;
        await planRepository.update(planId, { status: 'planned' }, tx);
        return true;
      });

      (moved ? restored : skipped).push(planId);
    }

    return outcome({ restored, skipped });
  },
};
