import { PLAN_ITEM_PATCH_KEYS } from '@/lib/dto/plans';
import { InvalidProposalError } from '@/lib/plans/errors';

// A `modify` patch may carry ONLY the keys `PlanItemPatch` declares (bug
// MOTIR-6259). PURE — no read — so the append and the correction door call it
// in their per-proposal pass, before anything is persisted.
//
// ⚠️ WHY A REFUSAL AND NOT A STRIP. The MCP schema passes an unknown key through
// on purpose (`authorPlan.ts`'s `patchSchema`), and the service then dropped it
// without a word: `mergeModifyPatch` copies only `PLAN_ITEM_PATCH_KEYS`, and
// `applyModify` reads only them. So an author who sent `patch.executor` got a
// success, a stored patch without it, and an approved card without it — and the
// first sign was a decision gate that never came. A key the plan cannot apply is
// a mistake the author has to hear about while they are still writing the plan.
//
// Checked at the APPEND and at a CORRECTION only, never at approve: a plan
// persisted before this check may hold a row the merge already stripped, and
// refusing it at approve would put the author's old mistake in front of the
// reviewer, who cannot fix it.

const KNOWN: ReadonlySet<string> = new Set(PLAN_ITEM_PATCH_KEYS);

/**
 * Refuse a `modify` patch carrying any key {@link PLAN_ITEM_PATCH_KEYS} does not
 * list, naming every such key. `label` names the proposal the way the other
 * per-proposal refusals do.
 */
export function assertKnownPatchKeys(patch: object | null | undefined, label: string): void {
  if (!patch) return;
  const unknown = Object.keys(patch).filter((key) => !KNOWN.has(key));
  if (unknown.length === 0) return;
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  throw new InvalidProposalError(
    `${label}: \`patch\` carries ${named}, which a \`modify\` cannot apply. ` +
      `A patch may carry only ${PLAN_ITEM_PATCH_KEYS.map((k) => `\`${k}\``).join(', ')}. ` +
      (unknown.includes('executor')
        ? 'A `modify` never sets `executor` (it is the target’s): re-typing a card with no ' +
          'executor seeds the type’s default at approve, and an explicit one is set on the ' +
          'work item itself. '
        : '') +
      'Drop the key rather than rely on it: nothing would have applied it.',
  );
}
