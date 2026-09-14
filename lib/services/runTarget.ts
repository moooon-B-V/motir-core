import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// THE RUN TARGET — the work item a delivering run was launched against (Story
// MOTIR-4882 · MOTIR-5515; `docs/decisions/approval-gates.md` §9's 2026-09-13
// amendment, and §4's second amendment, decision 1).
//
// ⚠️ ONE RESOLUTION, CALLED FROM EVERY PLACE THAT ASKS. It was written inside
// `howToTestService.getForWorkItem` (MOTIR-5333), and the merge gate needs the same
// answer: a merge gate hangs on the run target, so a child the same pull requests
// deliver gets none of its own. A second copy beside the raise would be a second
// definition of "which card is this run about", free to disagree with the How to
// test block a person reads on the same page. MOTIR-5482's approval gate calls this
// too.
//
// The rule: a card holding a CURRENT test-instructions record is its own run
// target; a card without one whose nearest ancestor holds one is tested via THAT
// ancestor; and a card that nobody's record covers is still its own run target —
// its run simply owes a record (the How to test block's `record_missing`).

export type RunTarget =
  /** The card holds a current record of its own. */
  | { kind: 'self' }
  /** The nearest ancestor holding a current record is the run target. */
  | { kind: 'ancestor'; holder: WorkItem }
  /** No record anywhere up the tree — the card is its own run target, and owes one. */
  | { kind: 'missing' };

/**
 * Resolve the run target from what the caller has ALREADY read — whether the card
 * holds a current record, and its ancestors root-first as `findAncestors` returns
 * them. Costs no read when the card holds a record, and ONE batched read otherwise,
 * however deep the tree.
 */
export async function resolveRunTarget(
  args: { hasCurrentRecord: boolean; ancestors: readonly WorkItem[] },
  tx: Prisma.TransactionClient,
): Promise<RunTarget> {
  if (args.hasCurrentRecord) return { kind: 'self' };
  // Nearest ancestor first — `findAncestors` returns root-first.
  const nearestFirst = [...args.ancestors].reverse();
  const records = await testInstructionsRepository.listCurrentByWorkItems(
    nearestFirst.map((a) => a.id),
    tx,
  );
  const holders = new Set(records.map((r) => r.workItemId));
  const holder = nearestFirst.find((a) => holders.has(a.id));
  return holder ? { kind: 'ancestor', holder } : { kind: 'missing' };
}

/** {@link resolveRunTarget} for a caller that has read nothing yet. */
export async function resolveRunTargetFor(
  item: { id: string; workspaceId: string },
  tx: Prisma.TransactionClient,
): Promise<RunTarget> {
  const [current, ancestors] = await Promise.all([
    testInstructionsRepository.findCurrentForWorkItem(item.id, tx),
    workItemRepository.findAncestors(item.id, item.workspaceId, tx),
  ]);
  return resolveRunTarget({ hasCurrentRecord: current !== null, ancestors }, tx);
}
