import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider, providerSupportsRepoTarballUrl } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { CodeRepoVerdict } from '@/lib/dto/codeContext';

// Resolve the CODE half of a planning-job context bag (Subtask 7.10.15 ·
// MOTIR-1598) — the workspace's connected repo SET, read from the persisted
// installation grant mirror (7.10.3 · MOTIR-891). This is the PRODUCER side of
// the `context.code.repos[]` cross-repo contract with motir-ai's multi-repo
// code-graph reads (7.10.16 · MOTIR-1599).
//
// Shared by every PLANNING-job dispatch entry point (`generate_tree` today; the
// augment / expand_item / replan submits adopt it when they land) so the
// resolution lives in one place — the exact shape `resolveTenantOrg` set for the
// org half. Scoping is the WORKSPACE's connected set (a workspace is one
// product, so its projects share the product's repos), matching the 7.5
// code-graph index fan-out (`codeGraphIndexService`).
//
// A PROJECT-scoped alternative now exists (MOTIR-1780): `project_repository` is
// the project's repository SET, so `projectRepoSetService.listByProject` can answer
// "this project's repos" where this function answers "the workspace's". This
// resolver is DELIBERATELY left at workspace scope — re-pointing it would change
// which repos a planning job sees, i.e. shipped, working AI-context behaviour, and
// that adoption belongs to MOTIR-1754 (the BYOK code-index loop) alongside per-repo
// index freshness. So the association is no longer missing, only unadopted here.
//
// A DB read ONLY (the 891 mirror rows) — never a GitHub API round-trip on the
// submit path. No installation, or an installation with no granted repos,
// resolves to `undefined` so the caller OMITS `context.code` entirely and a
// start-fresh project's envelope stays byte-identical to a code-less one.

/** One connected repo as it rides the job envelope. */
export interface JobCodeRepo {
  /** The git-provider discriminator (`"github"` today; the GitProvider seam). */
  provider: string;
  /** `owner/name` — the ref motir-ai keys its per-repo code-graph stores on. */
  repoRef: string;
  defaultBranch: string;
}

/** The `context.code` unit of a planning-job envelope (the plural contract). */
export interface JobCodeContext {
  repos: JobCodeRepo[];
}

export async function resolveCodeContext(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<JobCodeContext | undefined> {
  const repos = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const installation = await githubInstallationRepository.findByWorkspaceId(
        ctx.workspaceId,
        tx,
      );
      if (!installation) return [];
      return githubRepoRepository.listByInstallation(installation.id, tx);
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => ({
      provider: repo.provider,
      repoRef: `${repo.owner}/${repo.name}`,
      defaultBranch: repo.defaultBranch,
    })),
  };
}

// ── The PLANNING-SESSION producer (Story MOTIR-1754 · MOTIR-4604) ────────────
//
// `resolveCodeContext` above answers "which repos are connected?". A planning
// session needs more: **how current is each graph, why it is behind, and whether
// anything is actually doing something about it.**
//
// ⚠️ THE SESSION MUST NOT SAY "FETCHING THE LATEST" WHEN NOTHING IS FETCHING.
// A graph is rarely stale by accident — with push-driven refresh healthy the drift
// is minutes, so badly stale means something stopped it. That is why the envelope
// carries a REASON and an IN-FLIGHT FLAG as two separate facts: the reason
// EXPLAINS, the flag DECIDES WHICH EXITS EXIST. Collapsing them into one string
// would force the gate (MOTIR-4601) to parse prose to decide whether it may offer
// "come back later" — and a session that announces a fetch which is not happening
// is a new instance of exactly the dishonesty this story exists to remove, wearing
// the fix's clothes.

/** Why a repo's graph is not current. A TOTAL union — see the mapping below. */
export type CodeRefreshReason =
  /** A refresh was enqueued by THIS session start. */
  | 'refresh_enqueued'
  /** A refresh is already in flight (or held by the shipped debounce). */
  | 'refresh_pending'
  /** Connected, but no graph has ever been built. */
  | 'never_indexed'
  /** The host cannot be indexed at all — GitLab today (MOTIR-4609). */
  | 'provider_unsupported'
  /** Refreshes are failing. */
  | 'refresh_failing'
  /** Refreshes are paused. ⚠️ NEVER the internal cause (MOTIR-4541). */
  | 'paused';

/** One connected repo as it rides the job envelope, with its freshness. */
export interface JobCodeRepoState extends JobCodeRepo {
  /**
   * ⚠️ ABSENT when freshness could not be READ — absence is not a claim.
   * A motir-ai outage must not make every repo announce "I haven't seen this
   * repo", which would be a new false statement wearing the fix's clothes. The
   * envelope's `freshnessUnknown` flag says so once, at the top.
   */
  verdict?: CodeRepoVerdict;
  /** Absent when the graph is CURRENT — there is nothing to explain. */
  reason?: CodeRefreshReason;
  /**
   * Is something actually running? The gate may offer "come back later" if and
   * only if this is true.
   *
   * ⚠️ A DEBOUNCED NO-OP STILL COUNTS AS IN FLIGHT. When the shipped debounce
   * suppresses this session's enqueue because a refresh is already pending,
   * something IS running and the wait is honest. Only "nothing will happen"
   * makes this false. Backwards, it silences the come-back exit exactly when it
   * is most useful.
   */
  refreshInFlight: boolean;
  indexedCommitSha: string | null;
  headSha: string | null;
  /** Drift in COMMITS. Always null until its producer ships (MOTIR-1767). */
  commitsBehind: number | null;
}

export interface JobPlanningCodeContext {
  repos: JobCodeRepoState[];
  /**
   * The freshness read did not answer. No repo carries a verdict, no reason is
   * given and nothing is enqueued — the session says freshness is UNKNOWN rather
   * than silently implying current (MOTIR-4590's own non-fatal-read rule).
   */
  freshnessUnknown: boolean;
}

/**
 * The reason + in-flight flag for one repo — PURE, so every arm is drivable.
 *
 * ⚠️ TWO ARMS SHIP UNREACHABLE, DELIBERATELY, and the pattern is MOTIR-4590's:
 * write the mapping TOTAL with the arm present and its meaning fixed, so the day
 * its producer lands it becomes reachable and nothing here is rewritten.
 *
 *  - `paused` waits on MOTIR-4593, which records the pause reasons.
 *  - `refresh_failing` waits on a per-repo failure signal. The job ledger cannot
 *    supply one: a refresh run writes `output.repoRef` only on SUCCESS, so a
 *    FAILED row cannot be attributed to a repository at all. Deriving it from the
 *    workspace-aggregate would tell every repo that refreshes are failing because
 *    one of them is — which is worse than saying nothing.
 *
 * Neither is a gap left by accident, and neither may be faked from a signal that
 * does not mean it.
 */
export function resolveRefreshDisposition(input: {
  verdict: CodeRepoVerdict;
  canIndex: boolean;
  paused?: boolean;
  refreshFailing?: boolean;
}): { reason?: CodeRefreshReason; refreshInFlight: boolean; enqueue: boolean } {
  if (input.verdict === 'current') return { refreshInFlight: false, enqueue: false };
  // A host that cannot be indexed at all outranks every other explanation: there
  // is nothing to enqueue and no wait to offer, whatever else is true.
  if (!input.canIndex)
    return { reason: 'provider_unsupported', refreshInFlight: false, enqueue: false };
  if (input.paused) return { reason: 'paused', refreshInFlight: false, enqueue: false };
  if (input.refreshFailing)
    return { reason: 'refresh_failing', refreshInFlight: false, enqueue: false };
  // Already running — the flag is true and there is nothing to enqueue.
  if (input.verdict === 'indexing')
    return { reason: 'refresh_pending', refreshInFlight: true, enqueue: false };
  // Never indexed is a FIRST index, which the connect path owns. A refresh of a
  // graph that does not exist is not a thing to enqueue here.
  if (input.verdict === 'never_indexed')
    return { reason: 'never_indexed', refreshInFlight: false, enqueue: false };
  // Stale, indexable, nothing stopping it — this session enqueues.
  return { reason: 'refresh_enqueued', refreshInFlight: true, enqueue: true };
}

/**
 * `context.code` for a PLANNING session: the connected set, each repo's freshness
 * verdict, why it is behind, and whether a refresh is running — enqueuing one
 * where a refresh can actually run.
 *
 * ⚠️ IT NEVER BLOCKS. The enqueue is fire-and-forget through the SHIPPED
 * `enqueueCodeGraphRefresh`, so the 2-minute debounce and its cap apply and five
 * sessions in ten minutes coalesce into one refresh RUN. No second trigger with
 * its own semantics, and the session never awaits the result: whether a refresh
 * can land mid-conversation is MOTIR-4591's question, and that it must not be
 * waited on is settled here.
 *
 * Returns `undefined` — exactly as `resolveCodeContext` does — when the workspace
 * has no connected repo, so the caller OMITS `context.code` and a code-less
 * envelope stays byte-identical.
 */
export async function resolvePlanningCodeContext(ctx: {
  userId: string;
  workspaceId: string;
  projectId: string;
}): Promise<JobPlanningCodeContext | undefined> {
  const base = await resolveCodeContext(ctx);
  if (!base) return undefined;

  const state = await resolveCodeContextState(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const byRef = new Map(state.repos.map((r) => [r.repoRef, r]));

  // ⚠️ THE READ IS NON-FATAL, AND ITS FAILURE IS SAID ONCE RATHER THAN GUESSED
  // PER REPO. With no answer from motir-ai every repo would otherwise fall to its
  // default and announce something false — which is the failure this whole story
  // exists to remove, reintroduced by the fix. So: no verdict, no reason, no
  // enqueue, and one honest flag.
  if (state.freshnessUnavailable) {
    return {
      freshnessUnknown: true,
      repos: base.repos.map((repo) => ({
        ...repo,
        refreshInFlight: false,
        indexedCommitSha: null,
        headSha: byRef.get(repo.repoRef)?.headSha ?? null,
        commitsBehind: null,
      })),
    };
  }

  const repos: JobCodeRepoState[] = [];
  for (const repo of base.repos) {
    const joined = byRef.get(repo.repoRef);
    // A repo the freshness answer did not name at all. `current` is the honest
    // fallback for the same reason a NULL head is: absence of evidence is not
    // evidence of drift, and a false warning is the expensive direction.
    const verdict = joined?.verdict ?? 'current';
    let canIndex: boolean;
    try {
      canIndex = providerSupportsRepoTarballUrl(getGitProvider(repo.provider as GitProviderId));
    } catch {
      // An unregistered provider cannot be indexed, and saying so is better than
      // throwing on the submit path.
      canIndex = false;
    }
    const disposition = resolveRefreshDisposition({ verdict, canIndex });

    if (disposition.enqueue) {
      // Best-effort, exactly like the webhook's own enqueue: a queue failure must
      // never fail a planning submit.
      try {
        const installationId = await installationIdForWorkspace(ctx);
        if (installationId) {
          await enqueueCodeGraphRefresh({
            installationId,
            workspaceId: ctx.workspaceId,
            repoOwner: repo.repoRef.split('/')[0] ?? '',
            repoName: repo.repoRef.split('/').slice(1).join('/'),
            defaultBranch: repo.defaultBranch,
          });
        }
      } catch (err) {
        console.error('[codeContext] refresh not enqueued at session start; planning proceeds', {
          repoRef: repo.repoRef,
          err,
        });
      }
    }

    repos.push({
      ...repo,
      verdict,
      ...(disposition.reason ? { reason: disposition.reason } : {}),
      refreshInFlight: disposition.refreshInFlight,
      indexedCommitSha: joined?.indexedCommitSha ?? null,
      headSha: joined?.headSha ?? null,
      commitsBehind: joined?.commitsBehind ?? null,
    });
  }

  return { repos, freshnessUnknown: false };
}

/** The workspace's installation id, or null — the enqueue's required key. */
async function installationIdForWorkspace(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const installation = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx),
  );
  return installation?.installationId ?? null;
}
