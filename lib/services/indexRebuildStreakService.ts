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
 * ⚠️ **CHOSEN, NOT DERIVED — and that is a statement about the data, not an
 * admission of laziness.** The threshold ought to sit above normal noise, and
 * on the day this shipped there was no normal to sit above: read from
 * production 2026-09-10 over 1298 code-graph runs (899 succeeded), the ledger
 * held **91 mode observations across 5 repositories, 100% `rebuild`, zero
 * `sync`** — the consecutive-rebuild streak WAS the entire mode-carrying
 * history of every repository (motir-core 31, motir-ai 13, motir-meta 6,
 * motir-marketing 4, motir-gateway 1). MOTIR-5031 reached the same reading
 * independently the same day (73 of 73).
 *
 * So the legitimate case a threshold is supposed to clear — a genuine engine
 * bump forcing exactly ONE rebuild per repository, or an occasional pruned
 * snapshot forcing another — **has never once been observed here**, and a number
 * fitted to this distribution would be a number fitted to the outage.
 *
 * 5 is therefore reasoned rather than measured: comfortably above the
 * one-rebuild-per-bump case and above an occasional prune landing near it, and
 * far below the hundreds of runs either recorded incident actually spanned.
 * Erring HIGH is deliberate — the failure mode of a low threshold is a check
 * that fires on legitimate bumps, and a check that cries wolf is a check
 * somebody silences.
 *
 * **MOTIR-5059 is the card that calibrates this from data**, once MOTIR-5028 has
 * established in production that a `sync` can happen at all. Until it runs, this
 * number is an argument and not a measurement, and it says so here so that no
 * reader mistakes the measurement quoted above for its derivation.
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
