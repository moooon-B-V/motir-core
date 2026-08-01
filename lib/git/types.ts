// Provider-agnostic normalized shapes for the Git integration seam (Story 7.10 ·
// MOTIR-891). Every downstream reader — the status sync (MOTIR-892), the
// code-graph feed (MOTIR-893), the CI feedback loop (MOTIR-894) — consumes THESE
// shapes through the `GitProvider` interface, never a GitHub-specific type, so
// adding GitLab/Bitbucket (7.23) is purely additive: implement the interface and
// normalize the host's payloads into these.

/** The registered provider ids — the `provider` discriminator carried by the
 *  stored `Github*` rows. A GitLab impl (7.23) registers under `'gitlab'`. */
export type GitProviderId = 'github' | 'gitlab';

/** A repository, normalized across providers. `providerRepoId` is the host's own
 *  stable numeric id (as a string — never do math on it). */
export interface NormalizedRepo {
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

/** An App installation's account, normalized across providers — the identity the
 *  installation belongs to (a GitHub org/user, a GitLab group). Fetched by
 *  `GitProvider.fetchInstallation` when binding a fresh install to a workspace
 *  (MOTIR-1588), where only the host installation id is known. */
export interface NormalizedInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** A branch, normalized across providers. */
export interface NormalizedBranch {
  name: string;
  commitSha: string;
}

/** A change request's lifecycle state — a PR (GitHub) or MR (GitLab). `merged`
 *  is ORTHOGONAL: a closed-merged and a closed-unmerged change request are both
 *  `state: 'closed'`, distinguished by the `merged` flag. */
export type ChangeRequestState = 'open' | 'closed';

/** A change request (pull / merge request), normalized across providers. Carries
 *  no Motir-side link — the consumer resolves the work item from `headRef`. */
export interface NormalizedChangeRequest {
  providerRepoId: string;
  number: number;
  state: ChangeRequestState;
  merged: boolean;
  headRef: string;
  title: string | null;
}

/** The canonical, provider-agnostic lifecycle signal a change request maps to —
 *  consumed by the status sync (MOTIR-892) to drive the linked work item's
 *  `workflow_status`. Opened → in review; merged → done; closed-unmerged → back
 *  to todo (the work did NOT complete). The concrete project workflow status is
 *  the consumer's concern; the provider only emits this canonical signal. */
export type ChangeRequestLifecycle = 'in_review' | 'done' | 'todo';

/** A CI / pipeline conclusion, normalized across providers. */
export type CiConclusion = 'success' | 'failure' | 'pending' | 'neutral';

/** A CI / pipeline status event, normalized across providers — consumed by the
 *  CI feedback loop (MOTIR-894). `prNumbers` are the host PR/MR numbers the event
 *  is associated with (the check payload's `pull_requests[].number`) — the
 *  STRONGEST link back to the stored change request; `headBranch` is the branch
 *  the checks ran on, the fallback resolver when the payload carries no PR list
 *  (both are stable across a re-push, unlike a head SHA). `commitSha` is the head
 *  commit the checks ran on, part of the idempotency key. `context` names the
 *  check (a `check_run.name`, a `check_suite` app slug, a commit-status context). */
export interface NormalizedStatusEvent {
  providerRepoId: string;
  commitSha: string;
  conclusion: CiConclusion;
  context: string;
  prNumbers: number[];
  headBranch: string | null;
}

/** A push to a repository branch, normalized across providers — consumed by the
 *  code-graph feed (MOTIR-893) to refresh a connected repo's graph when its
 *  default branch moves. `branch` is the SHORT branch name (a tag / non-branch
 *  push does not normalize — the parser returns null for it); `headSha` is the
 *  post-push head commit when the payload carries one. */
export interface NormalizedPushEvent {
  providerRepoId: string;
  branch: string;
  headSha: string | null;
}

/** A completed CI workflow run, normalized across providers — consumed by the
 *  CI-minutes meter (Story MOTIR-1775 · MOTIR-1896). DISTINCT from
 *  `NormalizedStatusEvent`, which is the *verification* signal (did CI pass?)
 *  and deliberately carries no timing: this one is the *billing* signal (how
 *  much compute did it consume, and who owns the repo that pays for it?).
 *
 *  `repoOwner` is read from the RUN's own payload rather than the stored mirror
 *  — `docs/decisions/ci-minutes-allowance.md` §5.5: the owner login is what
 *  GitHub bills on and what flips at a repo transfer, while the mirror row can
 *  be briefly stale. `attempt` is part of the idempotency key because a RE-RUN
 *  is a new attempt that bills again (§5.8). */
export interface NormalizedWorkflowRunEvent {
  providerRepoId: string;
  /** The host's own workflow-run id (as a string — never do math on it). */
  runId: string;
  /** The run attempt; a re-run increments it and bills again. */
  attempt: number;
  repoOwner: string;
  repoName: string;
  /** The workflow's display name, for the audit trail. */
  workflowName: string | null;
  /** When the run completed — the period key (§4.5) AND the effective-date the
   *  runner rates resolve at (§3.3). */
  completedAt: Date;
}

/** A QUEUED CI job, normalized across providers — consumed by the runner-fleet
 *  provisioning path (Story MOTIR-1916 · MOTIR-1920). DISTINCT from
 *  `NormalizedWorkflowRunEvent`, which is the *billing* signal read at run
 *  COMPLETION: this one is the *provisioning* signal read at job QUEUE time,
 *  i.e. the moment a machine is needed and none exists yet.
 *
 *  `requestedLabels` is the load-bearing field and the ONLY thing the fleet
 *  scopes on (`ci-minutes-allowance.md` §O): the `workflow_job` `queued` event
 *  fires for GitHub-hosted jobs too, so a listener that reacts to event RECEIPT
 *  would pull Motir's own CI onto the fleet. `jobId` joins `(runId, runAttempt)`
 *  in the idempotency key because one run attempt queues MANY jobs, each needing
 *  its own ephemeral runner — the run-level key the meter uses would collapse a
 *  31-job matrix into a single intent. */
export interface NormalizedWorkflowJobEvent {
  providerRepoId: string;
  /** The host's own workflow-run id (as a string — never do math on it). */
  runId: string;
  /** The run attempt; a re-run increments it and legitimately needs new runners. */
  runAttempt: number;
  /** The host's own job id — unique within the run attempt. */
  jobId: string;
  jobName: string | null;
  workflowName: string | null;
  repoOwner: string;
  repoName: string;
  /** The labels the job's `runs-on` REQUESTED. At `queued` no runner has been
   *  assigned yet, so this can only be the requested set — see the note on
   *  GitHub's `parseWorkflowJobEvent`. */
  requestedLabels: string[];
  /** When the job entered the queue — the age a stuck intent is measured from. */
  queuedAt: Date;
}

/** One job of a completed workflow run, normalized across providers. The meter
 *  bills PER JOB, rounded up (§5.8), so this is the unit it reads — not the run
 *  as a whole, whose wall clock would undercount parallel jobs. */
export interface NormalizedWorkflowJob {
  id: string;
  name: string;
  startedAt: Date | null;
  completedAt: Date | null;
  /** The runner labels the host reports (`["ubuntu-latest"]`) — what the
   *  cost-normalization multiplier is resolved from. */
  labels: string[];
}

/** One line of a host's billing usage report, normalized — the MONTHLY
 *  RECONCILIATION source (§5.8). GitHub's per-run `/timing` endpoint and its
 *  product-specific billing API are both closing down, so the audit path is the
 *  enhanced-billing usage endpoint, which is summarised by SKU/repo/day and
 *  carries no per-run detail. That is enough to reconcile, never enough to
 *  meter — which is why the webhook path is the operational meter. */
export interface NormalizedComputeUsageLine {
  /** The repository the minutes were consumed by, as the host reports it. */
  repositoryName: string;
  /** The host's SKU label (e.g. "Actions Linux") — the runner family hint. */
  sku: string;
  /** Quantity in the host's own unit (minutes for Actions SKUs). */
  quantity: number;
  unitType: string;
  /** The usage day, as reported. */
  date: string;
}

/** A short-lived installation access token, minted on demand and cached
 *  in-memory only — NEVER persisted (the card's hard requirement). */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
}
