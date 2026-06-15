/**
 * Status preservation for `pnpm db:seed` (Subtask 7.8.7).
 *
 * **The invariant this module enforces.** Until the MCP `transition_status`
 * tool (7.8.5) shipped, the plan seed was the source of truth for STATUS too:
 * `pnpm db:seed` clear-and-reseeded the tenant and APPLIED each item's seed
 * status, and a later `[reseed]` regenerated the SAME statuses (so the user's
 * manual flips were never reverted). That was correct while the seed owned
 * status — and DESTRUCTIVE the moment agents/users can flip statuses directly
 * in the live tenant: a reseed re-applying seed statuses would CLOBBER the live
 * ones.
 *
 * So status authority moves seed → live DB. The seed status becomes
 * **INITIAL-ONLY**: it is applied to NEW items, and a reseed PRESERVES the
 * live `workflow_status` of items that already existed in the tenant. The two
 * halves below are what `seed.ts` calls to do that:
 *
 * 1. {@link snapshotLiveStatuses} — BEFORE the destructive clear, read the
 *    current `workflow_status` of every existing plan work item, keyed by its
 *    **dotted plan id** (recovered from the stable title prefix the loader
 *    builds — keys are reallocated on reseed, so the plan id is the only stable
 *    join key).
 * 2. {@link applyPreservedStatuses} — AFTER the tree is re-created (seed
 *    statuses applied at create time), re-apply the snapshot to the items that
 *    existed before (matched by plan id). NEW items keep their seed status. A
 *    snapshotted status whose key is no longer in the target workflow falls
 *    back to the seed status with a loader warning (a custom status the live
 *    tenant added but the reseeded default workflow doesn't carry).
 *
 * Plan-STRUCTURE authority (adding/expanding stories) stays with the seed; only
 * STATUS authority moves. Re-running stays idempotent: a double reseed snapshots
 * the statuses the first reseed just preserved and re-applies the same values.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';

/**
 * Recover the dotted plan id a seed title was built from — the stable join key
 * across reseeds (the work_item `key`/`identifier` is reallocated each run, so
 * it can't be used). Mirrors the title shapes `seed.ts` `createItem` writes:
 *
 * - epic   → `Epic <id>: <title>`         (id is a single integer, e.g. `7`)
 * - story  → `<id> <title>`               (e.g. `7.8`)
 * - leaf   → `<id> <title>`               (e.g. `7.8.7`)
 * - root bug → `<id> <title>`             (single integer, e.g. `9`)
 *
 * The epic form is matched first so an epic titled `Epic 7: …` and a root bug
 * titled `7 …` don't collide on the leading integer. Returns null for a title
 * that carries no dotted-id prefix (a hand-created tenant item, not a plan row).
 */
export function planIdFromTitle(title: string): string | null {
  const epic = title.match(/^Epic (\d+(?:\.\d+)*): /);
  if (epic) return epic[1]!;
  const leaf = title.match(/^(\d+(?:\.\d+)*)\s/);
  return leaf ? leaf[1]! : null;
}

/**
 * Snapshot the live `workflow_status` of every existing plan work item in the
 * given workspaces, keyed by dotted plan id. Called BEFORE the clear pass wipes
 * the tenant. An empty workspace set (a first-ever seed) returns an empty map,
 * so every item is then treated as new (keeps its seed status).
 *
 * When a plan id resolves to more than one row (the handful of source ids that
 * collide between a story and a leaf, e.g. `1.0.5`), the last row read wins —
 * the same last-write-wins shape `seed.ts`'s `idMap` already has for those ids.
 */
export async function snapshotLiveStatuses(
  workspaceIds: Iterable<string>,
): Promise<Map<string, string>> {
  const ids = [...workspaceIds];
  const snapshot = new Map<string, string>();
  if (ids.length === 0) return snapshot;
  const rows = await db.workItem.findMany({
    where: { workspaceId: { in: ids } },
    select: { title: true, status: true },
  });
  for (const row of rows) {
    const planId = planIdFromTitle(row.title);
    if (planId) snapshot.set(planId, row.status);
  }
  return snapshot;
}

/** What {@link applyPreservedStatuses} did, for the loader's summary line. */
export interface PreserveResult {
  /** Items whose live status was re-applied over the seed status. */
  preserved: number;
  /** Items whose snapshotted status is gone from the workflow → kept seed status. */
  fellBack: number;
  /** One human-readable line per fall-back (the loader prints these as warnings). */
  warnings: string[];
}

/**
 * Re-apply the snapshotted live statuses onto the freshly-seeded tree. For each
 * snapshot entry whose plan id maps to a created work item:
 *
 * - if the snapshotted status key is still in the target workflow → overwrite
 *   the item's (seed) status with the live one (it `existed before`);
 * - otherwise → leave the seed status in place and record a warning (the live
 *   status used a key the reseeded default workflow no longer carries).
 *
 * Items absent from the snapshot are NEW (or hand-created) and are left on their
 * seed status untouched. Each overwrite is its own one-row transaction through
 * the shipped repository write (the 4-layer rule; `tx` required on writes).
 */
export async function applyPreservedStatuses(args: {
  /** plan id → live status, from {@link snapshotLiveStatuses}. */
  snapshot: Map<string, string>;
  /** plan id → freshly-created work_item id (the loader's `idMap`). */
  idMap: Map<string, string>;
}): Promise<PreserveResult> {
  let preserved = 0;
  let fellBack = 0;
  const warnings: string[] = [];
  for (const [planId, liveStatus] of args.snapshot) {
    const workItemId = args.idMap.get(planId);
    if (!workItemId) continue; // item no longer in the plan — nothing to carry forward
    if (!DEFAULT_STATUS_KEYS.has(liveStatus)) {
      fellBack++;
      warnings.push(
        `preserved status "${liveStatus}" for ${planId} is not in the target workflow — kept seed status`,
      );
      continue;
    }
    await db.$transaction((tx: Prisma.TransactionClient) =>
      workItemRepository.update(workItemId, { status: liveStatus }, tx),
    );
    preserved++;
  }
  return { preserved, fellBack, warnings };
}
