import type { NormalizedChangeRequest } from '@/lib/git/types';

// Historical pull-request READ leaf (MOTIR-1965) — paginate a repository's
// CLOSED pull requests off the REST API with an installation token, normalized
// into the SAME `NormalizedChangeRequest` the webhook path produces.
//
// Why this exists: the PR mirror shipped at MOTIR-891, so a repository carries
// `github_pull_request` rows only for deliveries received AFTER the App was
// installed on it. Every PR merged before that instant is invisible to the
// database, which is why ~1100 done `coding_agent` items have no implementation
// provenance — `classifyImplementationSource` reads `hasLinkedPr` and correctly
// abstains when the evidence is simply absent. This leaf supplies the missing
// evidence by READING it back from the host, rather than by loosening the rule.
//
// Why a `lib/github/` leaf and NOT a new `GitProvider` method: the seam's own
// contract (lib/git/provider.ts) is that a method every host genuinely backs is
// REQUIRED there, and one only some hosts back is DECLARED optional. Neither
// fits — GitLab backs merge-request listing perfectly well, so an optional
// method would model a limitation GitLab does not have, while a required one
// would mandate a GitLab implementation for a GitHub-history repair that has no
// GitLab counterpart to run against (the workspace's GitLab connections, if any,
// postdate their mirror). So this joins the existing GitHub-specific read leaves
// — `codeScanning.ts`, `repoCollaborators.ts`, `userOrgs.ts` — which are exactly
// the same shape: an authenticated REST read that services compose, off the seam.
//
// ⚠️ CLOSED-AND-MERGED ONLY, and that is a correctness decision, not a
// narrowing for convenience. See {@link listMergedPullRequests}.

const GITHUB_API = 'https://api.github.com';

/** Per-request deadline. Generous relative to the sibling read leaves because
 *  this one runs from an operator CLI, not a request handler — nothing upstream
 *  is holding a connection open — but still bounded so a wedged host surfaces as
 *  an error inside a resumable run instead of hanging it forever. */
const GITHUB_TIMEOUT_MS = 30_000;

/** GitHub's maximum, and the right value: this walks whole PR histories, so
 *  every halving of the page size doubles the request count against the same
 *  rate limit. */
const PER_PAGE = 100;

/** Pages walked before the leaf gives up on one repository and REPORTS that it
 *  truncated. 500 pages × 100 = 50 000 closed PRs, an order of magnitude past
 *  anything in this workspace. A bound is required because a host bug that keeps
 *  returning a full page would otherwise loop forever inside an operator script;
 *  reporting the truncation (rather than silently stopping) is what keeps the
 *  "no silent caps" rule — a run that hit this says so. */
export const MAX_PULL_REQUEST_PAGES = 500;

/** Attempts per page before the error propagates — the initial try plus retries
 *  for a rate-limited or transiently-failed response. */
const MAX_ATTEMPTS = 5;

/** Ceiling on ONE rate-limit sleep. GitHub's primary-limit reset can be up to an
 *  hour away; waiting that long inside a single page fetch would look like a
 *  hang. Capped, then retried — with the attempt budget above, a genuinely
 *  exhausted primary limit ends the run with a clear error and the operator
 *  re-runs later (the script is idempotent, so a re-run resumes). */
const MAX_BACKOFF_MS = 60_000;

/** The floor between retries, doubled per attempt. */
const BASE_BACKOFF_MS = 1_000;

/** A merged historical pull request: the provider-agnostic change request the
 *  shared resolver + mirror consume, plus the host timestamps a caller may want
 *  for reporting. `mergedAt` is never null here — the listing yields only merged
 *  PRs — and is deliberately NOT written to the mirror row (see the service). */
export interface HistoricalPullRequest {
  changeRequest: NormalizedChangeRequest;
  mergedAt: Date;
}

/** One page of results plus whether the walk should continue. */
export interface HistoricalPullRequestPage {
  /** The MERGED pull requests on this page, in host order. */
  merged: HistoricalPullRequest[];
  /** Every closed PR the page carried, merged or not — the "scanned" count. */
  scanned: number;
  /** 1-based page number, so a caller's progress log is resumable by hand. */
  page: number;
}

/** Raised when a repository's PR history cannot be read at all — a revoked
 *  token, a deleted repo, an exhausted rate limit that outlasted the retries.
 *  Carries the repo so an operator sweep can report it and move to the next one
 *  rather than aborting the whole run. */
export class HistoricalPullRequestReadError extends Error {
  readonly code = 'HISTORICAL_PR_READ_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Could not read ${repoRef} pull requests${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'HistoricalPullRequestReadError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalize one row off `GET /repos/{owner}/{name}/pulls` into the SAME shape
 * `githubProvider.parseChangeRequest` produces from a `pull_request` webhook
 * payload. The two endpoints return the same `pull_request` object, so this is a
 * re-read of identical fields — which is precisely what makes a backfilled row
 * indistinguishable from a live-ingested one.
 *
 * Returns null when a required field is missing, exactly as the webhook parser
 * does: a payload that does not normalize is skipped, never defaulted to a guess.
 */
export function normalizeHistoricalPullRequest(
  raw: unknown,
  providerRepoId: string,
): HistoricalPullRequest | null {
  const pr = asRecord(raw);
  if (!pr) return null;

  const number = typeof pr['number'] === 'number' ? pr['number'] : null;
  const headRef = readString(asRecord(pr['head'])?.['ref']);
  const baseRef = readString(asRecord(pr['base'])?.['ref']);
  if (number === null || !headRef || !baseRef) return null;

  // The list endpoint carries NO `merged` boolean (only the single-PR read
  // does) — `merged_at` is the field that distinguishes a merged close from an
  // abandoned one here, and it is the same instant `pull_request.merged` is
  // derived from. A closed-unmerged PR has it null.
  const mergedAtRaw = readString(pr['merged_at']);
  if (!mergedAtRaw) return null;
  const mergedAt = new Date(mergedAtRaw);
  if (Number.isNaN(mergedAt.getTime())) return null;

  return {
    changeRequest: {
      providerRepoId,
      number,
      // A merged PR is always closed. Stated as a literal rather than read from
      // `state` so the mirror can never receive an `open` row from this path —
      // the MOTIR-1604 completion gate counts a work item's OPEN linked change
      // requests, and a backfilled `open` row would defer a future real merge on
      // the strength of history.
      state: 'closed',
      merged: true,
      headRef,
      baseRef,
      title: readString(pr['title']),
    },
    mergedAt,
  };
}

/** Sleep, bounded by {@link MAX_BACKOFF_MS}. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_BACKOFF_MS)));
}

/**
 * How long to wait before retrying a response, or null when the response is not
 * retryable.
 *
 * GitHub signals throttling three ways and this checks all three, because they
 * do not co-occur: a SECONDARY limit sends `retry-after` (seconds) on a 403; a
 * PRIMARY limit sends `x-ratelimit-remaining: 0` plus `x-ratelimit-reset` (unix
 * seconds) on a 403 or 429; and a bare 429 may carry neither. A 5xx is retried
 * on plain exponential backoff. Anything else — 401, 404, 422 — is a real
 * failure the caller must see, so it returns null.
 */
export function retryDelayMs(
  status: number,
  headers: { get(name: string): string | null },
  attempt: number,
  nowMs: number,
): number | null {
  const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);

  if (status === 403 || status === 429) {
    const retryAfter = Number(headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;

    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (remaining === 0 && Number.isFinite(reset) && reset > 0) {
      // `reset` is unix SECONDS. A reset already in the past still gets the
      // backoff floor rather than 0, so a clock skew cannot spin the retry loop.
      return Math.max(reset * 1_000 - nowMs, backoff);
    }
    // A 403 with no throttling signal is an ACCESS failure (the installation
    // lost the repo), not a rate limit — do not retry it.
    return status === 429 ? backoff : null;
  }

  if (status >= 500) return backoff;
  return null;
}

async function fetchPage(
  token: string,
  owner: string,
  name: string,
  page: number,
): Promise<unknown[]> {
  const repoRef = `${owner}/${name}`;
  // `state=closed` — a merged PR is always closed, so this halves the scan
  // against the same rate limit versus `state=all`. `sort=created&direction=asc`
  // pins the walk to a stable order: PR creation order never changes, whereas
  // the default `sort=created&direction=desc` combined with a PR closed mid-walk
  // can shift rows across page boundaries and skip one.
  const url =
    `${GITHUB_API}/repos/${owner}/${name}/pulls` +
    `?state=closed&sort=created&direction=asc&per_page=${PER_PAGE}&page=${page}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'motir',
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (err) {
      // Network / timeout: retryable on the same budget as a 5xx.
      if (attempt === MAX_ATTEMPTS)
        throw new HistoricalPullRequestReadError(
          repoRef,
          null,
          err instanceof Error ? err.message : 'unreachable',
        );
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (!Array.isArray(body))
        throw new HistoricalPullRequestReadError(repoRef, res.status, 'expected a JSON array');
      return body;
    }

    const delay = retryDelayMs(res.status, res.headers, attempt, Date.now());
    if (delay === null || attempt === MAX_ATTEMPTS)
      throw new HistoricalPullRequestReadError(
        repoRef,
        res.status,
        delay === null ? 'not retryable' : 'still throttled after the retry budget',
      );
    await sleep(delay);
  }

  // Unreachable: the loop either returns or throws on its last attempt.
  throw new HistoricalPullRequestReadError(repoRef, null, 'retry loop exhausted');
}

/**
 * Walk a repository's MERGED pull requests, newest page last, yielding one page
 * at a time.
 *
 * ⚠️ MERGED ONLY — the decision the card left open, resolved against the
 * classifier as it actually ships. `classifyImplementationSource` stamps `byok`
 * on `row.hasLinkedPr`, and `hasLinkedPr` is `githubPullRequests.length > 0`
 * (workItemsService) — it does NOT read `merged`. So the card's alternative
 * ("mirror both and let the classifier keep gating on the merged state") rests
 * on a gate that does not exist: mirroring closed-unmerged PRs would stamp
 * `byok` on items whose only PR was ABANDONED, which is exactly the false claim
 * the whole backfill refuses to make. Filtering at the source is also the only
 * option that needs no change to MOTIR-1758's decision table.
 *
 * A generator, not an array: a page is committed as it arrives, so a run
 * interrupted at page 40 keeps the first 39 pages' rows and the (idempotent)
 * re-run resumes from there instead of starting over.
 */
export async function* listMergedPullRequests(
  token: string,
  owner: string,
  name: string,
  providerRepoId: string,
): AsyncGenerator<HistoricalPullRequestPage & { truncated: boolean }> {
  for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
    const rows = await fetchPage(token, owner, name, page);
    const merged: HistoricalPullRequest[] = [];
    for (const row of rows) {
      const pr = normalizeHistoricalPullRequest(row, providerRepoId);
      if (pr) merged.push(pr);
    }
    const last = rows.length < PER_PAGE;
    yield {
      merged,
      scanned: rows.length,
      page,
      truncated: !last && page === MAX_PULL_REQUEST_PAGES,
    };
    if (last) return;
  }
}
