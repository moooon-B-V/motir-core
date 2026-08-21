import { withSystemContext } from '@/lib/workspaces/context';
import { codeGraphPendingChangeRepository } from '@/lib/repositories/codeGraphPendingChangeRepository';

// THE CHANGED PATHS A PUSH ALREADY NAMED (Story MOTIR-3249 · Subtask MOTIR-3358).
//
// A refresh spends its whole run rediscovering something Motir was told. Measured
// 2026-08-21 on the real motir-core tree: a whole-tree `sync()` checks 3 571 files
// to find 3 and costs 4.29 s locally; `indexFiles([the 2 changed paths])` costs
// 0.59 s and produces the same 27 nodes. In production that walk IS the run — 124 s
// of a 148 s refresh — because on a 2-vCPU fleet machine the walk is I/O-bound
// against a 202 MB graph (7.7× the graph costs 5.67× the sync there, against 1.27×
// on a dev box).
//
// ⚠️ THIS DOES NOT RE-OPEN MOTIR-3249's DECISION 1. That refused a GitHub COMPARE
// call — a network round trip and a credential the container is defined by not
// holding — and the refusal stands. Nothing here calls GitHub: the paths arrive
// free with the push event that already triggers the refresh, and
// `githubWebhookService` reads that payload today and throws the file lists away.
//
// ── The two things that make this safe rather than fast ──────────────────────
//
// **A partial list is the only input that can produce a silently wrong graph.**
// Index two paths when five changed and the other three stay stale — in a graph
// no reader can tell is stale, feeding every planner answer built on it. So this
// service is written so that the fast path is optional and the safe path is the
// default: on ANY doubt it offers nothing and the container performs exactly the
// whole-tree sync it performs today.
//
// **And the debounce is what creates the doubt.** `codeGraphRefresh` coalesces
// 2 minutes of pushes per repo into one run, and a debounce delivers only the LAST
// event — so the paths cannot ride the event. They accumulate in a table instead,
// and a run drains every row for its repo.

/** The largest union this will hand over. Beyond it a whole-tree sync is both
 *  simpler and, at that many changed files, no slower — the crossover MOTIR-3249
 *  measured at the other end (a 2 481-file diff synced SLOWER than a rebuild). */
const MAX_CHANGED_PATHS = 500;

/** How long a claim may sit before another run may take it. A supervisor that
 *  crashed must not strand a repo's paths forever; reclaiming early costs one
 *  whole-tree sync, which is what happens today anyway. */
const CLAIM_STALE_AFTER_MS = 60 * 60 * 1000;

export interface RepoKey {
  installationId: string;
  repoOwner: string;
  repoName: string;
}

/** What a run may index instead of walking the tree — or why it may not. */
export type ClaimedChangedPaths =
  | {
      /** A COMPLETE union: every pending row named its paths, and there are few
       *  enough to be worth handing over. */
      usable: true;
      paths: string[];
      /** The newest head among the claimed rows. The dispatch pins its tarball to
       *  THIS, which is what makes the path list describe the tree that is
       *  actually indexed rather than whatever the branch points at by the time
       *  the container fetches. */
      headSha: string;
      claimedRows: number;
    }
  | {
      /** Nothing was claimed, or what was claimed cannot be trusted. The run does
       *  exactly what it does today. */
      usable: false;
      reason:
        | 'no-pending-changes'
        | 'a-push-did-not-name-its-paths'
        | 'no-head-sha-to-pin-the-tree-to'
        | 'too-many-changed-paths';
      claimedRows: number;
    };

export const codeGraphChangedPathsService = {
  /**
   * Record one push's changed paths.
   *
   * BEST-EFFORT and post-commit, exactly like the refresh enqueue beside it: the
   * webhook ack must never hinge on this, and a dropped row costs a whole-tree
   * sync rather than a wrong graph. It is the FAST path that is optional.
   *
   * An EMPTY `paths` is recorded deliberately rather than skipped — it is how a
   * push whose file list we do not have (a force-push, a payload GitHub truncated
   * at its commit cap) poisons the union it belongs to. Skipping it would leave
   * the remaining rows looking complete when they are not.
   */
  async recordPush(
    input: RepoKey & { workspaceId: string; headSha: string | null; paths: string[] },
  ): Promise<void> {
    try {
      await withSystemContext((tx) =>
        codeGraphPendingChangeRepository.append(
          {
            installationId: input.installationId,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            workspaceId: input.workspaceId,
            headSha: input.headSha,
            paths: dedupe(input.paths),
          },
          tx,
        ),
      );
    } catch (err) {
      console.error(
        `[code-graph-changed-paths] ${input.repoOwner}/${input.repoName}: the push's changed ` +
          `paths were not recorded; the next refresh will sync the whole tree:`,
        err,
      );
    }
  },

  /**
   * CLAIM every pending row for a repo and decide whether the union may be used.
   *
   * The claim is what makes a failure safe: the rows are held, not consumed, and
   * {@link settle} either deletes them (the index succeeded, so their files are in
   * the graph) or releases them (anything else, so the next run gets them).
   *
   * ⚠️ `claimRef` MUST BE STABLE ACROSS INNGEST PASSES — the triggering event's id
   * (`event.id ?? ctx.runId`), which is what the caller passes. NOT `ctx.runId`,
   * which is re-derived on every pass: this value is stamped here, before the first
   * container, and matched again in {@link settle} many passes later, so a claim
   * held under `runId` can never be settled. Same value, and the same argument, as
   * the admission slot's `owner_ref`.
   */
  async claim(
    key: RepoKey,
    claimRef: string,
    now: Date = new Date(),
  ): Promise<ClaimedChangedPaths> {
    const rows = await withSystemContext((tx) =>
      codeGraphPendingChangeRepository.claimForRepo(
        key,
        claimRef,
        now,
        new Date(now.getTime() - CLAIM_STALE_AFTER_MS),
        tx,
      ),
    );

    if (rows.length === 0) return { usable: false, reason: 'no-pending-changes', claimedRows: 0 };

    // ONE unknown poisons the union. This is the load-bearing line of the file:
    // every other branch here is a cost decision, and this one is the correctness
    // decision.
    if (rows.some((row) => row.paths.length === 0)) {
      return {
        usable: false,
        reason: 'a-push-did-not-name-its-paths',
        claimedRows: rows.length,
      };
    }

    // The NEWEST head among the claimed rows — the tree the container will be
    // pinned to. Without one there is nothing to pin, and an unpinned tarball is
    // whatever the branch points at when the container fetches, which the union
    // does not describe.
    const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!newest?.headSha) {
      return {
        usable: false,
        reason: 'no-head-sha-to-pin-the-tree-to',
        claimedRows: rows.length,
      };
    }

    const paths = dedupe(rows.flatMap((row) => row.paths));
    if (paths.length > MAX_CHANGED_PATHS) {
      return { usable: false, reason: 'too-many-changed-paths', claimedRows: rows.length };
    }

    return { usable: true, paths, headSha: newest.headSha, claimedRows: rows.length };
  },

  /**
   * Finish with what a run claimed.
   *
   * `indexed: true` DELETES — the files are in the graph, so the rows have done
   * their job. Anything else RELEASES, including a run that claimed rows and then
   * declined to use them: those paths still describe work the graph has not
   * absorbed, and the next run must see them.
   */
  async settle(claimRef: string, indexed: boolean): Promise<number> {
    return withSystemContext((tx) =>
      indexed
        ? codeGraphPendingChangeRepository.deleteClaimed(claimRef, tx)
        : codeGraphPendingChangeRepository.releaseClaimed(claimRef, tx),
    );
  },
};

/** Stable, order-preserving de-duplication — a file touched by three commits is
 *  one path, and the order is the order it was first seen so a diff of two runs
 *  reads as a diff rather than as a reshuffle. */
function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export const CHANGED_PATHS_LIMITS = { MAX_CHANGED_PATHS, CLAIM_STALE_AFTER_MS } as const;
