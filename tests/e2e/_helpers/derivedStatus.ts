import { db } from '@/lib/db';

/**
 * Wait for a DERIVED status to land on a row (MOTIR-3915).
 *
 * A parent's status is recomputed from its children by a background job
 * (`parentStatusRollupService` + `lib/jobs/definitions/statusDerivation.ts`,
 * Story MOTIR-2888), so **the last service call a fixture makes is not the last
 * write the tree receives**. A fixture that reads or writes a parent's status
 * without settling that job first is racing it.
 *
 * ⚠️ THE RACE IS NOT MERELY "THE VALUE ARRIVES LATE" — IT CAN NEVER ARRIVE.
 * That is why this helper exists rather than a retry around the assertion, and
 * it is worth spelling out because the intuitive model (eventual consistency,
 * so just wait longer) predicts the wrong remedy.
 *
 * A recompute that moves a parent BACKWARD (`done → in_progress`) needs no legal
 * workflow edge, so it is the one arm that can overwrite a status a person just
 * set. `parentStatusRollupService` therefore declines it as `stale_backward`
 * when the parent's own last status change is YOUNGER than the newest edit to
 * the child set it is reasoning about (Bug MOTIR-2965, ADR §5). So if a seed
 * edits the child set while a derivation from an earlier edit is still in
 * flight, the late job can stamp the parent AFTER the newer child edit — and
 * every subsequent recompute then declines as stale. The parent is wrong, and
 * it stays wrong. `roadmap-flow.spec.ts` timed out at 30s against exactly that.
 *
 * So the ordering rule for any fixture that builds a tree with derived statuses:
 *
 *   **settle the parent before you touch the child set again.**
 *
 * Complete a child, wait here for the parent to reach the status that implies,
 * and only then add or start the next child. Waiting is cheap; the alternative
 * is a fixture that fails once in every N runs with a status nobody set.
 *
 * The mirror rule for a fixture that wants to WALK a parent's status by hand:
 * do not, if its children already imply the destination — wait for the
 * derivation instead. A manual walk races the job in the other direction and
 * loses with `IllegalTransitionError` when the job wins a hop
 * (`follow-the-build-flow.spec.ts`, the first instance of this class).
 *
 * Never a fixed sleep: this polls the authoritative row.
 */
export async function waitForDerivedStatus(
  id: string,
  status: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.workItem.findUniqueOrThrow({ where: { id }, select: { status: true } });
    if (row.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(
        `seed: derived status "${status}" never landed on ${id} (saw "${row.status}"). ` +
          "If the seed edited this row's child set while an earlier derivation was still " +
          'in flight, the recompute has declined as `stale_backward` and will not retry — ' +
          "settle the parent before touching the child set again (see this helper's header).",
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
