import { defineJob } from '../defineJob';
import type { WorkItemTransitionedData } from '../types';

// Bidirectional status derivation — the trigger seam (Story MOTIR-1615 · Subtask
// MOTIR-1621; `docs/decisions/status-derivation.md`). ONE consumer of the shared
// `work-item/transitioned` event dispatches BOTH directions:
//
//   * UPWARD   — `parentStatusRollupService.rollUpForChild`: the transitioned
//                item's PARENT follows its children's aggregate up the ladder.
//   * DOWNWARD — `childStatusCascadeService.cascadeToChildren`: if the item
//                entered a done-category status, its not-done CHILDREN complete.
//
// Consuming that one event is what makes derivation cover EVERY ingress — a board
// drag, the MCP `transition_status`, the CLI, the change-request webhook — without
// any of them knowing this exists. It is the automation-engine shape exactly
// (`automationEngine.ts`), with an id distinct from the watcher / bell /
// automation consumers of the same event so all of them coexist on Inngest.
//
// TWO STEPS, NOT ONE, and in this order. Each direction is its own durable
// `step.run`, so a retry after the rollup succeeded does not re-run it, and the
// pair is deterministic under redelivery. Rollup first: it is the direction that
// can CREATE the condition for the other (a parent rolling to done immediately
// cascades to any child that is somehow still open), so running it first
// converges in one delivery instead of two.
//
// RECURSION, AND WHY NO LOOP GUARD. Each service emits a fresh
// `work-item/transitioned` only when it really moved something, so this job
// re-fires for the grandparent (up) or the grandchildren (down) and stops when a
// level does not change — a no-op emits nothing. The two directions cannot loop
// either: a parent reaching done via cascade already has every child done, so the
// rollup over it is a no-op, and forward-only plus done-is-terminal precludes a
// cycle. Neither service throws for a business reason (both return a typed
// outcome), so an "impossible" derivation never fails the job behind a status
// change the user already made successfully.
//
// `retryPolicy: 'idempotent'`: both services converge on re-run — the rollup
// no-ops once the parent is in the target status, the cascade no-ops once no
// child is open — so a transient DB blip is worth the full retry budget.

export const statusDerivationOnTransitioned = defineJob(
  {
    id: 'status-derivation/transitioned',
    trigger: 'work-item/transitioned',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemTransitionedData;

    const rollup = await ctx.step.run('roll-up-parent', () =>
      services.parentStatusRollup.rollUpForChild(payload.workItemId),
    );
    const cascade = await ctx.step.run('cascade-to-children', () =>
      services.childStatusCascade.cascadeToChildren(payload.workItemId),
    );

    // Returned for the run log — which direction acted, and on what. Both
    // outcomes are always present, and most transitions produce two no-ops.
    return { rollup, cascade };
  },
);
