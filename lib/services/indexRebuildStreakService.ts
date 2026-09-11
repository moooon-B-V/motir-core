import { withSystemContext } from '@/lib/workspaces/context';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import {
  INDEX_REBUILD_STREAK_BLIND_SPOT,
  INDEX_REBUILD_STREAK_CANDIDATES,
  type IndexRebuildStreakEntryDTO,
  type IndexRebuildStreakVerdictDTO,
} from '@/lib/dto/indexRebuildStreak';

// THE REBUILD-STREAK PROBE (MOTIR-5027) — the fifth probe of
// `system.daily-health-check`, and the first one that asks whether a feature is
// DOING what it claims rather than whether a run SUCCEEDED.
//
// The fault it exists to catch is invisible to every other signal in the estate.
// "Build once, sync forever" is a claim about WHICH of two paths a successful
// run took, so a deployment that rebuilds the whole graph on every single run
// satisfies the refresh job, the health check, the ledger and every dashboard —
// all of them correctly, because none of them was ever asking. It has now been
// off in production twice for weeks at a time (MOTIR-4415, MOTIR-5009) and both
// times a person found it by accident while reading logs for something else.
//
// The mode has been recorded since MOTIR-4945 and had no reader. This is the
// reader.
//
// ⚠️ WHAT IT MEASURES IS THE OFFER, NOT THE OUTCOME — the whole boundary is in
// `lib/dto/indexRebuildStreak.ts`'s header and in INDEX_REBUILD_STREAK_BLIND_SPOT,
// which rides on every verdict this service returns. Read it before changing
// anything here.

/**
 * How many consecutive `rebuild` runs a repository may record before this probe
 * calls it broken.
 *
 * **CALIBRATED 2026-09-11 (MOTIR-5059) — KEPT at 5, and now against a
 * distribution that contains both modes.** MOTIR-5027 shipped this as an openly
 * CHOSEN number because the ledger then held 91 mode observations, 100%
 * `rebuild` and zero `sync`: there was no normal for a threshold to sit above.
 * MOTIR-5028 established a `sync` in production on 2026-09-10, and this is the
 * re-read.
 *
 * **The reading**, over the SAME population this probe reads — `job_run` where
 * `function_id IN ('system.code-graph-refresh','system.code-graph-index')` AND
 * **`status = 'succeeded'`** (the success predicate), newest-first, limit 2000,
 * kept where `output.indexed === true` and `output.repoRef` is a string, mode
 * collapsed by `runMode` below:
 *
 * | repository | succeeded | carried a mode | streak | `sync` |
 * |---|---|---|---|---|
 * | motir-core | 549 | 45 | 0 | 12 |
 * | motir-ai | 210 | 20 | 0 | 6 |
 * | motir-meta | 92 | 8 | 0 | 2 |
 * | motir-marketing | 44 | 4 | **4** | 0 |
 * | motir-gateway | 16 | 1 | 1 | 0 |
 * | starter | 11 | 0 | 0 | 0 |
 *
 * 922 index rows, 78 carrying a mode (844 still carry none), **20 `sync` and 58
 * `rebuild`** — where the reading this number shipped on had 91 `rebuild` and
 * zero `sync`.
 *
 * ⚠️ **AND THE ONE-REBUILD-PER-BUMP CASE, DISPOSED OF AGAINST THE DATA RATHER
 * THAN ASSERTED — the two predicates give different answers and BOTH are
 * reported, because only the second is evidence.**
 *
 *  - **Rebuild episodes BOUNDED by a `sync` on both sides: ZERO.** Every rebuild
 *    episode in the ledger is still open at the old end — each repository has
 *    exactly ONE `rebuild` → `sync` transition in its whole history, the
 *    2026-09-10 recovery. So under the strict reading there are **no
 *    single-rebuild episodes at all**, and this comment says so rather than
 *    claiming the case is covered.
 *  - **Rebuilds inside the BUMP WINDOW** — after MOTIR-5026's re-pin at
 *    23:03:47Z, before that repository's first `sync`: motir-core **1**
 *    (23:14:31Z), motir-ai **1** (23:06:03Z), motir-meta **0** (it did not run
 *    inside the window). **n = 2, both of length 1** — the legitimate case
 *    finally observed, and it cost exactly the one rebuild MOTIR-5027 argued it
 *    would.
 *
 * So the separation the threshold has to make is now measured at both ends:
 * the largest observed LEGITIMATE episode is **1**, and the smallest observed
 * DEFECT episode is **4** (motir-marketing). 5 sits above both.
 *
 * **Why it is not lowered into that gap.** motir-marketing reads 4 TODAY and
 * motir-gateway 1, both with zero syncs — not because either is broken now, but
 * because neither has refreshed since the fix landed (their newest mode-carrying
 * runs are 2026-09-10T11:25Z and 2026-09-09T21:28Z). A threshold of 4 would be
 * LOUD on motir-marketing this morning over a defect that is already repaired,
 * which is precisely the fires-on-a-state-nobody-can-act-on failure the original
 * reasoning erred high to avoid. 5 is the smallest value that clears both the
 * observed legitimate episode and the largest stale streak the recovery has not
 * yet swept.
 *
 * **What this reading still cannot say**, stated so no later reader mistakes it
 * for more than it is: a pruned-snapshot rebuild has never been observed here at
 * all, so the second legitimate mechanism remains unmeasured; and MOTIR-5030
 * (motir-ai#445, merged 23:25:44Z) removed the engine-version comparison that
 * produced the bump rebuild in the first place, so the mechanism the n = 2
 * observation measures may not recur by that route.
 */
export const INDEX_REBUILD_STREAK_THRESHOLD = 5;

/** `job_run.output` as this probe reads it. Everything is optional because the
 *  column is stored JSON written by several revisions over the ledger's life. */
interface CodeGraphRunOutput {
  indexed?: unknown;
  repoRef?: unknown;
  indexModes?: unknown;
}

/**
 * The mode a single run recorded, collapsed to one value.
 *
 * A run carries ONE `{ projectId, mode }` entry per container it settled, and it
 * counts as a rebuild only when EVERY entry is one: a run that synced any
 * project did not rebuild from scratch, and treating a mixed run as a rebuild
 * would let the streak grow through exactly the recovery this probe is watching
 * for. `null` means the run recorded no mode at all.
 */
function runMode(output: CodeGraphRunOutput): 'sync' | 'rebuild' | null {
  const modes = output.indexModes;
  if (!Array.isArray(modes) || modes.length === 0) return null;
  const values: string[] = [];
  for (const entry of modes) {
    if (!entry || typeof entry !== 'object') return null;
    const mode = (entry as { mode?: unknown }).mode;
    if (mode !== 'sync' && mode !== 'rebuild') return null;
    values.push(mode);
  }
  return values.every((m) => m === 'rebuild') ? 'rebuild' : 'sync';
}

export const indexRebuildStreakService = {
  /**
   * Has any repository been denied a snapshot {@link INDEX_REBUILD_STREAK_THRESHOLD}
   * consecutive times?
   *
   * Never throws — every arm of the verdict is an answer, including "nothing
   * has been measured". The CALLER decides which arm is loud; this only
   * establishes which one is true. That is the same contract
   * `fleetPreflightService` observes, and for the same reason.
   */
  async check(now: Date = new Date()): Promise<IndexRebuildStreakVerdictDTO> {
    const checkedAt = now.toISOString();
    const rows = await withSystemContext((tx) => jobRunRepository.listSucceededCodeGraphRuns(tx));

    // Newest first, per repository. `listSucceededCodeGraphRuns` orders by
    // `startedAt desc`, so pushing preserves that order within each bucket and
    // the streak is read straight off the front.
    const byRepo = new Map<string, Array<'sync' | 'rebuild' | null>>();
    for (const row of rows) {
      const output = (row.output ?? null) as CodeGraphRunOutput | null;
      // A succeeded run that indexed NOTHING (`{ indexed: false, reason }`)
      // carries no repoRef and is not an index — the same guard
      // `listSucceededCodeGraphIndexRepoRefs` applies to the same column.
      if (!output || output.indexed !== true || typeof output.repoRef !== 'string') continue;
      const bucket = byRepo.get(output.repoRef) ?? [];
      bucket.push(runMode(output));
      byRepo.set(output.repoRef, bucket);
    }

    if (byRepo.size === 0) {
      return {
        verdict: 'not_applicable',
        detail:
          'No succeeded code-graph index run has been recorded, so there is nothing to read. A deployment that does not index is not unhealthy.',
        checkedAt,
        blindSpot: INDEX_REBUILD_STREAK_BLIND_SPOT,
      };
    }

    const entries: IndexRebuildStreakEntryDTO[] = [];
    for (const [repoRef, modes] of byRepo) {
      // ⚠️ A run carrying NO mode is SKIPPED, not counted and not treated as a
      // break. It is a run this probe could not read — a row written before
      // MOTIR-4945, or a container that never reported — and letting it end the
      // streak would silently report a repository as recovering because an old
      // row happened to sit between two rebuilds.
      const measured = modes.filter((m): m is 'sync' | 'rebuild' => m !== null);
      let consecutiveRebuilds = 0;
      for (const mode of measured) {
        if (mode !== 'rebuild') break;
        consecutiveRebuilds += 1;
      }
      entries.push({
        repoRef,
        consecutiveRebuilds,
        modeRuns: measured.length,
        succeededRuns: modes.length,
        state:
          measured.length === 0
            ? 'unknown'
            : consecutiveRebuilds >= INDEX_REBUILD_STREAK_THRESHOLD
              ? 'rebuilding'
              : 'syncing',
      });
    }
    entries.sort((a, b) => b.consecutiveRebuilds - a.consecutiveRebuilds);

    const offenders = entries.filter((e) => e.state === 'rebuilding');
    const unknownRepoRefs = entries.filter((e) => e.state === 'unknown').map((e) => e.repoRef);

    if (offenders.length > 0) {
      return {
        verdict: 'rebuilding',
        offenders,
        entries,
        unknownRepoRefs,
        threshold: INDEX_REBUILD_STREAK_THRESHOLD,
        candidates: [...INDEX_REBUILD_STREAK_CANDIDATES],
        checkedAt,
        blindSpot: INDEX_REBUILD_STREAK_BLIND_SPOT,
      };
    }

    return {
      verdict: 'ok',
      entries,
      unknownRepoRefs,
      threshold: INDEX_REBUILD_STREAK_THRESHOLD,
      checkedAt,
      blindSpot: INDEX_REBUILD_STREAK_BLIND_SPOT,
    };
  },
};
