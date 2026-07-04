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

/** A short-lived installation access token, minted on demand and cached
 *  in-memory only — NEVER persisted (the card's hard requirement). */
export interface InstallationToken {
  token: string;
  expiresAt: Date;
}
