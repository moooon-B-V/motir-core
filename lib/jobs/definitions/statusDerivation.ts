import { defineJob } from '../defineJob';
import type {
  WorkItemChildSetChangedData,
  WorkItemCreatedData,
  WorkItemDerivationRequestedData,
  WorkItemTransitionedData,
} from '../types';

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
// rollup over it is a no-op, and a parent LEAVING done starts no downward wave,
// because the cascade fires only on ENTRY into a done-category status (ADR §5's
// termination argument, part 2 — the clause that replaced this line's old appeal
// to forward-only, which rung 4 retired). Neither service throws for a business
// reason (both return a typed outcome), so an "impossible" derivation never fails
// the job behind a status change the user already made successfully.
//
// ⚠️ AND "ENTRY" IS A PROPERTY OF THE TRANSITION, WHICH IS WHY THE CASCADE STEP
// BELOW IS HANDED THE EVENT'S from/to (MOTIR-2957). Part 2 of that argument only
// holds if the cascade a done-entry schedules actually RUNS. It used to be
// decided by re-reading the item, so a rung-4 recompute landing in between — from
// a sibling `work-item/created` job for a child created just before the parent was
// set Done — moved the parent to `todo` and the cascade then saw a not-done row and
// declined. Neither direction acted, the child set never changed again, and the
// parent sat at `todo` with the user's Done gone. Measured 7 times in 20 on
// `origin/main` @ `a09c21ee`.
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
      services.parentStatusRollup.rollUpForChild(payload.workItemId, payload.workspaceId),
    );
    // The cascade is decided by the TRANSITION this event carries, not by re-reading
    // the item — MOTIR-2957. See `CascadeTrigger`: a rung-4 recompute racing in from a
    // sibling `work-item/created` job can move the item out of `done` before this step
    // runs, and a row read then cancels the cascade the user's Done asked for.
    const cascade = await ctx.step.run('cascade-to-children', () =>
      services.childStatusCascade.cascadeToChildren(payload.workItemId, payload.workspaceId, {
        fromStatusKey: payload.fromStatusKey,
        toStatusKey: payload.toStatusKey,
      }),
    );

    // Returned for the run log — which direction acted, and on what. Both
    // outcomes are always present, and most transitions produce two no-ops.
    return { rollup, cascade };
  },
);

// ── The CHILD-SET triggers (Story MOTIR-2888 · Subtask MOTIR-2892, ADR §3a) ──
//
// Derivation used to ride `work-item/transitioned` alone, which was sufficient
// for a ladder CLIMB — a climb is caused by a child moving along the ladder. It
// is not sufficient for a RECOMPUTE, which is a function of the child SET: every
// edit to that set has to run it. The case the whole story exists for — a `todo`
// child added to a `done` parent — fired nothing whatsoever.
//
// The two consumers below close that surface. Neither runs the DOWNWARD cascade:
// it fires only on an item ENTERING a done-category status, and none of these
// edits transitions anything. Keeping it out is load-bearing rather than tidy —
// a parent that has just come BACK to `todo` must not turn round and force-close
// the child that brought it there.
//
// `retryPolicy: 'idempotent'` for the same reason the transition consumer has
// it: a recompute converges on re-run, so a transient DB blip is worth the full
// retry budget.

export const statusDerivationOnCreated = defineJob(
  {
    // Distinct from `automation-engine/created` and `outward-bug-telemetry/created`,
    // the other two consumers of this event — the shipped single-event /
    // many-consumers fan-in.
    id: 'status-derivation/created',
    trigger: 'work-item/created',
    retryPolicy: 'idempotent',
    // ── DEBOUNCED ON THE PARENT (Bug MOTIR-2902) ───────────────────────────
    //
    // THE DEFECT. A bulk import writes each row in TWO phases: `createWorkItem`
    // (which emits this event) and then `setImportedStatus`, which is documented
    // as deliberately emitting NOTHING so an import cannot fan out one
    // notification per row. So this event is the ONLY derivation trigger an
    // import produces, and undebounced this consumer reads the child's status
    // at whatever instant it happens to run:
    //
    //   run AFTER the pin   → sees `in_progress` → parent `in_progress`   ✅
    //   run BEFORE the pin  → sees `todo`        → parent `todo`          ❌
    //
    // and the losing arm is TERMINAL, not late: the child set never changes
    // again, so nothing re-fires. `tests/e2e/import.spec.ts` caught it as a
    // ~1-in-3 red on PRs touching neither the importer nor derivation.
    //
    // WHY A DEBOUNCE FIXES IT. The window RESETS on each same-key event, so the
    // recompute runs once, `period` after the LAST create under that parent —
    // by which time that row's pin (microseconds later, same call stack) has
    // long committed. The margin is ~3 orders of magnitude, not a coin flip.
    // It also collapses the redundant recomputes an import generates: a
    // 5 000-row import recomputed one parent 5 000 times, each taking a row
    // lock and reading an aggregate.
    //
    // `key` — the PARENT. See `WorkItemCreatedData.parentId` for why anything
    // wider silently drops recomputes and anything narrower is inert.
    // `period` — long enough to clear a create→pin gap by orders of magnitude,
    // short enough to stay well inside the 15 s the e2e poll allows.
    // `timeout` — caps the total deferral so a continuously streaming import
    // cannot postpone derivation indefinitely; the stream's own tail still
    // produces a final run after its last event.
    debounce: { key: 'event.data.parentId', period: '2s', timeout: '30s' },
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemCreatedData;
    // No payload change was needed: `rollUpForChild` re-reads the item and finds
    // its parent itself. A root item returns `no_parent` after one indexed read,
    // which is the cheap no-op this event needs — it fires on EVERY item
    // creation in the workspace.
    return ctx.step.run('recompute-parent', () =>
      services.parentStatusRollup.rollUpForChild(payload.workItemId, payload.workspaceId),
    );
  },
);

export const statusDerivationOnChildSetChanged = defineJob(
  {
    id: 'status-derivation/child-set-changed',
    trigger: 'work-item/child-set.changed',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemChildSetChangedData;

    // A re-parent carries TWO parents and both are recomputed; an archive /
    // unarchive / delete carries one. Each gets its OWN durable `step.run` — the
    // same reason the transition consumer splits its two directions: a retry
    // after the first parent succeeded must not redo it, and the two parents are
    // independent recomputes that must not share a failure.
    //
    // ORDER IS NOT SIGNIFICANT and must not be relied on. Each parent's target
    // is a pure function of its OWN children, so the pair commutes — which is
    // exactly what lets a move's two ends be two steps instead of one
    // transaction spanning both.
    // The edit's own instant is carried BECAUSE these four edits remove the row
    // that changed (MOTIR-2965). A create or a transition leaves its mark on a
    // live child, so the aggregate dates it; an archive / re-parent / delete
    // leaves the set with nothing to read, and a backward set that could not date
    // itself would stand down for a parent status it is entitled to correct.
    const trigger = { occurredAt: new Date(payload.occurredAt) };

    const outcomes = [];
    for (const [i, parentId] of payload.parentIds.entries()) {
      outcomes.push(
        await ctx.step.run(`recompute-parent-${i}`, () =>
          services.parentStatusRollup.recomputeParent(parentId, payload.workspaceId, trigger),
        ),
      );
    }
    return { reason: payload.reason, outcomes };
  },
);

// ── The SILENT-EDIT trigger (Bug MOTIR-2902) ────────────────────────────────
//
// The fourth consumer, and the one that closes the import race. The three above
// all ride an edit that announces itself. `setImportedStatus` is an edit that
// does not: it pins an imported child's mapped status and deliberately emits no
// `work-item/transitioned`, so a bulk import cannot fan out one notification per
// row. That contract is right and is untouched here.
//
// Without this consumer the only derivation trigger an import produced was the
// `work-item/created` that fired BEFORE the pin, so the recompute could read the
// child as `todo`, settle the parent at `todo`, and never re-fire — the child set
// never changes again, so the wrong answer was TERMINAL rather than late.
//
// ⚠️ WHY A DEDICATED EVENT AND NOT `work-item/child-set.changed`. That event's
// contract is "the child that entered or left the set", and a status pin changes
// no membership at all. Overloading its `reason` enum would have been a smaller
// diff and a worse one: the next reader would find a set-change event that does
// not change the set. A dedicated event also keeps the property this fix depends
// on — derivation is its ONLY consumer, so nothing here can reintroduce the
// notification storm the import avoids.
//
// ⚠️ AND WHY NOT RELY ON THE DEBOUNCE. `status-derivation/created` is debounced
// on the parent, which would usually move its run past the pin. Measured on this
// card's own PR (#2114), the Inngest DEV SERVER — what the E2E lane and every
// self-hosted run use — ignores `debounce` entirely: 126 `work-item/created`
// events produced 126 function initializations, 4.7 ms after the event, against
// a configured 2 s period. A fix that depends on the scheduler honouring an
// option is untestable where the scheduler does not. This one depends only on an
// event being emitted, so it holds everywhere.

export const statusDerivationOnRequested = defineJob(
  {
    id: 'status-derivation/requested',
    trigger: 'work-item/derivation.requested',
    retryPolicy: 'idempotent',
    // Same key and reasoning as `status-derivation/created`: a bulk import pins
    // many children of one parent, and only the last recompute's answer differs
    // from the one before it. Where the scheduler honours it this collapses the
    // fan-out; where it does not, correctness is unaffected — that is the whole
    // point of putting the guarantee in the event rather than the window.
    debounce: { key: 'event.data.parentId', period: '2s', timeout: '30s' },
  },
  async (ctx, services) => {
    const payload = ctx.event.data as WorkItemDerivationRequestedData;

    // `recomputeParent`, not `rollUpForChild`: the parent is already known, so
    // there is nothing to re-read. No `trigger.occurredAt` — the pinned child is
    // still IN the set with its new status, so the aggregate dates the edit
    // itself, which is what keeps this idempotent under redelivery.
    return ctx.step.run('recompute-parent', () =>
      services.parentStatusRollup.recomputeParent(payload.parentId, payload.workspaceId),
    );
  },
);
