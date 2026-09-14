import { getGitProvider } from '@/lib/git';
import { readPullRequest } from '@/lib/github/pullRequestRead';
import {
  githubPullRequestRepository,
  type ReconcileCandidate,
} from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { githubWebhookService } from './githubWebhookService';
import { workflowsService } from './workflowsService';

// THE OPEN-DELIVERY RECONCILE (MOTIR-5390) — the path that makes a lost
// `pull_request` delivery recoverable instead of permanent.
//
// ── The defect it closes ─────────────────────────────────────────────────
// The status sync has exactly ONE ingress for a merge: the GitHub App's
// `pull_request` delivery. If that request fails (a 500 while the connection
// pool is starved, a restart mid-request) or never arrives, the mirror row keeps
// reading `open` and the card it delivers never completes. GitHub does not
// redeliver a failed App delivery on its own, and nothing else in this repository
// re-read a pull request's state from the host — so one lost event held a card at
// In Review with no end date. `motir-meta#395` merged at 19:58:55Z on 2026-09-13;
// its row still read `open` and MOTIR-4336 sat at In Review behind it.
//
// ⚠️ AND A DELIVERY CAN DIE HALF-WAY. The sync commits the row upsert in one
// transaction and moves the card in a later one, so a failure at the transition
// leaves the row `closed` / `merged` and the card where it was — a redelivery
// repairs it, and none comes. Such a row is recognisable exactly: the post-commit
// capture that stamps `merged_at` runs after the sync, so it never ran.
//
// ── What it does ─────────────────────────────────────────────────────────
// Treat the webhook as the FAST path and a periodic read of the host as the
// GUARANTEE. Each pass:
//   1. DISCOVERS delivering pull requests nothing has heard about for a while
//      that are either still OPEN, or MERGED with no `merged_at` inside a
//      lookback (`listReconcileCandidates`) — cross-tenant, under the system
//      flag, over tables that are all armed for it.
//   2. Keeps only those that still deliver a LIVE card (not archived, not in a
//      done-category status), read per tenant with the workspace bound, because
//      `work_item` has no system arm. A pull request whose every card is already
//      finished is not worth a host call.
//   3. READS the pull request from GitHub with the installation token.
//   4. When the host says it is CLOSED — merged or not — REPLAYS it as a
//      `closed` delivery through `githubWebhookService.handlePullRequest`, the
//      same arm a real delivery reaches. So the sync, its row lock, every
//      completion gate (base branch, delivery set, repository set, draft), the
//      author attribution and the merged-path capture all apply unchanged, and
//      there is no second transition path to drift from the first.
//   5. When the host says it is still OPEN, records that it asked
//      (`markReconciled`) so the row rotates to the back of the queue.
//
// ── Why only CLOSED is replayed ───────────────────────────────────────────
// A missed `opened` or `ready_for_review` leaves a card one rung low, and the next
// delivery for that pull request (any push's CI, the merge itself) repairs it. A
// missed `closed` is the only delivery with NO successor: nothing else will ever
// arrive for that pull request, so it is the one a guarantee is owed for.
//
// ── Idempotency ───────────────────────────────────────────────────────────
// A late or duplicate real delivery after a reconcile, or the other way round, is
// the redelivery case the sync already converges on: the row lock serializes
// them, the second sees the card already in its target status and reports `noop`,
// and `mergeAlreadyRecorded` keeps the one-time notes one-time. A row a real
// delivery already finished stops matching either arm — it is no longer open, and
// its capture has stamped `merged_at` — so it is never read again.
//
// ── Bounded ───────────────────────────────────────────────────────────────
// At most `PULL_REQUEST_RECONCILE_BATCH_SIZE` candidates per pass, only rows
// quiet for `PULL_REQUEST_RECONCILE_QUIET_MINUTES`, and only rows delivering a
// live card reach the host. A per-row failure is COUNTED, never thrown: the row
// is simply due again next pass, and one revoked installation does not cost the
// other rows their reconcile.

/** Candidates examined per pass. Far above the realistic count of open,
 *  delivering pull requests quiet for the threshold, and still one host request
 *  per row at most — a few dozen requests every thirty minutes against a limit of
 *  thousands an hour per installation. */
export const PULL_REQUEST_RECONCILE_BATCH_SIZE = 50;

/** How long a row must have been quiet before the reconcile asks the host. Long
 *  enough that a delivery still in flight lands first and the reconcile finds
 *  nothing to do; short enough that a lost merge is repaired within the hour. */
export const PULL_REQUEST_RECONCILE_QUIET_MINUTES = 10;

/** How far back a MERGED row with no `merged_at` is still treated as a delivery
 *  that died half-way. A replay repairs one within the hour, so a week is ample;
 *  the bound exists to exclude rows mirrored before the column existed, and a card
 *  somebody deliberately re-opened long after its pull request merged. */
export const PULL_REQUEST_RECONCILE_MERGE_LOOKBACK_DAYS = 7;

export interface PullRequestReconcileSummary {
  /** Candidate rows the discovery read returned. */
  examined: number;
  /** Rows skipped with NO host call because every card they deliver is finished. */
  skippedNoLiveCard: number;
  /** Rows the host still reports open — stamped as heard-from, nothing replayed. */
  stillOpen: number;
  /** Rows the host reports closed, replayed through the delivery path. */
  replayed: number;
  /** Of `replayed`, how many moved a card (the sync reported a transition). */
  transitioned: number;
  /** Rows the host no longer has (404 / 410) — left as they are, and reported. */
  gone: number;
  /** Rows whose reconcile threw (token mint, host read, replay) — due again next pass. */
  failed: number;
}

/** The sync outcomes that mean a card actually moved. */
const MOVED_OUTCOMES = new Set(['transitioned', 'session_closed', 'delivery_applied']);

export const pullRequestReconcileService = {
  /**
   * One reconcile pass. `now` is injectable so a test can place rows either side
   * of the quiet threshold without sleeping.
   */
  async reconcileOpenDeliveries(
    opts: { now?: Date; batchSize?: number } = {},
  ): Promise<PullRequestReconcileSummary> {
    const now = opts.now ?? new Date();
    const summary: PullRequestReconcileSummary = {
      examined: 0,
      skippedNoLiveCard: 0,
      stillOpen: 0,
      replayed: 0,
      transitioned: 0,
      gone: 0,
      failed: 0,
    };

    const candidates = await withSystemContext((tx) =>
      githubPullRequestRepository.listReconcileCandidates(
        {
          updatedBefore: new Date(now.getTime() - PULL_REQUEST_RECONCILE_QUIET_MINUTES * 60_000),
          mergedSince: new Date(
            now.getTime() - PULL_REQUEST_RECONCILE_MERGE_LOOKBACK_DAYS * 24 * 60 * 60_000,
          ),
          take: opts.batchSize ?? PULL_REQUEST_RECONCILE_BATCH_SIZE,
        },
        tx,
      ),
    );
    summary.examined = candidates.length;

    // One token per installation per pass. A mint that fails is remembered, so the
    // installation's other rows are counted as failed without asking again.
    const tokens = new Map<string, Promise<string>>();
    const tokenFor = (installationId: string): Promise<string> => {
      let token = tokens.get(installationId);
      if (!token) {
        token = getGitProvider('github')
          .mintInstallationToken(installationId)
          .then((t) => t.token);
        tokens.set(installationId, token);
      }
      return token;
    };

    for (const candidate of candidates) {
      try {
        if (!(await deliversLiveCard(candidate))) {
          summary.skippedNoLiveCard += 1;
          continue;
        }

        const { repo } = candidate;
        const token = await tokenFor(repo.installation.installationId);
        const read = await readPullRequest(token, repo.owner, repo.name, candidate.number);

        if (read.kind === 'gone') {
          summary.gone += 1;
          console.warn(
            `[pullRequestReconcile] ${repo.owner}/${repo.name}#${candidate.number} is gone on the host ` +
              `(${read.status}); its row is left open and its card is not moved.`,
          );
          await markReconciled(candidate);
          continue;
        }

        if (read.pullRequest['state'] !== 'closed') {
          summary.stillOpen += 1;
          await markReconciled(candidate);
          continue;
        }

        const result = await githubWebhookService.handlePullRequest(
          replayedClosedDelivery(candidate, read.pullRequest),
        );
        summary.replayed += 1;
        if ('outcome' in result && MOVED_OUTCOMES.has(result.outcome)) summary.transitioned += 1;
        // A WARNING, not an info line: every replay means a delivery was lost, and
        // that is the signal worth finding in the logs.
        console.warn(
          `[pullRequestReconcile] replayed a missed close for ${repo.owner}/${repo.name}#${candidate.number}: ` +
            `${'outcome' in result ? result.outcome : result.event}`,
        );
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[pullRequestReconcile] could not reconcile ${candidate.repo.owner}/${candidate.repo.name}` +
            `#${candidate.number}; it is due again next pass:`,
          err,
        );
      }
    }

    return summary;
  },
};

/**
 * Whether the pull request still delivers at least one card that could move — not
 * archived, and not in a done-category status of its own project's workflow.
 *
 * Read per WORKSPACE with the workspace bound, never under the bare system flag:
 * `work_item` and `workflow_status` carry no system arm, so an unbound read
 * returns nothing and every candidate would look finished. The delivery row
 * carries the workspace, which is the trusted source of the tenant.
 */
async function deliversLiveCard(candidate: ReconcileCandidate): Promise<boolean> {
  const byWorkspace = new Map<string, string[]>();
  for (const d of candidate.deliveries) {
    byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d.workItemId]);
  }

  for (const [workspaceId, workItemIds] of byWorkspace) {
    const live = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      const items = (await workItemRepository.findByIds(workItemIds, tx)).filter(
        (item) => item.archivedAt === null,
      );
      if (items.length === 0) return false;
      const terminal = await workflowsService.getTerminalStatusKeysByProjects(
        items.map((item) => item.projectId),
        workspaceId,
        tx,
      );
      return items.some((item) => !terminal.get(item.projectId)?.has(item.status));
    });
    if (live) return true;
  }
  return false;
}

/** Stamp the row as heard-from, under the tenant the sync itself writes it under. */
async function markReconciled(candidate: ReconcileCandidate): Promise<void> {
  await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, candidate.repo.workspaceId);
    await githubPullRequestRepository.markReconciled(candidate.id, tx);
  });
}

/**
 * The `pull_request` delivery GitHub would have sent for this close.
 *
 * The single-PR read returns the same `pull_request` object a delivery carries, so
 * it is passed through verbatim; the envelope supplies the two fields a delivery
 * adds around it — the action and the installation — and the repository id, taken
 * from the MIRROR row rather than the payload so the replay resolves to exactly the
 * repository the candidate was discovered under.
 */
export function replayedClosedDelivery(
  candidate: ReconcileCandidate,
  pullRequest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: 'closed',
    installation: { id: candidate.repo.installation.installationId },
    repository: { id: candidate.repo.repoId },
    pull_request: pullRequest,
  };
}
