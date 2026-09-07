import { Prisma } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type {
  GitProviderId,
  NormalizedChangeRequest,
  NormalizedStatusEvent,
} from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { evaluateLinkCheck } from './pullRequestLinkCheckService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { githubInstallationService } from './githubInstallationService';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { listPullRequestFiles, type PullRequestFiles } from '@/lib/github/pullRequestFiles';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import {
  syncChangeRequestStatus,
  type ChangeRequestContextResolution,
  type ChangeRequestSyncResult,
} from './changeRequestStatusSync';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
  type CiFeedbackResult,
} from './changeRequestCiFeedback';
import { ciMinutesMeterService, type MeterWorkflowRunOutcome } from './ciMinutesMeterService';
import {
  ciRunnerProvisioningService,
  type RecordQueuedJobOutcome,
} from './ciRunnerProvisioningService';
import { dispatchCiRunnerBoot } from '@/lib/ciFleet/bootDispatch';
import { ciAllowanceService } from './ciAllowanceService';
import { ciActionsGateService } from './ciActionsGateService';
import { projectRepoTakeoverService } from './projectRepoTakeoverService';
import { readReportedCheckSet } from './checkSetReconcile';

// githubWebhookService (Story 7.10 · MOTIR-892) — the inbound-webhook logic
// layer: the `installation` / `installation_repositories` grant-mirror + the
// `pull_request` → work-item status-sync state machine. The HTTP route
// (`app/api/github/webhook`) owns ONLY signature verification + dispatch; ALL
// logic is here (CLAUDE.md 4-layer). Every status write goes through the shipped
// `workItemsService` — the integration NEVER writes `workflow_status` raw (the
// write-authority rule); every payload is normalized through the `GitProvider`
// seam (`@/lib/git`), so this holds no GitHub-specific parsing.
//
// Design notes carried from the plan + the shipped reality:
//   * The webhook has NO active workspace, so the DB reads/writes run under
//     `withSystemContext` (the trusted-writer RLS escape, as `persistInstallation`
//     already does). The status transition itself is `workItemsService.updateStatus`,
//     called AFTER the context tx (it opens its own transaction) — mirroring the
//     automation engine, the shipped precedent for a non-human status move.
//   * Attribution + edit authority: `updateStatus` gates on `assertCanEdit`, so
//     the actor MUST be a member of the installation's workspace with edit rights.
//     We attribute to the PR author's bound Motir user when they are a workspace
//     member (the "bound GitHub identity" the card wants in the activity log),
//     else fall back to the workspace OWNER — a workspace manager who always
//     passes the edit gate. This is exactly the automation engine's
//     "transition as the owner" pattern (there is no per-tenant system member,
//     and the meta system principal can't pass a tenant workspace's edit gate).
//   * The installation → workspace BINDING is established by the connect flow
//     (the post-install redirect carries the workspace, as every GitHub-App
//     product does); a webhook alone cannot know the target workspace for a fresh
//     install. So the webhook MIRRORS GitHub's grant onto an ALREADY-bound
//     installation (reconcile repos / remove on uninstall) and no-ops a delivery
//     for an unbound installation.

const PROVIDER: GitProviderId = 'github';

/** PR actions that drive the status machine. Other actions (`synchronize`,
 *  `edited`, `labeled`, …) are ignored — they carry no lifecycle change the card
 *  syncs. */
const HANDLED_PR_ACTIONS = new Set(['opened', 'reopened', 'closed']);

export type GithubWebhookResult =
  | { event: 'ignored'; reason: string }
  // `skipped_shared_installation` is DISTINCT from `skipped_unbound` on purpose
  // (MOTIR-1931): unbound means "nobody connected this yet", shared means "this is
  // Motir's own provisioning installation and reconcile does not apply to it".
  | {
      event: 'installation';
      outcome:
        | 'synced'
        | 'removed'
        | 'skipped_unbound'
        | 'skipped_shared_installation'
        | 'malformed';
    }
  | {
      event: 'installation_repositories';
      outcome: 'synced' | 'skipped_unbound' | 'skipped_shared_installation' | 'malformed';
    }
  | {
      event: 'push';
      outcome:
        | 'refresh_enqueued' // a default-branch push → the incremental refresh job is queued
        | 'ignored_ref' // a non-branch push (tag / delete) or a non-default branch — no refresh
        | 'unknown_installation'
        | 'unknown_repo';
    }
  | {
      // The CI-minutes meter (Story MOTIR-1775 · MOTIR-1896). `outcome` is the
      // meter's own typed outcome, plus this handler's two edges: a delivery we
      // do not meter at all, and one whose metering threw (acked, never 500).
      event: 'workflow_run';
      outcome:
        | MeterWorkflowRunOutcome['outcome']
        | 'ignored_action'
        | 'unknown_installation'
        | 'failed';
    }
  | {
      // The runner FLEET's entry point (Story MOTIR-1916 · MOTIR-1920).
      // DISTINCT from `workflow_run` above and deliberately a separate event:
      // that one answers "how much compute did Motir just pay for?" at run
      // COMPLETION (the billing loop), while this answers "does this job need a
      // machine, and is it ours to boot one for?" at job QUEUE time (the
      // provisioning loop). `outcome` is the service's own typed outcome, plus
      // this handler's edges: a delivery we do not provision for at all, and one
      // whose recording threw (acked, never 500).
      event: 'workflow_job';
      outcome:
        | RecordQueuedJobOutcome['outcome']
        | 'ignored_action'
        | 'unknown_installation'
        | 'failed';
    }
  | {
      // The TAKE-IT-OVER saga's confirmation (MOTIR-711). `already_applied` is the
      // REDELIVERY outcome and is a success, not a warning; `owner_mismatch` is a
      // transfer to somewhere other than what the row recorded — the mirror is
      // still updated (the coordinates are a fact) but no saga is driven by it.
      event: 'repository';
      outcome:
        | 'applied'
        | 'already_applied'
        | 'unknown_repo'
        | 'owner_mismatch'
        | 'malformed'
        // MOTIR-1959 — the `archived` / `unarchived` actions. `archived_applied`
        // means a mirror row's liveness was re-stamped; `unknown_repo` covers the
        // repository Motir does not mirror, exactly as it does for `transferred`.
        | 'archived_applied';
    }
  | ChangeRequestSyncResult
  | CiFeedbackResult;

export const githubWebhookService = {
  /**
   * Handle one verified delivery. `eventType` is the `X-GitHub-Event` header;
   * `payload` is the already-parsed JSON body (the route verified the signature
   * over the RAW body BEFORE parsing). Returns a small result the route logs and
   * the tests assert on. Idempotent under redelivery: a re-applied transition is
   * a no-op, and the PR/installation upserts converge (a concurrent-redelivery
   * unique-constraint race is caught and re-read).
   */
  async handleEvent(eventType: string, payload: unknown): Promise<GithubWebhookResult> {
    const body = asRecord(payload);
    if (!body) return { event: 'ignored', reason: 'malformed_body' };

    switch (eventType) {
      case 'installation':
        return this.handleInstallation(body);
      case 'installation_repositories':
        return this.handleInstallationRepositories(body);
      case 'pull_request':
        return this.handlePullRequest(body);
      case 'push':
        return this.handlePush(body);
      case 'check_suite':
      case 'check_run':
        return this.handleCiStatus(body);
      case 'workflow_run':
        return this.handleWorkflowRun(body);
      case 'workflow_job':
        return this.handleWorkflowJob(body);
      case 'repository':
        return this.handleRepository(body);
      default:
        // `ping` and every event we don't sync land here — a fast 2xx no-op.
        return { event: 'ignored', reason: `unhandled_event:${eventType}` };
    }
  },

  async handleInstallation(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'installation', outcome: 'malformed' };

    if (body['action'] === 'deleted') {
      await githubInstallationService.removeInstallation(installationId);
      // `removeInstallation` is idempotent; either way the grant is gone.
      return { event: 'installation', outcome: 'removed' };
    }

    return { event: 'installation', outcome: await reconcileInstallation(installationId, body) };
  },

  /**
   * Handle a `repository` delivery — two independent facts, both about a
   * repository Motir mirrors.
   *
   * **`transferred`** is the TAKE-IT-OVER saga's confirmation (MOTIR-711): the
   * moment a Motir-owned repository has ACTUALLY moved to the user's account,
   * which is the one thing the saga must never assume from its own `202`.
   *
   * **`archived` / `unarchived`** is the repository's LIVENESS (MOTIR-1959).
   * Archiving makes a repo read-only, so every card resolving to it becomes
   * undispatchable — and it happens long after the row was established, which is
   * exactly the shape MOTIR-1956 recorded. The establish/connect paths stamp the
   * state when they mirror the repo; this delivery is what keeps it TRUE
   * afterwards, at no polling cost. It drives no saga and takes no lock — it is
   * one column on one row.
   *
   * ⚠️ IDEMPOTENT UNDER REDELIVERY, which is not optional — GitHub retries, and a
   * redelivery must not advance a saga twice or re-stamp a mirror that has since
   * moved on. The service re-reads the row UNDER ITS LOCK and returns
   * `already_applied` when the hop is no longer legal.
   *
   * ⚠️ IT NEVER THROWS FOR A REPOSITORY IT DOES NOT KNOW. Motir's provisioning
   * installation sees deliveries for repositories that belong to no project row,
   * and a 500 here would make GitHub retry a delivery no retry can fix.
   */
  async handleRepository(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const action = body['action'];
    if (action === 'archived' || action === 'unarchived') {
      const providerRepoId = readId(asRecord(body['repository'])?.['id']);
      if (!providerRepoId) return { event: 'repository', outcome: 'malformed' };
      const applied = await githubInstallationService.applyArchivedState({
        providerRepoId,
        archived: action === 'archived',
      });
      // `unknown_repo` for a repository no mirror row names — the SAME answer the
      // transfer path gives, and not an error: the shared provisioning
      // installation sees deliveries for repositories that belong to no project.
      return { event: 'repository', outcome: applied ? 'archived_applied' : 'unknown_repo' };
    }
    if (action !== 'transferred') {
      return { event: 'ignored', reason: `unhandled_repository_action:${String(body['action'])}` };
    }
    const repo = asRecord(body['repository']);
    const owner = repo ? asRecord(repo['owner']) : null;
    const providerRepoId = repo ? readId(repo['id']) : null;
    const newOwner = owner ? owner['login'] : null;
    const repoName = repo ? repo['name'] : null;

    if (!providerRepoId || typeof newOwner !== 'string' || typeof repoName !== 'string') {
      return { event: 'repository', outcome: 'malformed' };
    }

    const { outcome } = await projectRepoTakeoverService.applyTransferred({
      providerRepoId,
      newOwner,
      repoName,
      defaultBranch:
        typeof repo?.['default_branch'] === 'string' ? repo['default_branch'] : undefined,
    });
    return { event: 'repository', outcome };
  },

  async handleInstallationRepositories(
    body: Record<string, unknown>,
  ): Promise<GithubWebhookResult> {
    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'installation_repositories', outcome: 'malformed' };
    return {
      event: 'installation_repositories',
      outcome: await reconcileInstallation(installationId, body),
    };
  },

  /**
   * Handle a `push` delivery — the incremental code-graph feed trigger
   * (MOTIR-893). A push to a connected repo's DEFAULT branch enqueues the
   * debounced `system.code-graph-refresh` job (best-effort, post-tx) and
   * returns immediately — the fetch + re-index never run inline in the
   * webhook, so the 2xx stays fast. Any other ref (a feature branch, a tag, a
   * branch deletion) is a clean no-op: the graph tracks what SHIPPED, and
   * merged PRs land on the default branch as a push, so this one trigger also
   * covers "refresh on merge" without a second, coalescing-duplicate hook.
   */
  async handlePush(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const push = provider.parsePushEvent(body);
    // Not a branch push we refresh on (tag / delete / malformed) — a fast no-op.
    if (!push) return { event: 'push', outcome: 'ignored_ref' };

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'push', outcome: 'unknown_installation' };

    // Resolve the stored installation + repo under system context (reads only).
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        push.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };
      return {
        kind: 'resolved' as const,
        // The repo ROW's id — what the head-sha write keys on (MOTIR-4724). The
        // delivery carries the PROVIDER's ids; this is the one already resolved.
        repoRowId: repo.id,
        // The REPO says whose this is (MOTIR-1931). The installation only
        // selected which mirror rows this delivery may touch — under Motir's
        // shared provisioning installation it names no workspace at all.
        workspaceId: repo.workspaceId,
        repoOwner: repo.owner,
        repoName: repo.name,
        defaultBranch: repo.defaultBranch,
      };
    });

    if (resolved.kind === 'unknown_installation')
      return { event: 'push', outcome: 'unknown_installation' };
    if (resolved.kind === 'unknown_repo') return { event: 'push', outcome: 'unknown_repo' };

    // ⚠️ PERSIST THE HEAD (Story MOTIR-4669 · MOTIR-4724) — half of "is the code
    // graph behind the code", and it was already in this function's hands.
    // `parsePushEvent` has always returned `headSha` and this handler has always
    // discarded it, which is why staleness had no local answer and
    // `listSucceededCodeGraphIndexRepoRefs` records that it "is MOTIR-1754/1766's
    // axis and deliberately not read here". The alternative to storing it is a
    // GitHub API call per repository on every page render.
    //
    // BEFORE the branch check below, deliberately: this is a fact about the
    // repository regardless of whether the push warrants a re-index, and a push
    // to the default branch is exactly the one that must not be skipped.
    // Best-effort — a failed field write must not fail the ack for a delivery
    // GitHub will not resend.
    if (push.headSha && push.branch === resolved.defaultBranch) {
      try {
        await withSystemContext((tx) =>
          githubRepoRepository.setDefaultBranchHeadSha(resolved.repoRowId, push.headSha!, tx),
        );
      } catch (err) {
        console.error('[github-webhook] could not record the default-branch head', err);
      }
    }

    // Only the STORED default branch feeds the graph — the graph mirrors the
    // repo's shipped mainline, per tenant, per repo (the N-repo cardinality).
    if (push.branch !== resolved.defaultBranch) return { event: 'push', outcome: 'ignored_ref' };

    // POST-tx, best-effort: the ack never hinges on the queue. The job fetches
    // the default branch's CURRENT head at run time, so debounced/coalesced
    // pushes index the newest state once.
    await enqueueCodeGraphRefresh({
      installationId,
      workspaceId: resolved.workspaceId,
      repoOwner: resolved.repoOwner,
      repoName: resolved.repoName,
      defaultBranch: resolved.defaultBranch,
    });
    return { event: 'push', outcome: 'refresh_enqueued' };
  },

  async handlePullRequest(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    // ⚠️ THE LINK CHECK RUNS ABOVE THE `HANDLED_PR_ACTIONS` GATE, ON ITS OWN
    // ACTION SET (MOTIR-3675). It must see `synchronize` — a check run belongs
    // to a COMMIT, so one written at `opened` disappears from view on the first
    // push — and `ready_for_review` / `labeled` / `unlabeled`, which are the
    // draft exemption and the escape hatch arriving.
    //
    // Widening `HANDLED_PR_ACTIONS` to cover them was the obvious shape and is
    // wrong: that set bounds the file-listing capture below, whose own header
    // says it is affordable BECAUSE `synchronize` is not in it (three deliveries
    // per pull request, not one per push). So this takes its own list and runs
    // neither the status sync nor the capture. Best-effort, and awaited only so
    // a test can observe it — its failure can never reach the caller.
    await writeLinkCheckForDelivery(body);

    if (!HANDLED_PR_ACTIONS.has(String(body['action']))) {
      return { event: 'pull_request', outcome: 'ignored_action' };
    }
    const provider = getGitProvider(PROVIDER);
    const cr = provider.parseChangeRequestEvent(body);
    if (!cr) return { event: 'pull_request', outcome: 'malformed' };
    // The canonical lifecycle this delivery maps to (opened → IMPLEMENTED,
    // merged → done, closed-unmerged → todo). `opened` emitted `in_review` until
    // MOTIR-3005: an open pull request means the code exists and CI has not
    // spoken for it, and In Review now has exactly one writer — the CI-feedback
    // consumer, on a green run.
    const lifecycle = provider.changeRequestLifecycle(cr);

    // Drive the linked work item through THE shared status-sync state machine
    // (`changeRequestStatusSync`) — the same path GitLab uses (MOTIR-1475). The
    // only GitHub-specific part is resolving the connection + repo + author from
    // the App delivery's payload, which this provider supplies via the resolver.
    const result = await syncChangeRequestStatus(cr, lifecycle, (tx) =>
      resolveGithubChangeRequestContext(body, cr, tx),
    );

    // POST-COMMIT, best-effort (MOTIR-2922): capture WHAT the merge changed and
    // WHEN it landed. Runs AFTER the sync's transaction has committed and can
    // never affect `result` — the status sync is the load-bearing effect of this
    // delivery, and `notes.html` #39 is the standing rule that a side effect
    // running after a durable write may never propagate an error that fails it. A
    // merge that fails to close its card is a far worse outcome than a merge whose
    // paths went uncaptured, and only one of those two is recoverable by a later
    // read of the host.
    //
    // Gated on NEITHER the merge nor the sync's outcome (MOTIR-3230, widening
    // MOTIR-2922's merge-only capture): the paths are a fact about the repository,
    // so they are worth capturing even when the delivery resolved no work item (a
    // PR linked by hand later is then already carrying them) — and, the reason this
    // widened, even when the pull request is still OPEN.
    //
    // ⚠️ A MERGED-ONLY CAPTURE MAKES THE SUBSUMPTION CHECK STRUCTURALLY BLIND IN
    // THE ONE WINDOW IT MATTERS. That check reads `changedPaths`, so a row with an
    // empty array is invisible to it however the query is widened — an open pull
    // request could not be found by a path search because nothing had ever written
    // its paths down. Widening the query without this is a no-op, which is why the
    // two land together.
    //
    // ⚠️ AND THE COST IS BOUNDED BY `HANDLED_PR_ACTIONS`, which is what makes this
    // affordable: `opened` · `reopened` · `closed` — three deliveries per pull
    // request, not one per push, because `synchronize` is not handled. So this adds
    // at most ONE file listing per pull request opened. The honest limitation, since
    // nothing else states it: the open-time capture is a SNAPSHOT, refreshed only at
    // merge, so a path added by a later push is not visible until the merge
    // delivery. For the question the open arm answers — *is somebody working here
    // right now* — an opening snapshot is the right granularity, and a partial
    // answer during the window beats a complete one after it.
    await capturePullRequestFiles(body, cr);

    return result;
  },

  /**
   * Handle a `check_suite` / `check_run` delivery — the CI feedback half of the
   * closed loop (MOTIR-894). Normalize the payload through the `GitProvider` seam,
   * then drive the linked work item's verification feedback through THE shared
   * consumer (`applyCiStatusFeedback`) — the same path GitLab's `pipeline` hook
   * uses (MOTIR-1477). The only GitHub-specific part is resolving the installation
   * → repo from the App delivery + the PR-checks URL, which this service supplies
   * via the resolver.
   */
  async handleCiStatus(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseCiStatusEvent(body);
    if (!event) return { event: 'ci', outcome: 'malformed' };

    return applyCiStatusFeedback(event, (tx) => resolveGithubCiContext(body, event, tx));
  },

  /**
   * Handle a `workflow_run` delivery — the CI-MINUTES METER (Story MOTIR-1775 ·
   * MOTIR-1896). DISTINCT from `handleCiStatus` above, and deliberately a
   * separate event: `check_run`/`check_suite` answer "did CI pass?" (the
   * verification loop) and carry no timing at all, while this answers "how much
   * compute did Motir just pay for, and whose is it?" (the billing loop).
   *
   * Only a COMPLETED run normalizes (`ci-minutes-allowance.md` §5.7 — the
   * predicate is evaluated at run completion, which is what makes the
   * repo-transfer edge need no special case). Everything else is a fast no-op.
   *
   * The meter never throws for a run it simply does not meter, and this handler
   * does not let one that DOES throw fail the delivery: an ack that 500s makes
   * GitHub retry, and a retry cannot fix a bad token or an API outage. The
   * `(run_id, run_attempt)` idempotency key means a later redelivery — GitHub's
   * own, or a manual replay — meters it exactly once, so dropping this one
   * loses nothing that cannot be recovered.
   */
  async handleWorkflowRun(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    if (!provider.parseWorkflowRunEvent) {
      return { event: 'workflow_run', outcome: 'ignored_action' };
    }
    const run = provider.parseWorkflowRunEvent(body);
    if (!run) return { event: 'workflow_run', outcome: 'ignored_action' };

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'workflow_run', outcome: 'unknown_installation' };

    try {
      const result = await ciMinutesMeterService.meterWorkflowRun(run, installationId);

      // MOTIR-1901 — the ENTITLEMENT half. The metering write has committed, so
      // now decide how many of those minutes were free and charge the rest
      // (`ci-minutes-allowance.md` §4.6: charge INCREMENTALLY at the metering
      // event, against the pool as it stood then, never by re-summing the
      // period). Only a freshly `metered` run reaches it: a `duplicate` was
      // counted once already and every other outcome added no consumption, so
      // the charger has nothing to account for.
      //
      // Best-effort, exactly like the metering call it follows: a charge failure
      // must not fail the delivery. The consumption row is durable either way,
      // and the charger's own watermark means the NEXT metered run for this org
      // accounts for whatever this attempt missed — nothing is lost by acking.
      if (result.outcome === 'metered') {
        try {
          await ciAllowanceService.chargeForMeteredRun({
            organizationId: result.organizationId,
            periodStart: result.periodStart,
          });
        } catch (err) {
          console.error('[githubWebhookService] CI-overage charge failed; delivery acked', {
            runId: run.runId,
            organizationId: result.organizationId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }

        // MOTIR-1907 — the REPOSITORY half. The charge above has committed, so
        // the org's entitlement state is now settled for this run and the
        // repository-side stop can be brought in line with it: at
        // `ci_credits_exhausted`, disable Actions on every repository Motir owns
        // for this org; on any other state, re-enable what this gate disabled.
        //
        // This is the natural trigger because it is the moment the state can
        // CHANGE — an org crosses into exhausted by consuming minutes, and a
        // metered run is exactly that consumption being recorded.
        //
        // Its own try/catch, separate from the charge's, and for a different
        // reason: the two are independent side effects and a failure in either
        // must not suppress the other. Best-effort like everything else on this
        // path (§8.6) — the intent is persisted transactionally inside the gate,
        // so a failure here loses nothing that the next sweep will not finish.
        try {
          await ciActionsGateService.syncForOrganization(result.organizationId);
        } catch (err) {
          console.error('[githubWebhookService] CI-Actions gate failed; delivery acked', {
            runId: run.runId,
            organizationId: result.organizationId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }

      return { event: 'workflow_run', outcome: result.outcome };
    } catch (err) {
      console.error('[githubWebhookService] CI-minutes metering failed; delivery acked', {
        runId: run.runId,
        runAttempt: run.attempt,
        repoOwner: run.repoOwner,
        repoName: run.repoName,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return { event: 'workflow_run', outcome: 'failed' };
    }
  },

  /**
   * Handle a `workflow_job` delivery — the runner FLEET's entry point (Story
   * MOTIR-1916 · MOTIR-1920). Only a `queued` job normalizes: `in_progress`
   * means a runner was already assigned and `completed` means the work is done,
   * so provisioning for either boots a machine nothing will claim.
   *
   * ⚠️ THIS EVENT FIRES FOR GITHUB-HOSTED JOBS TOO — every one of `motir-core`'s
   * own 31 jobs per run among them (`ci-minutes-allowance.md` §J/§O). The
   * decision to provision is made ONLY from the job's requested labels, inside
   * the service, before any DB read; everything else is a deliberate no-op. A
   * handler that acted on event RECEIPT would silently migrate Motir's own
   * release path onto the fleet, which is the outcome §J exists to prevent.
   *
   * ⚠️ IT IS ALSO THE FLEET'S HOT-PATH TRIGGER (MOTIR-1996). A recorded intent
   * dispatches `system.ci-runner-boot` from THIS request, because
   * `ci-runner-fleet.md` §6's p50 ≤ 30s budget cannot survive waiting out the
   * minute-granularity provision sweep. The sweep remains as the recovery path;
   * the two events race and the claim's compare-and-set settles it.
   *
   * Like the meter above, a failure here does not fail the delivery: an ack that
   * 500s makes GitHub retry, and a retry cannot fix a bad DB connection — nor a
   * failed event send. The `(run_id, run_attempt, job_id)` idempotency key means
   * a later redelivery — GitHub's own, or a manual replay — records it exactly
   * once, so dropping this one loses nothing that cannot be recovered.
   */
  async handleWorkflowJob(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    if (!provider.parseWorkflowJobEvent) {
      return { event: 'workflow_job', outcome: 'ignored_action' };
    }
    const job = provider.parseWorkflowJobEvent(body);
    if (!job) return { event: 'workflow_job', outcome: 'ignored_action' };

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'workflow_job', outcome: 'unknown_installation' };

    try {
      const result = await ciRunnerProvisioningService.recordQueuedJob(job, installationId);
      if (result.outcome === 'recorded') {
        // THE HOT PATH (MOTIR-1996). §6 budgets p50 ≤ 30s webhook → job started,
        // so the boot is dispatched HERE rather than waiting out the minute cron.
        // Only `recorded` dispatches: every other outcome either has no intent to
        // boot (`not_fleet_job` / `unattributed` / `unknown_*`) or already has one
        // whose own delivery dispatched for it (`duplicate`).
        //
        // Deliberately AWAITED and deliberately unable to fail the delivery:
        // `dispatchCiRunnerBoot` never throws, so the ack stays fast, stays 200,
        // and the outcome we report is still what the service decided. A dropped
        // dispatch is recovered by the provision sweep within the minute.
        await dispatchCiRunnerBoot(result.intentId);
      }
      return { event: 'workflow_job', outcome: result.outcome };
    } catch (err) {
      console.error('[githubWebhookService] runner-provisioning intent failed; delivery acked', {
        runId: job.runId,
        runAttempt: job.runAttempt,
        jobId: job.jobId,
        repoOwner: job.repoOwner,
        repoName: job.repoName,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return { event: 'workflow_job', outcome: 'failed' };
    }
  },
};

/** Resolve the GitHub connection + repo + checks-URL builder for a CI event — the
 *  provider-specific half the shared CI-feedback consumer needs. Keys on the App
 *  delivery's installation id (as the status/push paths do); the checks link points
 *  at the PR's checks tab on github.com. */
async function resolveGithubCiContext(
  body: Record<string, unknown>,
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<CiFeedbackContextResolution> {
  const installationId = readInstallationId(body);
  if (!installationId) return { kind: 'unknown_installation' };
  const installation = await githubInstallationRepository.findByInstallationId(installationId, tx);
  if (!installation) return { kind: 'unknown_installation' };
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    event.providerRepoId,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  return {
    kind: 'resolved',
    installation,
    repo,
    buildChecksUrl: (number) =>
      `https://github.com/${repo.owner}/${repo.name}/pull/${number}/checks`,
    // MOTIR-4199 — the GitHub half of "how many checks does this commit have?".
    // The consumer calls it only when the recorded set claims to be complete,
    // and reads a `null` as "could not establish", so an unreachable host costs
    // the sharper verdict rather than stalling the card.
    readReportedCheckSet: (commitSha) =>
      readReportedCheckSet({
        installationId: installation.installationId,
        owner: repo.owner,
        name: repo.name,
        commitSha,
      }),
  };
}

/** Reconcile an installation's selected repos from GitHub's authoritative set —
 *  the `installation` (non-delete) + `installation_repositories` path. Only an
 *  ALREADY-bound installation is reconciled (the workspace binding is the connect
 *  flow's job); an unbound delivery is a no-op. Fetches the current repo set
 *  through the seam and hands it to `persistInstallation`.
 *
 *  Returns WHY it did or didn't run, because the three reasons mean different
 *  things operationally (MOTIR-1931): `unbound` is "nobody has connected this
 *  installation yet", `shared` is "this is Motir's own provisioning installation
 *  and reconcile does not apply to it". A shared installation's authoritative
 *  repo set spans EVERY tenant, so reconciling it would delete the repos this
 *  delivery did not fetch and leak the ones it did. */
async function reconcileInstallation(
  installationId: string,
  body: Record<string, unknown>,
): Promise<'synced' | 'skipped_unbound' | 'skipped_shared_installation'> {
  const existing = await withSystemContext((tx) =>
    githubInstallationRepository.findByInstallationId(installationId, tx),
  );
  if (!existing) return 'skipped_unbound';
  // The NULL is the guard, not a flag: `persistInstallation` requires a
  // `workspaceId: string`, so the call below simply cannot be formed for a shared
  // installation — this branch names that fact rather than enforcing it.
  const workspaceId = existing.workspaceId;
  if (workspaceId === null) return 'skipped_shared_installation';

  const account = asRecord(asRecord(body['installation'])?.['account']);
  const repos = await getGitProvider(existing.provider as GitProviderId).fetchInstallationRepos(
    installationId,
  );
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId,
      accountLogin:
        typeof account?.['login'] === 'string' ? account['login'] : existing.accountLogin,
      accountType: typeof account?.['type'] === 'string' ? account['type'] : existing.accountType,
    },
    repos,
  });

  // POST-COMMIT, best-effort: kick off a code-graph index for each repo that has
  // no graph yet (MOTIR-1500; re-gated on indexedness by MOTIR-1961 — an
  // UNCHANGED repo that was never indexed now recovers here, which is what makes
  // "a dropped enqueue self-heals on the next repo-selection change" true).
  // Never blocks or fails the grant mirror.
  await codeGraphIndexService.enqueueFirstIndexForRepos({
    installationId,
    workspaceId,
    repos,
  });
  return 'synced';
}

/**
 * Write the UNLINKED-PULL-REQUEST CHECK for one `pull_request` delivery
 * (Story MOTIR-3672 · MOTIR-3675).
 *
 * Its own action set, deliberately narrower than "everything" and wider than
 * `HANDLED_PR_ACTIONS`:
 *
 *   * `opened` / `reopened` — the pull request appears.
 *   * `synchronize` — a NEW head commit. A check run belongs to a commit, so
 *     without this the check written at `opened` is simply not on the sha GitHub
 *     is showing, which reads to a person as "the check vanished".
 *   * `ready_for_review` — the draft exemption ending.
 *   * `labeled` / `unlabeled` — the `no-work-item` hatch arriving or being taken
 *     away.
 *
 * `closed` is absent on purpose: a closed pull request cannot be linked or merged
 * any further, and writing onto it would be noise on a page nobody acts on.
 *
 * SWALLOWS EVERYTHING. The delivery's load-bearing effect is the status sync; a
 * host that refuses a check must never make GitHub retry a delivery that already
 * moved a card (the same rule the file-listing capture below states).
 */
const LINK_CHECK_PR_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'labeled',
  'unlabeled',
]);

async function writeLinkCheckForDelivery(body: Record<string, unknown>): Promise<void> {
  try {
    if (!LINK_CHECK_PR_ACTIONS.has(String(body['action']))) return;
    const installationId = readInstallationId(body);
    if (!installationId) return;
    const pr = asRecord(body['pull_request']);
    const repoPayload = asRecord(body['repository']);
    const providerRepoId = readId(repoPayload?.['id']);
    const number = typeof pr?.['number'] === 'number' ? pr['number'] : null;
    if (!pr || !providerRepoId || number === null) return;

    const repoRow = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return null;
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        providerRepoId,
        tx,
      );
      return repo ? { ...repo, installation } : null;
    });
    // A repository outside the grant mirror is not Motir's to write on.
    if (!repoRow) return;

    const head = asRecord(pr['head']);
    const author = asRecord(pr['user']);
    const labels = Array.isArray(pr['labels'])
      ? (pr['labels'] as unknown[])
          .map((l) => asRecord(l)?.['name'])
          .filter((n): n is string => typeof n === 'string')
      : [];

    await evaluateLinkCheck({
      repoRow,
      number,
      headSha: typeof head?.['sha'] === 'string' ? head['sha'] : null,
      authorType: typeof author?.['type'] === 'string' ? author['type'] : null,
      draft: pr['draft'] === true,
      labels,
      headRef: typeof head?.['ref'] === 'string' ? head['ref'] : null,
      title: typeof pr['title'] === 'string' ? pr['title'] : null,
    });
  } catch (err) {
    console.error('[githubWebhookService] link check could not be written:', err);
  }
}

/**
 * Capture a pull request's changed paths + merge instant onto its mirror row
 * (MOTIR-2922, widened to OPEN pull requests by MOTIR-3230) — the substrate a
 * subsumption check needs, and the one the mirror has never carried.
 *
 * `readMergedAt` already returns `Date | null` and `MergeCaptureInput.mergedAt`
 * already accepts it, so the open case needs no new shape: an open pull request
 * simply records its paths with a null merge instant, which is exactly what
 * distinguishes the two arms downstream. Nothing about the merged path changes.
 *
 * ⚠️ EVERY failure here is swallowed. This runs after the status sync's
 * transaction has committed, so by `notes.html` #39 (PROD-443) it may not
 * propagate: coupling a committed mutation to a transport call turns a GitHub
 * blip into a 500 the host then redelivers, and redelivery cannot fix a revoked
 * token or an API outage. What is swallowed is TRANSPORT and persistence failure
 * — a payload that does not parse is simply a capture with nothing to record, not
 * an error to hide.
 *
 * A failed fetch still writes the row: `mergedAt` is read from the delivery we
 * are already holding, so the ordering fact survives even when the file list does
 * not, and `changedPaths` is left empty — which is the same "no evidence" state a
 * pre-capture row carries, and correctly stops a consumer concluding anything
 * from the absence of a path.
 *
 * A REDELIVERY re-captures rather than short-circuiting on a row that already has
 * paths, deliberately: the write is idempotent (same merge, same file list), and
 * it is the only thing that ever repairs a capture the first delivery dropped. A
 * "skip if already captured" guard would trade one redundant request for a row
 * that is permanently empty precisely when the first attempt failed.
 *
 * EXPORTED for its own tests, not for a second caller — `handlePullRequest` is
 * the only production entry, and it is the only one that should be. Two of the
 * paths below exist for races the handler cannot stage: a mirror row that
 * vanished between the sync's commit and this write, and a failure escaping the
 * inner fetch guard. Reaching them through a webhook delivery is impossible by
 * construction — the sync upserts the row on the same payload — so testing them
 * at all means calling this directly. (Same reasoning `changeRequestStatusSync`
 * records for exporting `resolveChangeRequestWorkItem`.)
 */
export async function capturePullRequestFiles(
  body: Record<string, unknown>,
  cr: NormalizedChangeRequest,
): Promise<void> {
  try {
    const installationId = readInstallationId(body);
    if (!installationId) return;

    // Re-resolve the connection tier rather than threading it out of the shared
    // sync: that sync is provider-agnostic and GitLab shares it, so widening its
    // return shape for a GitHub-only capture would put GitHub's needs inside the
    // one path that exists to have none. Two indexed reads on a delivery that
    // already made a dozen.
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return null;
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        cr.providerRepoId,
        tx,
      );
      return repo ? { repo } : null;
    });
    if (!resolved) return;

    // The OWNER/NAME come from the mirrored repo row, not the payload: the row is
    // what the tenancy rule already trusts (MOTIR-1931), and it survives a payload
    // shape this handler has never had to parse.
    const { repo } = resolved;
    const mergedAt = readMergedAt(body);

    let files: PullRequestFiles = { paths: [], truncated: false };
    try {
      const { token } = await getGitProvider(PROVIDER).mintInstallationToken(installationId);
      files = await listPullRequestFiles(token, repo.owner, repo.name, cr.number);
    } catch (err) {
      console.error(
        `[githubWebhookService] changed-path capture failed for ${repo.owner}/${repo.name}` +
          `#${cr.number}; the pull request is recorded with no paths:`,
        err,
      );
    }

    await withSystemContext(async (tx) => {
      // Bind the tenant for the same reason the sync does (MOTIR-2880): the write
      // below touches `github_pull_request`, and binding is additive — the system
      // flag stays set, so the row's own arm is unaffected either way.
      await bindWorkspaceContext(tx, repo.workspaceId);
      const touched = await githubPullRequestRepository.recordMergeCapture(
        repo.id,
        cr.number,
        {
          mergedAt,
          changedPaths: files.paths,
          changedPathsTruncated: files.truncated,
        },
        tx,
      );
      if (touched === 0) {
        console.warn(
          `[githubWebhookService] no ${repo.owner}/${repo.name}#${cr.number} row to stamp; ` +
            `the path capture was dropped`,
        );
      }
    });
  } catch (err) {
    console.error(
      `[githubWebhookService] merge capture threw after the status sync committed; ` +
        `the sync's outcome stands:`,
      err,
    );
  }
}

/** The merge INSTANT off the delivery (`pull_request.merged_at`). Null when the
 *  payload omits it or it does not parse — never "now", which would look like a
 *  measurement and be a guess. A null here is the same unknown a pre-capture row
 *  carries, and the accessor's `mergedAt > since` filter excludes it, which is the
 *  correct behaviour for a merge whose time we do not know. */
function readMergedAt(body: Record<string, unknown>): Date | null {
  const raw = asRecord(body['pull_request'])?.['merged_at'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Resolve the GitHub connection + repo + bound author for a change-request event
 *  — the provider-specific half the shared status sync (`changeRequestStatusSync`)
 *  needs. GitHub's App delivery carries its installation id at `installation.id`;
 *  the repo is that installation's selected repo for the payload's numeric repo
 *  id; the author is the PR user's bound Motir member (only when they belong to
 *  the workspace, so the edit gate passes — else null → the owner fallback). */
async function resolveGithubChangeRequestContext(
  body: Record<string, unknown>,
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<ChangeRequestContextResolution> {
  const installationId = readInstallationId(body);
  if (!installationId) return { kind: 'unknown_installation' };
  const installation = await githubInstallationRepository.findByInstallationId(installationId, tx);
  if (!installation) return { kind: 'unknown_installation' };
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    cr.providerRepoId,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  // The REPO row is the tenant (MOTIR-1931) — for the membership lookup here and
  // for everything the shared sync does downstream.
  //
  // ⚠️ BIND IT, don't just PASS it (MOTIR-2910). This comment said "the tenant"
  // and the next line handed `repo.workspaceId` to `resolveBoundMember` as an
  // ARGUMENT, which binds no GUC at all — so the membership read inside it ran
  // under the system flag alone, and `membership_visible_active_or_own` has no
  // `system_admin` arm (`app.workspace_id` OR `app.user_id`, neither set). The
  // read returned null, `resolveBoundMember` returned null, and the documented
  // owner-fallback fired: a member's own PR was attributed in the activity log
  // to the workspace OWNER. Silent, because "this author is not a member" and
  // "I cannot see memberships" are the same null.
  //
  // The bind is ADDITIVE — the system flag stays set, so the connection-tier
  // reads ABOVE this line (`github_installation` / `github_repo`, which is what
  // the enclosing `withSystemContext` is for) are unaffected, and it must come
  // AFTER them: the repo row is where the tenant is learned. `syncChangeRequestStatus`
  // binds the same value again once the resolver returns — same GUC, same value,
  // idempotent — because that caller cannot bind before the resolver hands it a repo.
  await bindWorkspaceContext(tx, repo.workspaceId);
  const authorBoundUserId = await resolveBoundMember(
    readAuthorGithubUserId(body),
    repo.workspaceId,
    tx,
  );
  return { kind: 'resolved', installation, repo, authorBoundUserId };
}

/** The bound Motir user for a GitHub author, ONLY when they are a member of the
 *  target workspace (so `updateStatus`'s edit gate can pass). Null otherwise —
 *  the caller then attributes to the workspace owner. */
async function resolveBoundMember(
  authorGithubUserId: string | null,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (!authorGithubUserId) return null;
  const identity = await githubIdentityRepository.findByGithubUserId(authorGithubUserId, tx);
  if (!identity) return null;
  const membership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
    identity.userId,
    workspaceId,
    tx,
  );
  return membership ? identity.userId : null;
}

// --- payload helpers (defensive reads over the untyped JSON) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A GitHub numeric id as the string the mirror stores it as (MOTIR-711 reads the
 *  transferred repository's own id — the only field that survives a transfer that
 *  also RENAMES, which is why the saga matches on it rather than on the name). */
function readId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

/** GitHub's numeric installation id (as a string — the stored key) from the
 *  top-level `installation` object every App delivery carries. */
function readInstallationId(body: Record<string, unknown>): string | null {
  const id = asRecord(body['installation'])?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}

/** The PR author's numeric GitHub user id (as a string), for actor attribution. */
function readAuthorGithubUserId(body: Record<string, unknown>): string | null {
  const id = asRecord(asRecord(body['pull_request'])?.['user'])?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}
