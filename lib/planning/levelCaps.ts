/**
 * The ceiling on ONE roadmap level's read — the number `workItemsService` caps
 * every level query at, and the number the plan detail's derived default view
 * reads to know when a level cannot be shown whole (MOTIR-4024, design Part XIII
 * §6).
 *
 * ⚠️ IT LIVES HERE BECAUSE IT NOW HAS TWO READERS ON OPPOSITE SIDES OF THE WIRE.
 * It was a private constant in `lib/services/workItemsService.ts`, which is
 * server-only; `lib/planning/planView.ts` runs in the client island. A second
 * copy would be a number that can drift silently — and this one is load-bearing
 * in a direction nobody watches: the level read sorts key-ASCENDING and discards
 * the HIGHEST keys, so what a level past the cap drops are the most recently
 * created cards, which are exactly the cards a plan's `modify` / `remove` is most
 * likely to be about.
 *
 * This module is deliberately pure and dependency-free so importing it from a
 * client component pulls nothing else in.
 */
export const TREE_LEVEL_MAX_TAKE = 200;
