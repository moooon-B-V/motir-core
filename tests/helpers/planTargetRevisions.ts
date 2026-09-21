import { adminDb } from './adminDb';

/**
 * The CONTENT revisions of a work item — every `updated` revision EXCEPT the pure
 * status moves a plan makes around its own target.
 *
 * ⚠️ WHY THIS EXISTS (bug MOTIR-5640 · MOTIR-5645 / MOTIR-5646). A plan now PARKS
 * every committed target it names at `planning` when it appends, and gives it a
 * RESTING status (`blocked` / `todo`) when it is approved. Both are real status
 * changes and both record a revision, so a card a plan `modify`s carries THREE
 * `updated` revisions where it used to carry one:
 *
 *   1. `<prior> → planning`   — the park, at the append
 *   2. the modify's own diff  — at approve, inside materialize
 *   3. `planning → <resting>` — the resting status, materialize's last pass
 *
 * A great many tests assert *"exactly ONE `updated` revision for the whole
 * modify"*, and that claim is STILL TRUE — it is about the modify landing as a
 * single entry rather than one per field. What changed is only that counting
 * every `updated` revision is no longer a way to measure it.
 *
 * So this narrows the measurement to what those tests are actually about, rather
 * than relaxing them to a bigger number — which would stop them detecting the
 * per-field regression they were written for.
 *
 * A revision is a PURE STATUS MOVE when `status` is the only key in its diff. The
 * modify's own revision carries content keys (and may carry `status` beside them
 * on some other path), so it is never excluded by accident.
 */
export async function contentRevisions(workItemId: string) {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });
  return revisions.filter((r) => {
    const keys = Object.keys((r.diff ?? {}) as Record<string, unknown>);
    return !(keys.length === 1 && keys[0] === 'status');
  });
}

/** The pure status moves, oldest first — the park and the resting status. The
 *  complement of {@link contentRevisions}, for a test that wants to assert the
 *  round trip rather than ignore it. */
export async function statusMoves(
  workItemId: string,
): Promise<Array<{ from: unknown; to: unknown }>> {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });
  return revisions
    .map((r) => (r.diff as Record<string, unknown>)?.status as { from: unknown; to: unknown })
    .filter((cell): cell is { from: unknown; to: unknown } => Boolean(cell));
}
