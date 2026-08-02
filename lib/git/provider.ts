import type {
  ChangeRequestLifecycle,
  GitProviderId,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedComputeUsageLine,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedStatusEvent,
  NormalizedWorkflowJob,
  NormalizedWorkflowJobEvent,
  NormalizedWorkflowRunEvent,
} from './types';

// The GitProvider seam (Story 7.10 · MOTIR-891). ONE interface every Git host
// implements; consumers dispatch by the stored `provider` discriminator through
// the registry (`lib/git/registry.ts`) and hold NO host-specific types. GitHub
// is the FIRST registered implementation (`lib/git/providers/github.ts`); GitLab
// (7.23) proves additivity by implementing this SAME interface — a new provider
// is exactly "implement this + register it", nothing in the consumers changes.
//
// The interface is defined ALONGSIDE its first implementation (not in a vacuum —
// the MOTIR-1566 planning lesson), so every method here is one GitHub actually
// backs.

/**
 * Deadline for a repo-tarball fetch, in ms (MOTIR-1974). The fetch is the first
 * half of one `system.code-graph-index` step; the motir-ai upload is the second
 * (`MOTIR_AI_INDEX_TIMEOUT_MS`). Their SUM must stay under the serve route's
 * `maxDuration`, so a stalled host surfaces as a typed error inside the
 * invocation budget instead of as a `FUNCTION_INVOCATION_TIMEOUT` with no step
 * output. Bounds time-to-response-headers (which is where a dead host hangs);
 * the body download that follows is the host streaming bytes it already
 * committed to.
 */
export const REPO_TARBALL_TIMEOUT_MS = 60_000;

export interface GitProvider {
  /** The provider discriminator — matches the stored rows' `provider` column. */
  readonly id: GitProviderId;

  /**
   * Mint a short-lived installation access token, scoped by the host to the
   * installation's repos, from the App/OAuth-app credentials. Cached in-memory
   * until near expiry and re-minted; NEVER persisted. `installationId` is the
   * host's own installation id (GitHub's numeric id as a string).
   */
  mintInstallationToken(installationId: string): Promise<InstallationToken>;

  /**
   * Fetch the repositories reachable on an installation, normalized. Uses a
   * freshly-minted (or cached) installation token.
   */
  fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]>;

  /**
   * Fetch a repository's source as the host's raw gzipped-tarball bytes, at the
   * given `ref` (a branch / tag / commit — the repo's default branch for the
   * MOTIR-1500 code-graph index). Uses a freshly-minted (or cached) installation
   * token; the credential + fetch stay in motir-core (the open-core invariant —
   * the raw BYTES cross the motir-ai boundary, never a host token). GitHub returns
   * exactly what its `/tarball` endpoint yields.
   *
   * Implementations MUST bound the request with {@link REPO_TARBALL_TIMEOUT_MS}:
   * this call runs inside a background-job invocation whose platform budget is
   * finite, and a host that never answers must fail as a typed, retryable error
   * rather than by having the invocation killed (MOTIR-1974).
   */
  fetchRepoTarball(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<ArrayBuffer>;

  /**
   * Fetch an installation's account (login + type) from the host, given only the
   * installation id — used to bind a fresh install to a workspace (MOTIR-1588),
   * where the post-install redirect carries only the id (no webhook payload).
   * Uses the App-level credential (GitHub: the App JWT), not an installation
   * token.
   */
  fetchInstallation(installationId: string): Promise<NormalizedInstallation>;

  /**
   * Normalize a raw change-request webhook payload into the provider-agnostic
   * shape, or `null` when the payload is not a change-request event we handle
   * (a different event, or a malformed body).
   */
  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null;

  /**
   * Map a normalized change request to the canonical workflow-lifecycle signal
   * the status sync (MOTIR-892) applies to the linked work item. PURE.
   */
  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle;

  /**
   * Normalize a raw CI / pipeline webhook payload into the provider-agnostic
   * status-event shape, or `null` when it is not one we handle.
   */
  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null;

  /**
   * Normalize a raw push webhook payload into the provider-agnostic push shape,
   * or `null` when it is not a BRANCH push we handle (a tag push, a branch
   * deletion, or a malformed body) — consumed by the code-graph feed
   * (MOTIR-893). PURE.
   */
  parsePushEvent(rawPayload: unknown): NormalizedPushEvent | null;

  // --- CI-minutes metering (Story MOTIR-1775 · MOTIR-1896) -------------------
  //
  // ⚠️ OPTIONAL, and deliberately so. Every method above is one EVERY host
  // backs, because every host has PRs, CI checks and pushes. Billable compute
  // Motir pays for is different: `docs/decisions/ci-minutes-allowance.md` §5.6
  // records that the meter's scope is GitHub-only STRUCTURALLY, not by omission
  // — Motir creates repositories only in its own GitHub org (MOTIR-1779,
  // `POST /orgs/{org}/repos`), while the shipped GitLab provider exists for
  // CONNECT-EXISTING only, i.e. a namespace the user owns and GitLab already
  // bills them for. There is therefore no GitLab compute Motir pays for, and no
  // GitLab read to implement.
  //
  // So these are a CAPABILITY a provider may declare, not a contract every
  // provider must satisfy. Making them required would force `gitlab.ts` to ship
  // stubs modelling a capability its host will never have for Motir — the
  // "define the interface alongside a real implementation" rule this seam was
  // built on, applied to a method that only ONE host genuinely backs. The meter
  // checks for the capability and no-ops without it. If Motir ever decides to
  // create repos on GitLab, §5.6 says that is a new card and an ADR amendment —
  // at which point GitLab implements these and nothing else changes.

  /**
   * Normalize a raw COMPLETED-workflow-run webhook payload into the
   * provider-agnostic shape, or `null` when it is not one we meter (a run that
   * has not completed, a different event, or a malformed body). PURE.
   */
  parseWorkflowRunEvent?(rawPayload: unknown): NormalizedWorkflowRunEvent | null;

  /**
   * Normalize a raw QUEUED-workflow-job webhook payload into the
   * provider-agnostic shape, or `null` when it is not one the fleet provisions
   * for (a non-`queued` action — `in_progress` / `completed` — a different
   * event, or a malformed body). PURE.
   *
   * OPTIONAL for the same structural reason the metering reads above are
   * (§5.6): Motir creates repositories only in its own GitHub org, so there is
   * no GitLab job the fleet would ever boot a runner for.
   */
  parseWorkflowJobEvent?(rawPayload: unknown): NormalizedWorkflowJobEvent | null;

  /**
   * Fetch the JOBS of one completed workflow run, normalized. The meter bills
   * per job rounded up (§5.8), so this — not the run's own wall clock — is the
   * unit it reads. Uses a freshly-minted (or cached) installation token.
   */
  fetchWorkflowRunJobs?(
    installationId: string,
    owner: string,
    name: string,
    runId: string,
    attempt: number,
  ): Promise<NormalizedWorkflowJob[]>;

  /**
   * Fetch an ORG's compute-usage report lines for a period — the monthly
   * RECONCILIATION source (§5.8), never the operational meter. Uses the
   * org-level billing credential, NOT an installation token (an installation
   * token cannot read org billing).
   */
  fetchOrgComputeUsage?(
    org: string,
    year: number,
    month: number,
    token: string,
  ): Promise<NormalizedComputeUsageLine[]>;
}
