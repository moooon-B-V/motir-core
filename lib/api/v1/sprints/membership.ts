import { z } from 'zod';
import { workItemKeySchema } from '@/lib/api/v1/workItems/schema';

// The sprint-MEMBERSHIP request + response shapes (Story 11.3 · Subtask 11.3.7
// — MOTIR-2064), shared by the two directions so they cannot drift apart.
//
// ── Two POSTs, and deliberately not a DELETE ────────────────────────────────
// Membership is a property of the work ITEM, and the two directions are two
// DESTINATIONS rather than a create and a delete: `POST …/sprints/{id}/work-items`
// moves a batch into a sprint, `POST …/projects/{key}/backlog/work-items` moves a
// batch back out. A `DELETE` carrying a body of ids is the alternative, and 11.2
// already rejected that shape once when it paired `POST …/archive` with
// `POST …/restore` rather than overloading DELETE.
//
// ── Keys on the wire, never cuids ───────────────────────────────────────────
// ADR §7. The route resolves them to ids in ONE batched service call — see
// `workItemsService.resolveIdentifiersToIds` for why a loop would break the
// bounded-call rule.
//
// ── PLACEMENT is deliberately NOT exposed ───────────────────────────────────
// `backlogService` accepts a neighbour-based `RankPlacementInput` (`beforeId` /
// `afterId`), and v1 does not surface it. Two reasons, recorded here rather than
// left as an unexplained omission:
//
//   • The neighbours are named by internal ID, and there is no `MOTIR-<n>`-keyed
//     form of that input. Exposing it would either leak cuids (§7) or require a
//     new service shape this story's boundary forbids.
//   • An API client cannot SEE the board. Appending to the sprint's rank tail is
//     the honest default for a caller with no view of where "between these two"
//     would land, and it is what the shipped bulk assign already does when no
//     placement is given.
//
// Under §8 adding placement later is additive — a new optional field on a
// request — whereas shipping a half-usable one now is not.

/** The request body BOTH directions take. */
export const membershipMoveBodySchema = z
  .object({
    /**
     * The items to move, as `MOTIR-<n>` keys.
     *
     * An EMPTY array is a deliberate 200 no-op, not a 422: the shipped service
     * guards it as a no-op, and a script that computed an empty batch has not
     * made an error — it has nothing to do.
     *
     * The 100 cap is NOT declared here. `MAX_BULK_BATCH_SIZE` is the service's,
     * and a second copy in a zod schema is a second thing to keep in sync; an
     * over-cap batch surfaces the service's own typed `BulkBatchTooLargeError`,
     * which names the cap in its message.
     */
    workItemKeys: z.array(workItemKeySchema),
  })
  .strict();
export type MembershipMoveBody = z.infer<typeof membershipMoveBodySchema>;

/** What a move returns: the keys that moved, in request order. */
export const membershipMoveResultSchema = z.object({
  movedKeys: z.array(workItemKeySchema),
});
export type MembershipMoveResult = z.infer<typeof membershipMoveResultSchema>;

/**
 * Present the moved batch.
 *
 * Only the KEYS: the full work-item resource is 11.2's, and echoing it here
 * would make this endpoint a second place that shape is emitted from — the
 * drift Amendment 2 exists to prevent. A client that needs the rows reads them
 * back from the collection it just moved them into.
 */
export function presentMembershipMove(
  moved: readonly { identifier: string }[],
): MembershipMoveResult {
  return { movedKeys: moved.map((item) => item.identifier) };
}
