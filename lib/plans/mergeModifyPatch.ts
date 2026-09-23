import { PLAN_ITEM_PATCH_KEYS, type PlanItemPatch } from '@/lib/dto/plans';
import { DuplicatePlanTargetError, type PlanTargetOp } from '@/lib/plans/errors';

// A second `modify` of one committed card MERGES into the plan's one `modify`
// (MOTIR-6051 · `agent-authored-plans.md` AMENDMENT 18 §2). PURE: the append
// (`plansService.addProposals`) calls it under the plan's row lock, which is
// what makes the read-then-write safe; nothing here reads or writes.

/** The two edge lists — unioned, never overwritten. Every other key is scalar. */
const EDGE_KEYS = ['blockedByAdd', 'blockedByRemove'] as const;

/**
 * Merge an incoming `modify` patch INTO the one the plan already holds for the
 * same card, per AMENDMENT 18 §2:
 *
 *  - every SCALAR key of {@link PLAN_ITEM_PATCH_KEYS} (`parentRef` included):
 *    the incoming value wins when the key is PRESENT — an explicit `null` still
 *    clears — and an absent key leaves the existing value;
 *  - `blockedByAdd` / `blockedByRemove`: each is the de-duplicated UNION of the
 *    two, and a ref that ends up in BOTH cancels to neither (add-then-remove of
 *    one edge in one plan is no change to it). An empty list is omitted.
 *
 * `baseRevision` is not a patch key: the caller keeps the EARLIER row's anchor.
 */
export function mergeModifyPatch(
  existing: PlanItemPatch | null | undefined,
  incoming: PlanItemPatch | null | undefined,
): PlanItemPatch {
  const a: Record<string, unknown> = { ...(existing ?? {}) };
  const b: Record<string, unknown> = { ...(incoming ?? {}) };
  const merged: Record<string, unknown> = {};

  for (const key of PLAN_ITEM_PATCH_KEYS) {
    if ((EDGE_KEYS as readonly string[]).includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(b, key)) merged[key] = b[key];
    else if (Object.prototype.hasOwnProperty.call(a, key)) merged[key] = a[key];
  }

  const union = (key: (typeof EDGE_KEYS)[number]): string[] => [
    ...new Set([
      ...((a[key] as string[] | undefined) ?? []),
      ...((b[key] as string[] | undefined) ?? []),
    ]),
  ];
  const adds = union('blockedByAdd');
  const removes = union('blockedByRemove');
  const both = new Set(adds.filter((ref) => removes.includes(ref)));
  const keptAdds = adds.filter((ref) => !both.has(ref));
  const keptRemoves = removes.filter((ref) => !both.has(ref));
  if (keptAdds.length > 0) merged.blockedByAdd = keptAdds;
  if (keptRemoves.length > 0) merged.blockedByRemove = keptRemoves;

  return merged as PlanItemPatch;
}

/** What the append does with ONE incoming proposal. */
export type AppendDisposition =
  /** A new row. */
  | { kind: 'insert' }
  /** Folded into a row the plan ALREADY holds. */
  | { kind: 'mergeExisting'; rowId: string }
  /** Folded into an EARLIER proposal of the same batch, which becomes one row. */
  | { kind: 'mergeBatch'; index: number };

export interface AppendFold {
  /** One disposition per incoming proposal, in input order. */
  dispositions: AppendDisposition[];
  /** The merged patch each existing `modify` row ends with, keyed by row id. */
  mergedExisting: Map<string, PlanItemPatch>;
  /** The merged patch an INSERTED `modify` carries when a later proposal of the
   *  batch folded into it, keyed by its batch index. Absent ⇒ its own patch. */
  mergedIncoming: Map<number, PlanItemPatch>;
}

interface ExistingRow {
  id: string;
  op: string;
  workItemId: string | null;
  patch: unknown;
}

interface IncomingProposal {
  op: string;
  workItemId?: string | null;
  patch?: PlanItemPatch | null;
}

/**
 * Decide, for a whole append, which proposals become rows and which merge
 * (AMENDMENT 18 §2). ONE PROPOSAL PER EXISTING TARGET still holds — this is what
 * keeps `@@unique([planId, workItemId])` true — and the only pairing that no
 * longer refuses is `modify` + `modify`, which folds, in batch order, into the
 * earliest row for the card. Every other pairing on one target (`modify` +
 * `remove` either way, two `remove`s) throws {@link DuplicatePlanTargetError}
 * exactly as before.
 */
export function foldAppend(
  existing: readonly ExistingRow[],
  incoming: readonly IncomingProposal[],
): AppendFold {
  const holder = new Map<
    string,
    { op: PlanTargetOp; at: { kind: 'existing'; rowId: string } | { kind: 'batch'; index: number } }
  >();
  const mergedExisting = new Map<string, PlanItemPatch>();
  const mergedIncoming = new Map<number, PlanItemPatch>();
  const patchOfExisting = new Map<string, PlanItemPatch | null>();

  for (const row of existing) {
    if (row.op === 'add' || !row.workItemId) continue;
    holder.set(row.workItemId, {
      op: row.op as PlanTargetOp,
      at: { kind: 'existing', rowId: row.id },
    });
    patchOfExisting.set(row.id, (row.patch as PlanItemPatch | null) ?? null);
  }

  const dispositions: AppendDisposition[] = incoming.map((p, index) => {
    if (p.op === 'add' || !p.workItemId) return { kind: 'insert' };
    const op = p.op as PlanTargetOp;
    const held = holder.get(p.workItemId);
    if (!held) {
      holder.set(p.workItemId, { op, at: { kind: 'batch', index } });
      return { kind: 'insert' };
    }
    if (held.op !== 'modify' || op !== 'modify') {
      throw new DuplicatePlanTargetError(p.workItemId, held.op, op);
    }
    if (held.at.kind === 'existing') {
      const rowId = held.at.rowId;
      const base = mergedExisting.get(rowId) ?? patchOfExisting.get(rowId) ?? {};
      mergedExisting.set(rowId, mergeModifyPatch(base, p.patch));
      return { kind: 'mergeExisting', rowId };
    }
    const first = held.at.index;
    const base = mergedIncoming.get(first) ?? incoming[first]!.patch;
    mergedIncoming.set(first, mergeModifyPatch(base, p.patch));
    return { kind: 'mergeBatch', index: first };
  });

  return { dispositions, mergedExisting, mergedIncoming };
}
