import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';

// THE DRIFT RECOMPUTE (Story MOTIR-1754 · MOTIR-4644) — the producer of the
// number three surfaces already render.
//
// ⚠️ IT RUNS OFF THE RENDER PATH, AND THAT IS THE WHOLE SHAPE OF THIS CARD.
// MOTIR-1766 chose a push webhook over a HEAD fetch precisely so that reading
// staleness costs no provider round-trip: a per-render call adds latency and
// rate-limit exposure to two surfaces and fails closed when the token is
// unavailable. Counting commits is strictly more expensive than fetching a head,
// so that reasoning binds harder here, not less. The read serves a column; this
// job fills it.
//
// ⚠️ AND IT IS BOUNDED PER TICK. Every repository costs one provider call, and
// GitLab.com rate-limits some endpoints at 5 requests/minute — so a fan-out
// across a large estate would not be slow, it would fail most of its work and
// retry it on the next tick for ever. The ceiling below is per tick, oldest
// first, so a busy repository cannot starve a quiet one.

/**
 * How many repositories one tick may count.
 *
 * Chosen against the RATE LIMIT rather than against a wish: GitLab.com's 5
 * requests/minute on some endpoints is the binding constraint, and 25 calls
 * spread across a 30-minute cadence sits an order of magnitude under it even if
 * every one of them were GitLab and every one landed in the same minute. Raising
 * it is a decision to take against that number, not a knob.
 */
export const DRIFT_RECOMPUTE_BATCH = 25;

export interface DriftSweepSummary {
  scanned: number;
  counted: number;
  /** Determined to be uncountable for this pair — recorded, not retried for ever. */
  indeterminate: number;
  /** The pair moved under us, or the row vanished; nothing written. */
  skipped: number;
}

export const codeGraphDriftService = {
  /**
   * Count the drift for every repository whose pair has moved since it was last
   * counted, up to {@link DRIFT_RECOMPUTE_BATCH}.
   *
   * ⚠️ ONE REPOSITORY'S FAILURE NEVER ABORTS THE SWEEP. A host that is down for
   * one installation must not stop every other tenant's count from being taken —
   * the same isolation the auto-plan cadence sweep applies for the same reason.
   */
  async recomputeDrift(limit: number = DRIFT_RECOMPUTE_BATCH): Promise<DriftSweepSummary> {
    // ⚠️ A SYSTEM CONTEXT, BECAUSE THE SWEEP BELONGS TO NO TENANT.
    // `github_repo`'s RLS policy is `system_admin OR workspace_id =
    // app.workspace_id`; an unbound read returns ZERO ROWS AND RAISES NOTHING,
    // which is indistinguishable from an estate with no drift.
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listNeedingDriftRecompute(limit, tx),
    );
    const summary: DriftSweepSummary = {
      scanned: rows.length,
      counted: 0,
      indeterminate: 0,
      skipped: 0,
    };

    for (const repo of rows) {
      const base = repo.indexedHeadSha;
      const head = repo.defaultBranchHeadSha;
      // The SQL already filtered these out; the guard is here because the types
      // are nullable and a narrowing that leans on a WHERE clause is a narrowing
      // the next reader cannot see.
      if (base === null || head === null) {
        summary.skipped += 1;
        continue;
      }

      let behindBy: number | null = null;
      try {
        const provider = getGitProvider(repo.provider as GitProviderId);
        const comparison = await provider.compareCommits(
          repo.hostInstallationId,
          repo.owner,
          repo.name,
          base,
          head,
        );
        behindBy = comparison.behindBy;
        if (behindBy === null) {
          console.warn('[code-graph-drift] not determinable', {
            repoRef: `${repo.owner}/${repo.name}`,
            reason: comparison.reason,
          });
        }
      } catch (err) {
        // ⚠️ A THROW IS `null`, NOT A SKIP, and never a re-raise. An unregistered
        // provider and a host that broke its contract are both "we cannot count
        // this pair" — recording that is what stops the sweep re-trying the same
        // repository on every tick for ever, and it renders exactly as the
        // never-counted case does.
        console.error('[code-graph-drift] compare failed; recording as not determinable', {
          repoRef: `${repo.owner}/${repo.name}`,
          err,
        });
        behindBy = null;
      }

      // ⚠️ THE WRITE IS CONDITIONAL ON THE PAIR STILL BEING THE ROW'S. A push or
      // an index run can land while the compare is in flight; writing then would
      // stamp a count computed for the OLD pair with the NEW pair's shas, which
      // no later read could detect. Losing that race writes nothing.
      const written = await withSystemContext((tx) =>
        githubRepoRepository.setDriftCount(repo.id, behindBy, base, head, tx),
      );
      if (written === 0) summary.skipped += 1;
      else if (behindBy === null) summary.indeterminate += 1;
      else summary.counted += 1;
    }

    return summary;
  },
};
