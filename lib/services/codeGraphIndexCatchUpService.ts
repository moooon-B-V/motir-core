import { checkIndexAllowance } from '@/lib/ai/motirAiClient';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
import { isIndexHardStop, type IndexAllowanceVerdict } from '@/lib/ciFleet/indexAllowance';
import { enqueueCodeGraphIndex, enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import {
  githubRepoRepository,
  type IndexCatchUpCandidate,
} from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE INDEX CATCH-UP SWEEP (MOTIR-5290 · Story MOTIR-4335).
//
// MOTIR-4593 pauses indexing for a repository when its organisation's internal
// index allowance answers a HARD STOP, and records why. A stop lifts on three
// events — a top-up, a paid tier's new period (`invoice.paid` renews the pool,
// MOTIR-5284) and an upgrade from a Free organisation stopped at its one-time
// allowance — and ALL THREE HAPPEN IN MOTIR-AI. motir-core hears about none of
// them, so this does not wait to be told: it RE-ASKS.
//
// ⚠️ PULL, NOT PUSH, AND THE TRADE IS STATED. One mechanism covers every lift
// event, keeps the card in one repository, and survives a lost notification
// because there is none to lose. It costs latency: indexing resumes within one
// sweep interval of the lift, not at the lift.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.
//
// ⚠️ DRIFT, NEVER THE CALENDAR. When an organisation may index again, a paused
// repository is refreshed ONLY if its default branch moved past the graph. An old
// graph on an unchanged repository is a fresh graph: refreshing it would spend
// the allowance that was just granted on code that did not change. Its pause is
// cleared instead. A repository that was never indexed has no graph to be
// current, so it gets its FIRST index.
//
// ⚠️ THE PAUSE IS NOT CLEARED WHEN A REFRESH IS ENQUEUED. The enqueue is
// best-effort and swallows a transport failure, so clearing there could leave a
// stale repository with no record that anything is owed. The dispatched run asks
// the allowance itself and lifts the pause when it boots (MOTIR-4593); until then
// a later sweep may enqueue again, which the refresh job's per-repo debounce
// coalesces.

/** Paused repositories considered per tick — oldest pause first. */
export const INDEX_CATCH_UP_BATCH = 200;

export type IndexCatchUpOutcome =
  /** The allowance still answers a hard stop — the pause stays. */
  | 'still_stopped'
  /** The allowance could not be asked — every pause stays, and the next sweep retries. */
  | 'ask_failed'
  /** Allowed again, and the head moved past the graph — a refresh was enqueued. */
  | 'refresh_enqueued'
  /** Allowed again, never indexed — a first index was enqueued. */
  | 'index_enqueued'
  /** Allowed again, and the graph is current — the pause was cleared, nothing enqueued. */
  | 'pause_cleared'
  /** Allowed again, but the head is unknown — nothing can say the graph is behind.
   *  The pause stays; the next default-branch push records a head and enqueues its
   *  own refresh. */
  | 'head_unknown'
  /** The action for this repository threw — its pause stays, and the next sweep retries. */
  | 'action_failed';

export interface IndexCatchUpSummary {
  scanned: number;
  organizationsAsked: number;
  outcomes: { repoRef: string; organizationId: string; outcome: IndexCatchUpOutcome }[];
}

export interface IndexCatchUpDeps {
  check: (organizationId: string) => Promise<IndexAllowanceVerdict | null>;
  enqueueRefresh: (data: CodeGraphIndexData) => Promise<void>;
  enqueueIndex: (data: CodeGraphIndexData) => Promise<void>;
}

// Looked up at CALL time, not captured at import: a suite that mocks the client
// module without these exports must still be able to import the job registry.
const defaultDeps: IndexCatchUpDeps = {
  check: (organizationId) => checkIndexAllowance(organizationId),
  enqueueRefresh: (data) => enqueueCodeGraphRefresh(data),
  enqueueIndex: (data) => enqueueCodeGraphIndex(data),
};

/**
 * What to do with ONE paused repository of an organisation that may index again.
 *
 * ⚠️ WHETHER THE GRAPH IS BEHIND IS `deriveCodeGraphIndexState`'s ANSWER, NOT A
 * SECOND ONE (`tests/codeGraph/indexState.test.ts` holds the tree to one
 * derivation). This only hands it the row's facts. `hasSucceededIndex` is read
 * from `indexedHeadSha`, which is stamped only by a succeeded run; a repository
 * indexed before that column existed reads `never` here and is given one more
 * first index — over-indexing once, never leaving a graph behind.
 */
export function catchUpActionFor(
  repo: Pick<IndexCatchUpCandidate, 'indexedHeadSha' | 'defaultBranchHeadSha'>,
): 'refresh_enqueued' | 'index_enqueued' | 'pause_cleared' | 'head_unknown' {
  const state = deriveCodeGraphIndexState({
    hasSucceededIndex: repo.indexedHeadSha !== null,
    defaultBranchHeadSha: repo.defaultBranchHeadSha,
    indexedHeadSha: repo.indexedHeadSha,
    // A paused repository has nothing in flight: the pause released its claim.
    hasRunningIndex: false,
  });
  if (state === 'never') return 'index_enqueued';
  if (state === 'indexed') {
    // `indexed` with no recorded head means NOTHING says it is behind — the
    // derivation's own reading of a null head — which is not the same as current.
    return repo.defaultBranchHeadSha === null ? 'head_unknown' : 'pause_cleared';
  }
  return 'refresh_enqueued';
}

export const codeGraphIndexCatchUpService = {
  /**
   * One pass. Never throws on a single organisation's failure: an unreachable
   * motir-ai leaves that organisation's pauses in place and the pass moves on.
   */
  async catchUp(
    opts: { limit?: number; deps?: IndexCatchUpDeps } = {},
  ): Promise<IndexCatchUpSummary> {
    const deps = opts.deps ?? defaultDeps;
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listIndexPaused(opts.limit ?? INDEX_CATCH_UP_BATCH, tx),
    );
    const summary: IndexCatchUpSummary = {
      scanned: rows.length,
      organizationsAsked: 0,
      outcomes: [],
    };

    // ONE ask per organisation: the verdict is org-scoped, and asking per
    // repository would multiply the calls by the estate's width for one answer.
    const byOrganization = new Map<string, IndexCatchUpCandidate[]>();
    for (const row of rows) {
      byOrganization.set(row.organizationId, [
        ...(byOrganization.get(row.organizationId) ?? []),
        row,
      ]);
    }

    for (const [organizationId, repos] of byOrganization) {
      summary.organizationsAsked += 1;
      // Total client: `null` is "could not ask", and it is never read as a lift.
      const verdict = await deps.check(organizationId);
      const blanket: IndexCatchUpOutcome | null = !verdict
        ? 'ask_failed'
        : isIndexHardStop(verdict.outcome)
          ? 'still_stopped'
          : null;

      for (const repo of repos) {
        const repoRef = `${repo.owner}/${repo.name}`;
        const outcome = blanket ?? catchUpActionFor(repo);
        const data: CodeGraphIndexData = {
          installationId: repo.hostInstallationId,
          workspaceId: repo.workspaceId,
          repoOwner: repo.owner,
          repoName: repo.name,
          defaultBranch: repo.defaultBranch,
        };
        try {
          if (outcome === 'refresh_enqueued') await deps.enqueueRefresh(data);
          if (outcome === 'index_enqueued') await deps.enqueueIndex(data);
          if (outcome === 'pause_cleared') {
            await withSystemContext((tx) => githubRepoRepository.clearIndexPause(repoRef, tx));
          }
          summary.outcomes.push({ repoRef, organizationId, outcome });
        } catch (err) {
          // One repository's failure never stops the rest; its pause stays.
          console.error('[index-catch-up] could not act on a paused repository', { repoRef, err });
          summary.outcomes.push({ repoRef, organizationId, outcome: 'action_failed' });
        }
      }
    }
    return summary;
  },
};
