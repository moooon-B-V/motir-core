import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider, providerSupportsRepoTarballUrl } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';

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
  /**
   * HAS THIS REPOSITORY GOT A CODE GRAPH (Story MOTIR-4753 · MOTIR-4826)?
   *
   * ⚠️ A FACT ON THE WIRE, NEVER A DECISION. `motir-core` supplies it exactly as
   * it supplies the ref itself; what an unindexed repository MEANS — whether the
   * person waits, or is onboarded, or plans anyway — is the routing verdict's
   * judgement (`motir-ai` MOTIR-4828), and nothing here may branch on it.
   *
   * ⚠️ AND IT EXISTS BECAUSE THE ALTERNATIVE IS INDISTINGUISHABLE. A session
   * given only the ref sees every code-graph tool answer EMPTY for a repository
   * whose index has not run — which reads exactly like a repository with nothing
   * in it, and the two support opposite verdicts. Read from the SAME succeeded-
   * index ledger the wizard's INDEX step waits on and the onboarding substrate
   * read reports from, so the three cannot disagree.
   */
  indexed: boolean;
}

/** The `context.code` unit of a planning-job envelope (the plural contract). */
export interface JobCodeContext {
  repos: JobCodeRepo[];
}

export async function resolveCodeContext(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<JobCodeContext | undefined> {
  const { repos, indexedRefs } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const installation = await githubInstallationRepository.findByWorkspaceId(
        ctx.workspaceId,
        tx,
      );
      if (!installation) return { repos: [], indexedRefs: [] as string[] };
      const rows = await githubRepoRepository.listByInstallation(installation.id, tx);
      // ⚠️ ONE LEDGER READ FOR THE WHOLE SET, and only when there IS a set — the
      // same shape `readOnboardingSubstrate` uses, and the same read, so the
      // envelope and the reading state can never tell a user two different
      // things about the same repository.
      const indexedRefs =
        rows.length === 0
          ? []
          : await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx);
      return { repos: rows, indexedRefs };
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => {
      const repoRef = `${repo.owner}/${repo.name}`;
      return {
        provider: repo.provider,
        repoRef,
        defaultBranch: repo.defaultBranch,
        indexed: indexedRefs.includes(repoRef),
      };
    }),
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
   * The repository's index state, from the ONE derivation
   * (`lib/codeGraph/indexState.ts`).
   *
   * ⚠️ IT IS NO LONGER OPTIONAL, and the reason it WAS is worth keeping: this
   * field used to be absent when freshness "could not be read", because it came
   * from motir-ai across the 7.1 boundary and an outage there must not make every
   * repository announce something false. MOTIR-4724 moved every fact into
   * motir-core's own columns, so there is no read left that can fail to answer —
   * the absence had a cause, and the cause is gone.
   */
  indexState: CodeGraphIndexState;
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
  /** When the graph was last built — rendered, never used to decide staleness. */
  indexedAt: Date | null;
  /** Drift in COMMITS. Always null until its producer ships (MOTIR-4644). */
  commitsBehind: number | null;
}

export interface JobPlanningCodeContext {
  repos: JobCodeRepoState[];
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
  indexState: CodeGraphIndexState;
  canIndex: boolean;
  paused?: boolean;
  refreshFailing?: boolean;
}): { reason?: CodeRefreshReason; refreshInFlight: boolean; enqueue: boolean } {
  if (input.indexState === 'indexed') return { refreshInFlight: false, enqueue: false };
  // A host that cannot be indexed at all outranks every other explanation: there
  // is nothing to enqueue and no wait to offer, whatever else is true.
  if (!input.canIndex)
    return { reason: 'provider_unsupported', refreshInFlight: false, enqueue: false };
  if (input.paused) return { reason: 'paused', refreshInFlight: false, enqueue: false };
  if (input.refreshFailing)
    return { reason: 'refresh_failing', refreshInFlight: false, enqueue: false };
  // Already running — the flag is true and there is nothing to enqueue.
  if (input.indexState === 'indexing')
    return { reason: 'refresh_pending', refreshInFlight: true, enqueue: false };
  // Never indexed is a FIRST index, which the connect path owns. A refresh of a
  // graph that does not exist is not a thing to enqueue here.
  if (input.indexState === 'never')
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

  // ⚠️ THE "FRESHNESS UNAVAILABLE" BRANCH IS GONE. It returned an envelope with no
  // verdicts and one honest flag, because freshness came from motir-ai and an
  // outage there must not make every repository announce something false.
  // MOTIR-4724 made every fact a motir-core column, so the read cannot fail to
  // answer — the branch is not unreachable, it is inexpressible, and a branch
  // nothing can enter is worse than no branch at all.

  const repos: JobCodeRepoState[] = [];
  for (const repo of base.repos) {
    const joined = byRef.get(repo.repoRef);
    // ⚠️ A REPOSITORY THE PROJECT'S SET DOES NOT NAME, which is a real hole and
    // not a theoretical one: the base set above is the WORKSPACE's installation
    // grant, the join is the PROJECT's configured set, and the second is a subset
    // of the first. The fallback is `never`, NOT `indexed`.
    //
    // `indexed` looks like the conservative choice — absence of evidence is not
    // evidence of drift — and it is the wrong one, for the reason the DTO's own
    // header gives: `indexed` is a claim that the graph MATCHES the code, made at
    // the exact moment somebody is deciding whether to trust a plan built from it.
    // `never` claims only that we know of no graph, which is precisely what a
    // missing join row establishes. It also disposes correctly — `never_indexed`,
    // nothing in flight, nothing enqueued — where `indexed` would silently drop
    // the repository out of every explanation the gate can offer.
    const indexState = joined?.indexState ?? 'never';
    let canIndex: boolean;
    try {
      canIndex = providerSupportsRepoTarballUrl(getGitProvider(repo.provider as GitProviderId));
    } catch {
      // An unregistered provider cannot be indexed, and saying so is better than
      // throwing on the submit path.
      canIndex = false;
    }
    const disposition = resolveRefreshDisposition({ indexState, canIndex });

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
      indexState,
      ...(disposition.reason ? { reason: disposition.reason } : {}),
      refreshInFlight: disposition.refreshInFlight,
      indexedAt: joined?.indexedAt ?? null,
      commitsBehind: joined?.commitsBehind ?? null,
    });
  }

  return { repos };
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
