import { defineJob } from '../defineJob';
import type { WorkItemTransitionedData } from '../types';

// PLAN DRIFT — the eager mover between `planned` and `stale` (Bug MOTIR-3560 ·
// Subtask MOTIR-3579; `docs/decisions/agent-authored-plans.md` AMENDMENT 9 D5).
//
// ONE consumer of the shared `work-item/transitioned` event, dispatching BOTH
// directions of one question — *can the plans that propose to change this item
// still be approved?*
//
//   * INTO `stale`   — the item ENTERED a terminal status, so every `planned`
//                      plan proposing to `modify` or `remove` it is now
//                      unapprovable and says so.
//   * BACK to `planned` — the item LEFT one, and if the plan has no other
//                      terminal target its premise has returned with it.
//
// Consuming that one event is what makes this cover EVERY ingress — a board
// drag, the MCP `transition_status`, the CLI, the change-request webhook —
// without any of them knowing this exists. It is `statusDerivation.ts`'s shape
// exactly, with an id distinct from the derivation / watcher / bell / automation
// consumers of the same event so all of them coexist on Inngest.
//
// ⚠️ EAGER IS THE POINT, AND LAZY ALONE WOULD NOT DO. If a plan only left
// `planned` when somebody pressed Approve, `planned` was still lying right up
// until the click and the queue was still full of plans nobody can act on — the
// same defect, discovered one step later. `approvePlan`'s in-transaction gate
// stays as the BACKSTOP for the race this listener can lose, not as the mover.
//
// ⚠️ TWO STEPS, NOT ONE, and they are MUTUALLY EXCLUSIVE by construction rather
// than by an `if` here. Each is its own durable `step.run`, so a retry after one
// succeeded does not re-run it; and each re-checks the transition against the
// PLAN's own terminal set, so a delivery that is an entry for one project's
// workflow and nothing for another's does the right thing per plan. Deciding it
// in the job would need a project this event does not carry.
//
// ⚠️ ENTRY AND EXIT ARE PROPERTIES OF THE TRANSITION, which is why both steps
// are handed the event's from/to rather than re-reading the item. MOTIR-2957 is
// the measured instance of the alternative failing: a racing recompute moved the
// row before the step ran, the step read the row, and the work the user asked
// for was silently declined. `retryPolicy: 'idempotent'`: both directions
// converge on re-run — each locks the plan and re-reads its status, so a second
// delivery finds nothing to do — and neither throws for a business reason, so a
// transient DB blip is worth the full retry budget and an "impossible" drift
// never fails the job behind a status change the user already made.

export const planDriftOnTransitioned = defineJob(
  {
    id: 'plan-drift/transitioned',
    trigger: 'work-item/transitioned',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;
    const transition = {
      fromStatusKey: payload.fromStatusKey,
      toStatusKey: payload.toStatusKey,
    };

    const marked = await ctx.step.run('mark-stale-for-terminal-target', () =>
      services.planDrift.markStaleForTerminalTarget(
        payload.workItemId,
        payload.workspaceId,
        transition,
      ),
    );

    const restored = await ctx.step.run('restore-for-revived-target', () =>
      services.planDrift.restoreForRevivedTarget(
        payload.workItemId,
        payload.workspaceId,
        transition,
      ),
    );

    return {
      markedStale: marked.markedStale.length,
      restored: restored.restored.length,
      skipped: marked.skipped.length + restored.skipped.length,
    };
  },
);
