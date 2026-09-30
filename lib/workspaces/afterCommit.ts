import { AsyncLocalStorage } from 'node:async_hooks';

// WORK THAT MAY ONLY HAPPEN ONCE THE TRANSACTION THAT CAUSED IT HAS COMMITTED
// (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12, `hosted-agent-run.md` §8.1).
//
// ⚠️ WHY THIS EXISTS AT THE TRANSACTION OPENER AND NOT AT A CALLER. The codebase's rule
// for an event is *emit post-commit* (`lib/jobs/sendEvent.ts`), and every emitter so far
// could keep it by construction: it opened the transaction itself, returned what it did
// out of it, and emitted afterwards (`ciPromotion.dispatchAutoMerges`, the decide door's
// `GateEffect.afterCommit`). The `agent-review/requested` event cannot: an
// `agent_review` gate is CREATED by `reconcileGatesFor`, the one creator of every gate
// row, and that runs inside a dozen callers' transactions — the promotion, a status move
// into review, the reconcile tick, every withdrawal's re-raise in the webhook paths. A
// return value threaded out of each would be a dozen places to forget it, and a missed
// one is a review that never starts on a card that then waits for ever.
//
// So the creator REGISTERS the work here, and the transaction helpers in
// `./context.ts` run it after `db.$transaction` resolves — i.e. after COMMIT — and drop
// it when the transaction throws (rolled back: nothing to announce).
//
// ⚠️ ONE SCOPE PER TRANSACTION. A helper opened INSIDE another transaction's callback
// (the job dispatcher's `withSystemContext`, say) opens its own scope, so what is
// registered inside it runs when THAT transaction commits and never waits for, or leaks
// into, the outer one. `AsyncLocalStorage` restores the outer scope when the inner one
// returns.
//
// ⚠️ BEST-EFFORT, exactly like `sendEvent`: the mutation has committed, so a callback
// that throws is logged and the next one still runs — a failure here must never turn a
// committed write into an error for the caller (PROD-443's reasoning).

type Deferred = () => Promise<void>;

const scope = new AsyncLocalStorage<Deferred[]>();

/**
 * Run `work` once the transaction currently open in this async context COMMITS.
 *
 * Returns false — and does NOT run `work` — when no transaction helper scope is active
 * (a bare `db.$transaction`, or no transaction at all). The caller decides what that
 * means; it is never silently run pre-commit, because a job started from a transaction
 * that later rolls back would act on a row that never existed.
 */
export function deferUntilCommit(work: Deferred): boolean {
  const pending = scope.getStore();
  if (!pending) return false;
  pending.push(work);
  return true;
}

/**
 * Open a transaction through `open` with a fresh after-commit scope, then run what was
 * deferred into it — only when `open` resolved. Used by the helpers in `./context.ts`.
 */
export async function withAfterCommitScope<T>(open: () => Promise<T>): Promise<T> {
  const pending: Deferred[] = [];
  const result = await scope.run(pending, open);
  for (const work of pending) {
    try {
      await work();
    } catch (err) {
      console.error('[afterCommit] deferred work failed after the transaction committed:', err);
    }
  }
  return result;
}
