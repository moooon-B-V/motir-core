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
  RepoFileReadResult,
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
 * Deadline for a repo-tarball URL resolve, in ms (MOTIR-1974). Since both
 * code-graph jobs dispatch containers (MOTIR-2027 / MOTIR-2057) what it bounds
 * is the `redirect: 'manual'` RESOLVE, and since MOTIR-2124 that is the ONLY
 * thing it bounds — the byte-returning sibling it also covered is gone (see
 * {@link resolveRepoTarballUrl}). It must stay under the serve route's
 * `maxDuration`, so a stalled host surfaces as a typed error inside the
 * invocation budget instead of as a `FUNCTION_INVOCATION_TIMEOUT` with no step
 * output. Bounds time-to-response-headers, which is where a dead host hangs.
 */
export const REPO_TARBALL_TIMEOUT_MS = 60_000;

/**
 * Deadline for a single FILE read, in ms (MOTIR-4586). Same job as
 * {@link REPO_TARBALL_TIMEOUT_MS} and deliberately a twelfth of it: that one
 * bounds a resolve on the index path, where a slow answer still beats a failed
 * dispatch; this one bounds a lookup a PLANNING SESSION is waiting on inside a
 * turn, where a minute of silence is worse than a named refusal.
 *
 * It must stay under the reading route's `maxDuration`
 * (`app/api/internal/ai/repo-file/route.ts`), so a dead host surfaces as the
 * `unreachable` result inside the invocation budget rather than as a
 * `FUNCTION_INVOCATION_TIMEOUT` with no body at all — and
 * `tests/git/repoFileRead.test.ts` asserts that ordering rather than leaving it
 * to a comment.
 */
export const REPO_FILE_READ_TIMEOUT_MS = 5_000;

/**
 * The largest file this capability will hand back, in bytes.
 *
 * ⚠️ IT IS THE HOST'S LIMIT, NOT OURS, AND THAT IS WHY IT IS 1 MiB. GitHub's
 * contents endpoint refuses a blob over 1 MB outright, so anything larger is
 * not a policy we could relax by editing this line — it is a fact about the
 * upstream. Naming it here (rather than only catching GitHub's 403) lets GitLab,
 * which has no such refusal, answer the SAME way for the same file, so a session
 * does not learn a different truth about a repository depending on where it is
 * hosted.
 */
export const REPO_FILE_MAX_BYTES = 1024 * 1024;

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

  // ⚠️ `fetchRepoTarball` IS GONE (MOTIR-2124), AND MUST NOT COME BACK. It
  // returned a repo's gzipped-tarball BYTES for the MOTIR-1500 in-process index.
  // MOTIR-2027 / MOTIR-2057 moved BOTH code-graph jobs onto containers that fetch
  // for themselves, which left it with zero production callers — and a required
  // interface method nothing calls is not neutral: it is what made
  // `gitlabProvider` LOOK like a complete provider while the capability the
  // shipped path actually requires ({@link resolveRepoTarballUrl}) was missing,
  // so every GitLab index dead-lettered five times and nothing said why. Removing
  // it makes a provider declare exactly what it can do. Re-adding it would
  // re-create both the disguise and the buffering OOM
  // (`docs/decisions/code-graph-index-fleet.md` §2) in one edit.

  /**
   * Resolve the host's PRE-SIGNED archive URL for a repo at `ref` — **without
   * downloading the body** (MOTIR-1989).
   *
   * ⚠️ OPTIONAL, and for the same structural reason the metering reads below are:
   * a method every host genuinely backs is required here; one only some hosts can
   * back is DECLARED, never mandated. GitHub 302-redirects
   * `/repos/{owner}/{name}/tarball/{ref}` to a `codeload.github.com` URL whose
   * SIGNED QUERY STRING is the whole authorization, so the resolved URL is
   * self-authorizing and single-repo.
   *
   * ⚠️ GITLAB CANNOT BACK THIS, AND THAT WAS MEASURED, NOT ASSUMED (MOTIR-2124).
   * `GET /api/v4/projects/:id/repository/archive` answers **200 with the bytes**
   * (`content-type: application/octet-stream`, `content-disposition: attachment`,
   * NO `location` header) where GitHub answers **302 →
   * `codeload.github.com/…`** — both observed against the live hosts on
   * 2026-08-04. GitLab does accept a token in the QUERY STRING
   * (`?private_token=` / `?access_token=`), so a URL-shaped credential is
   * technically constructible — and it is exactly what this contract forbids
   * below: the token Motir holds is the connection's OAuth token with the **full
   * `api` scope** (`lib/gitlab/gitlabOAuth.ts`, ~2 h), which reaches EVERY project
   * that user can see. Handing that to a container would be strictly MORE
   * privilege than the installation token §10 already refuses to hand over, not
   * less. So GitLab does not implement this, and a stub would model a capability
   * its host does not have. What DOES happen for a GitLab repo is the honest
   * refusal in `codeGraphIndexService.resolveIndexTarget`, which never dispatches
   * a container it knows cannot boot.
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
   * refusal. To ASK whether a host can, without committing to dispatch, use
   * {@link providerSupportsRepoTarballUrl}: it is the same predicate, so a caller
   * that gates on it can never disagree with the boot that throws.
   */
  resolveRepoTarballUrl?(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<string>;

  /**
   * Read ONE file's TEXT at a ref (MOTIR-4586) — the capability a planning
   * session's `read_file` tool is built on.
   *
   * ⚠️ REQUIRED, AND THAT IS THE OPPOSITE OF {@link resolveRepoTarballUrl} ON
   * PURPOSE. That one is optional because GitLab genuinely CANNOT back it: the
   * fleet container holds no credential, so it needs a SELF-AUTHORIZING URL,
   * and GitLab's only URL-shaped credential is the connection's full-`api`
   * OAuth token — strictly more privilege than §10 permits a container to hold.
   * Reading a file has no such constraint, because nothing credential-shaped
   * crosses a boundary at all: the call happens HERE, in the process that
   * already holds the token, and what leaves is text. Both hosts can back it,
   * so both must — declaring it optional would re-create exactly the disguise
   * MOTIR-2124 removed, where a provider looks complete while the capability a
   * consumer requires is missing, and every attempt dead-letters saying nothing.
   *
   * ⚠️ IT RETURNS ITS FAILURES. Every ordinary answer — no such path, no such
   * ref, a file over {@link REPO_FILE_MAX_BYTES}, a credential the host
   * refused, a path the guard rejected, a host that did not answer — is a
   * NAMED member of {@link RepoFileReadResult}, because the consumer is a model
   * deciding what it now knows and "this project has no code" must never be
   * concluded from "that file is not at that path". A `RepoFileReadError`
   * (`lib/git/errors.ts`) is thrown ONLY for a status no arm names.
   *
   * Implementations MUST call `normalizeRepoFilePath` (`lib/git/repoPath.ts`)
   * BEFORE issuing any request, MUST bound the request with
   * {@link REPO_FILE_READ_TIMEOUT_MS}, and MUST NOT put the token — or any URL
   * carrying one — into the result they return.
   *
   * `ref` is required: the caller knows the repository's default branch (it is
   * a stored column) and the provider does not, so defaulting here would mean a
   * second host round-trip to learn something the caller already had.
   */
  readFileAtRef(
    installationId: string,
    owner: string,
    name: string,
    path: string,
    ref: string,
  ): Promise<RepoFileReadResult>;

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
   *
   * ⚠️ `done` here means "the host reports this merged", NOT "the deliverable
   * shipped". The two diverge whenever `baseRef` is not the repository's default
   * branch (MOTIR-1873), and only the consumer can tell — the mirrored default
   * branch is a DB read this pure seam deliberately cannot make. So a provider
   * must never try to gate completion here.
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
  if (!providerSupportsRepoTarballUrl(provider) || !resolve)
    throw new RepoTarballUrlUnsupportedError(provider.id);
  return resolve.bind(provider);
}

/**
 * Can this host hand a token-less container a self-authorizing archive URL — i.e.
 * can a repo on it be indexed on the fleet at all? (MOTIR-2124)
 *
 * ⚠️ THIS IS THE ASKING FORM OF {@link requireRepoTarballUrlResolver}, AND THEY
 * READ THE SAME PROPERTY ON PURPOSE. The refusal that matters is the one at
 * `bootIndexContainer`, which throws; but a throw there is a JOB FAILURE, and a
 * job failure for a host that structurally cannot succeed is five retries, five
 * dead-letters and no explanation — the MOTIR-2124 defect. A caller that wants to
 * decide BEFORE dispatching needs to ask the question without committing to the
 * answer, and the one thing that must never happen is a gate that says "yes"
 * where the boot says "no" (or vice versa). Deriving both from this single
 * predicate makes that disagreement unrepresentable rather than merely unlikely.
 *
 * It is deliberately NOT a `providerId` allow-list: an allow-list is a second
 * copy of the capability that drifts the moment a provider gains or loses the
 * method — which is precisely how the shipped code came to have a fleet path
 * requiring a capability one registered provider never implemented.
 */
export function providerSupportsRepoTarballUrl(provider: GitProvider): boolean {
  return typeof provider.resolveRepoTarballUrl === 'function';
}
