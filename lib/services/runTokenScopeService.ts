import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { DispatchRunTokenOutOfScopeError } from '@/lib/dispatchRuns/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// WHICH CARDS a hosted run's own credential may touch (MOTIR-6557,
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §4).
//
// The container runs the CLI's own `motir run` / `motir continue`, which claims,
// prompts, transitions, integrates and links pull requests across EVERY card the
// run covers — for a parent run, all of its children. So a run token reaches the
// run's LEGS (`dispatch_run_card`) and the SCOPE it was opened for
// (`DispatchRun.scopeWorkItemId`, the container a parent run closes out) — and
// no other card, whatever its grant says.
//
// `ctx.tokenDispatchRunId` is set only when a RUN token reached a route that
// opted in (`withV1Route`'s `acceptsRunToken`, the table in
// `lib/hostedRuns/runTokenRoutes.ts`). Every other caller passes straight
// through, so the services that call this behave exactly as before for a person
// or an ordinary PAT.
//
// ⚠️ A refusal is the same 403 whether the card exists or not, and whether the
// run exists or not — a run token cannot probe the project through it.

export const runTokenScopeService = {
  /**
   * Refuse (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403) unless every one of
   * `workItemIds` is a leg of the token's run or the run's scope. A no-op for a
   * caller that is not a run token.
   */
  async assertReachesWorkItems(workItemIds: readonly string[], ctx: ServiceContext): Promise<void> {
    if (ctx.tokenDispatchRunId === undefined) return;
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      runTokenScopeService.assertReachesWorkItemsIn(workItemIds, ctx, tx),
    );
  },

  /**
   * {@link assertReachesWorkItems} inside a transaction the caller already holds
   * — for a read that resolves its card within one (the design verdicts).
   */
  async assertReachesWorkItemsIn(
    workItemIds: readonly string[],
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const runId = ctx.tokenDispatchRunId;
    if (runId === undefined) return;
    const reachable = new Set<string>();
    const run = await dispatchRunRepository.findById(runId, tx);
    if (run) {
      if (run.scopeWorkItemId) reachable.add(run.scopeWorkItemId);
      const legs = await dispatchRunCardRepository.listByRun(runId, tx);
      for (const leg of legs) if (leg.workItemId) reachable.add(leg.workItemId);
    }
    for (const id of workItemIds) {
      if (!reachable.has(id)) throw new DispatchRunTokenOutOfScopeError();
    }
  },
};
