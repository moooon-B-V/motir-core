import { offboardCodeGraph } from '@/lib/ai/motirAiClient';
import { OFFBOARD_ALL_REPOS } from '@/lib/codeGraph/offboarding';
import { codeGraphOffboardingRepository } from '@/lib/repositories/codeGraphOffboardingRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE OFFBOARDING SWEEP (MOTIR-2168 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — the clock and the wire.
//
// MOTIR-2166 writes due rows; MOTIR-2165 built the endpoint that removes the
// three artifacts. **Neither does anything until this drains one into the other**
// — an endpoint nobody calls and a queue nobody reads are both green, reviewable,
// and inert (`notes.html` #206: a method with no caller is not a path). This is
// the smallest of the three cards and the one that decides whether Decision 10 is
// real.
//
// **The clock is here, not in motir-ai, and that was checked rather than
// inherited.** `git grep` over motir-ai's `src/` finds no cron, no interval and no
// scheduled entrypoint: it receives `POST /v1/jobs` and serves `/v1/*`. Every
// recurring sweep this product runs — `system.attachment-gc`,
// `system.automation-retention-sweep`, `system.ci-runner-reap` — is a `system.*`
// job in motir-core, and keeping the clock here preserves §5's control-plane-only
// shape for motir-ai.
//
// ── THE RETRY DESIGN, IN ONE SENTENCE ────────────────────────────────────────
//
// **The queue IS the retry: the row is deleted only on a successful response.**
// A motir-ai outage leaves the row due and the next tick picks it up. There is no
// attempt counter, no dead-letter table and no backoff, deliberately — every one
// of those adds state that can disagree with the queue, for a job that is allowed
// to be slow.
//
// The one thing that must not happen is deleting the row BEFORE the removal is
// confirmed. That silently converts a transient outage into permanent retention
// with no record that anything was owed — the same class of failure as §14.1's
// cascade, which destroys the inventory of what it left behind.

/** How many due scopes ONE tick drains. Bounded, so a tick's work is bounded. */
export const OFFBOARD_SWEEP_BATCH_SIZE = 50;

/** What one tick did — the job's `output`, so the ledger answers "what was removed". */
export interface OffboardSweepResult {
  /** Due rows read this tick (≤ {@link OFFBOARD_SWEEP_BATCH_SIZE}). */
  due: number;
  /** Rows motir-ai confirmed and this tick retired. */
  offboarded: number;
  /** Rows whose call failed; still due, retried next tick. */
  failed: number;
  /** Object-storage keys motir-ai reported deleting. */
  snapshotObjectsDeleted: number;
  /** Per-machine local roots motir-ai reported deleting. */
  localRootsRemoved: number;
  /** Coordination rows motir-ai reported deleting. */
  coordinationRowsDeleted: number;
  /**
   * Due rows left in the queue after this tick, ≥ 0.
   *
   * ⚠️ Reported rather than left implicit. A capped tick that says only
   * "offboarded: 50" reads as "everything was offboarded" — a silent cap is how a
   * backlog becomes invisible. The queue depth is the honest signal, so a
   * remainder is BOTH in the output and logged.
   */
  remaining: number;
}

export const codeGraphOffboardSweepService = {
  /**
   * Drain the due offboarding rows through motir-ai's `POST /v1/code-graph/offboard`.
   *
   * Sequential, not concurrent: each call removes objects for a different tenant
   * and there is no deadline pressure on a 30-day window, so the simpler shape is
   * also the one that cannot flood motir-ai from a cron.
   *
   * `now` is injectable so a test can drive the due boundary without waiting.
   */
  async sweep(now: Date = new Date()): Promise<OffboardSweepResult> {
    const rows = await withSystemContext((tx) =>
      codeGraphOffboardingRepository.findDue(now, OFFBOARD_SWEEP_BATCH_SIZE, tx),
    );

    const result: OffboardSweepResult = {
      due: rows.length,
      offboarded: 0,
      failed: 0,
      snapshotObjectsDeleted: 0,
      localRootsRemoved: 0,
      coordinationRowsDeleted: 0,
      remaining: 0,
    };

    for (const row of rows) {
      try {
        const removed = await offboardCodeGraph({
          coreWorkspaceId: row.coreWorkspaceId,
          coreProjectId: row.coreProjectId,
          // The sentinel is motir-core's encoding of "every repo of the project";
          // motir-ai expresses the same thing by the field being ABSENT. This is
          // the one place the two vocabularies meet, so the translation lives
          // here rather than leaking `*` across the boundary as a repo name.
          ...(row.repoRef === OFFBOARD_ALL_REPOS ? {} : { repoRef: row.repoRef }),
        });

        // ONLY NOW. The removal is confirmed, so the record of it being owed can
        // go. Delete-then-call would lose the work on any failure.
        await withSystemContext((tx) => codeGraphOffboardingRepository.deleteById(row.id, tx));

        result.offboarded += 1;
        result.snapshotObjectsDeleted += removed.snapshotObjectsDeleted;
        result.localRootsRemoved += removed.localRootsRemoved;
        result.coordinationRowsDeleted += removed.coordinationRowsDeleted;
      } catch (err) {
        // Quiet PER ROW, not per tick: one tenant's failure must not abandon the
        // rest of the batch. The row stays due, which IS the retry.
        result.failed += 1;
        console.error('[code-graph-offboard-sweep] offboard failed; row stays due', {
          id: row.id,
          coreWorkspaceId: row.coreWorkspaceId,
          coreProjectId: row.coreProjectId,
          repoRef: row.repoRef,
          error: err,
        });
      }
    }

    // What is STILL due after this tick — the capped remainder plus anything that
    // failed. Counted from the database rather than inferred from the batch, so a
    // row that came due mid-tick is included.
    const stillDue = await withSystemContext((tx) =>
      codeGraphOffboardingRepository.countDue(now, tx),
    );
    result.remaining = stillDue;

    if (stillDue > 0) {
      console.warn('[code-graph-offboard-sweep] tick ended with work still due', {
        remaining: stillDue,
        batchSize: OFFBOARD_SWEEP_BATCH_SIZE,
        offboarded: result.offboarded,
        failed: result.failed,
      });
    }

    return result;
  },
};
