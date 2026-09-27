import { PLAN_ITEM_MARK_PATCH_KEYS } from '@/lib/dto/plans';

// A MARK-ONLY `modify` (Story MOTIR-6577 · MOTIR-6629) — the one definition of
// "this patch changes nothing but the target's standing", read by BOTH the
// approve gate's terminal-target carve-out (`validatePlanProposals` step 4) and
// the write (`plansService.applyModify`), so the gate that admits a `modify` of a
// `done` / `cancelled` card and the write that then leaves its status alone cannot
// disagree about which `modify` that is. PURE, and its own module for the reason
// `rescopeReset.ts` is: the definition is a decision a unit test pins without a DB.
//
// Keyed on the PATCH'S KEYS alone, never on a flag the caller sets, so the
// carve-out cannot be talked around: a patch that carries `title` beside
// `obsolescence` is not mark-only, whatever else it says.

const MARK_PATCH_KEYS: ReadonlySet<string> = new Set(PLAN_ITEM_MARK_PATCH_KEYS);

/**
 * True when `patch` carries at least one key and EVERY key it carries is a
 * {@link PLAN_ITEM_MARK_PATCH_KEYS} member. An empty or absent patch is NOT
 * mark-only — it marks nothing, so it has no reason to reach a finished card.
 */
export function isMarkOnlyPatch(patch: object | null | undefined): boolean {
  if (!patch) return false;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => MARK_PATCH_KEYS.has(key));
}
