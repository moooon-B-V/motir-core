import { RepoTarballUrlUnsupportedError } from './errors';
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
 * Deadline for a repo-tarball fetch or URL resolve, in ms (MOTIR-1974). Since
 * both code-graph jobs dispatch containers (MOTIR-2027 / MOTIR-2057) what it
 * bounds in-function is the `redirect: 'manual'` RESOLVE, not a byte download;
 * `gitlabProvider.fetchRepoTarball` is its remaining buffering caller. It must
 * stay under the serve route's `maxDuration`, so a stalled host surfaces as a
 * typed error inside the invocation budget instead of as a
 * `FUNCTION_INVOCATION_TIMEOUT` with no step output. Bounds
 * time-to-response-headers (which is where a dead host hangs);
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
   * Resolve the host's PRE-SIGNED archive URL for a repo at `ref` — **without
   * downloading the body** (MOTIR-1989).
   *
   * ⚠️ OPTIONAL, and for the same structural reason the metering reads below are:
   * a method every host genuinely backs is required here; one only some hosts can
   * back is DECLARED, never mandated. GitHub 302-redirects
   * `/repos/{owner}/{name}/tarball/{ref}` to a `codeload.github.com` URL whose
   * SIGNED QUERY STRING is the whole authorization, so the resolved URL is
   * self-authorizing and single-repo. GitLab's archive endpoint streams the bytes
   * against a `PRIVATE-TOKEN` header instead — there is no self-authorizing URL to
   * hand out, so it does not implement this, and a stub would model a capability
   * its host does not have.
   *
   * ⚠️ WHAT THIS IS FOR, so the contract is not weakened by accident. The resolved
   * URL is handed to a fleet CONTAINER that holds no GitHub credential at all
   * (`docs/decisions/code-graph-index-fleet.md` §10). Handing over the URL leaks
   * nothing and is strictly LESS privilege than an installation token, which would
   * grant repo-wide API access for its lifetime — but that is true only because the
   * URL is short-lived and scoped to one repo. An implementation that returned a
   * long-lived or org-wide URL, or that appended a token to it, would break the
   * decision this capability exists to satisfy.
   *
   * Implementations MUST bound the request with {@link REPO_TARBALL_TIMEOUT_MS},
   * MUST NOT read the response body, and MUST throw a typed `RepoTarballUrlError`
   * (`lib/git/errors.ts`) rather than returning an empty or partial URL: a falsy
   * URL would reach a container spec and fail there, blaming the repo for a defect
   * in the dispatcher.
   *
   * Resolve it through {@link requireRepoTarballUrlResolver}, never by reading this
   * property directly — that helper is what turns "this host cannot" into a loud
   * refusal instead of a silent fallback to {@link GitProvider.fetchRepoTarball}.
   */
  resolveRepoTarballUrl?(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<string>;

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

/** What {@link requireRepoTarballUrlResolver} hands back — the capability, bound
 *  to its provider, with the optionality already discharged. */
export type RepoTarballUrlResolver = (
  installationId: string,
  owner: string,
  name: string,
  ref: string,
) => Promise<string>;

/**
 * The provider's tarball-URL resolver, or a LOUD refusal (MOTIR-1989).
 *
 * ⚠️ THIS FUNCTION IS THE POINT OF MAKING THE CAPABILITY OPTIONAL. An optional
 * method invites `provider.resolveRepoTarballUrl?.(…) ?? somethingElse`, and the
 * `somethingElse` a caller reaches for is `fetchRepoTarball` — which buffers a
 * whole repo into the function's heap, i.e. exactly the OOM
 * (`docs/decisions/code-graph-index-fleet.md` §2: `motir-core`, 5/5 attempts) that
 * moving indexing onto containers exists to remove. So there is one way to reach
 * the capability and it either returns it or throws.
 *
 * It mirrors `projectRunnerGroupService.requireRunnerGroupId` and
 * `getOrchestrator()`: a nullable return invites a lenient fallback at the call
 * site, and the lenient fallback here is silently doing the expensive, failing
 * thing while reporting success.
 */
export function requireRepoTarballUrlResolver(provider: GitProvider): RepoTarballUrlResolver {
  const resolve = provider.resolveRepoTarballUrl;
  if (!resolve) throw new RepoTarballUrlUnsupportedError(provider.id);
  return resolve.bind(provider);
}
