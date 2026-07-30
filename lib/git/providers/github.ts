import { registerGitProvider } from '../registry';
import { createAppJwt, mintInstallationToken } from '@/lib/github/appAuth';
import type { GitProvider } from '../provider';
import type {
  ChangeRequestLifecycle,
  CiConclusion,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedComputeUsageLine,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedStatusEvent,
  NormalizedWorkflowJob,
  NormalizedWorkflowRunEvent,
} from '../types';

// The GitHub implementation of the GitProvider seam (Story 7.10 · MOTIR-891) —
// the FIRST registered provider. It normalizes GitHub's `pull_request` and
// `check_run` / commit-`status` webhook payloads into the provider-agnostic
// shapes, mints installation tokens via the `appAuth` leaf, and fetches repos
// via the REST API with a freshly-minted token. Consumers (MOTIR-892/893/894) go
// through the `GitProvider` interface and hold no GitHub types; GitLab (7.23)
// implements this SAME interface, which is what makes it additive.

const GITHUB_API = 'https://api.github.com';

/** Narrow an `unknown` to a plain object without asserting `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The GitHub numeric id (repo / installation) as our string form, or null. */
function idToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** Normalize one repository object from the `/installation/repositories` list. */
function normalizeRepo(value: unknown): NormalizedRepo | null {
  const repo = asRecord(value);
  if (!repo) return null;
  const providerRepoId = idToString(repo['id']);
  const fullName = typeof repo['full_name'] === 'string' ? repo['full_name'] : null;
  const name = typeof repo['name'] === 'string' ? repo['name'] : null;
  const ownerLogin = idToString(asRecord(repo['owner'])?.['login']);
  // `owner` comes from either the nested owner.login or the `full_name` prefix.
  const owner = ownerLogin ?? (fullName ? (fullName.split('/')[0] ?? null) : null);
  const defaultBranch =
    typeof repo['default_branch'] === 'string' ? repo['default_branch'] : 'main';
  if (!providerRepoId || !name || !owner) return null;
  return { providerRepoId, owner, name, defaultBranch };
}

/** Map a GitHub `check_run.conclusion` (or commit-status state) to ours. */
function mapConclusion(raw: string): CiConclusion {
  switch (raw) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'neutral'; // neutral / skipped / stale / anything unrecognised
  }
}

export const githubProvider: GitProvider = {
  id: 'github',

  mintInstallationToken(installationId: string): Promise<InstallationToken> {
    return mintInstallationToken(installationId);
  },

  async fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]> {
    const { token } = await mintInstallationToken(installationId);
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub repositories endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub repositories endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const list = Array.isArray(body?.['repositories']) ? (body!['repositories'] as unknown[]) : [];
    return list.map(normalizeRepo).filter((repo): repo is NormalizedRepo => repo !== null);
  },

  async fetchRepoTarball(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<ArrayBuffer> {
    const { token } = await mintInstallationToken(installationId);
    let res: Response;
    try {
      // GitHub 302-redirects `/tarball` to a PRE-SIGNED codeload.github.com URL.
      // `fetch` follows the redirect and (per the fetch spec) STRIPS the
      // `Authorization` header on the cross-origin hop — which is fine: the
      // codeload URL is already authorized by its signed query string, so the
      // token is only needed on the first (api.github.com) hop.
      res = await fetch(`${GITHUB_API}/repos/${owner}/${name}/tarball/${ref}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub tarball endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub tarball endpoint returned ${res.status}`);
    return res.arrayBuffer();
  },

  async fetchInstallation(installationId: string): Promise<NormalizedInstallation> {
    // GET /app/installations/{id} is an APP-level read (the App JWT), not an
    // installation token — it returns the account the App is installed on.
    const jwt = createAppJwt();
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub installation endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub installation endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const account = asRecord(body?.['account']);
    const accountLogin = typeof account?.['login'] === 'string' ? account['login'] : '';
    const accountType = typeof account?.['type'] === 'string' ? account['type'] : 'Organization';
    if (!accountLogin) throw new Error('GitHub installation endpoint returned no account login');
    return { installationId, accountLogin, accountType };
  },

  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const pr = asRecord(payload['pull_request']);
    const repo = asRecord(payload['repository']);
    if (!pr || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const number = typeof pr['number'] === 'number' ? pr['number'] : null;
    const head = asRecord(pr['head']);
    const headRef = typeof head?.['ref'] === 'string' ? head['ref'] : null;
    if (!providerRepoId || number === null || !headRef) return null;

    return {
      providerRepoId,
      number,
      state: pr['state'] === 'closed' ? 'closed' : 'open',
      merged: pr['merged'] === true,
      headRef,
      title: typeof pr['title'] === 'string' ? pr['title'] : null,
    };
  },

  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle {
    if (cr.merged) return 'done';
    if (cr.state === 'closed') return 'todo'; // closed WITHOUT merging — not done
    return 'in_review'; // open
  },

  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    if (!providerRepoId) return null;

    // Modern `check_run` event: a not-yet-completed run is `pending`. The
    // associated PRs sit on `check_run.pull_requests`; the branch on the nested
    // `check_run.check_suite.head_branch`.
    const checkRun = asRecord(payload['check_run']);
    if (checkRun) {
      const commitSha = typeof checkRun['head_sha'] === 'string' ? checkRun['head_sha'] : null;
      if (!commitSha) return null;
      const status = typeof checkRun['status'] === 'string' ? checkRun['status'] : null;
      const conclusion = typeof checkRun['conclusion'] === 'string' ? checkRun['conclusion'] : null;
      return {
        providerRepoId,
        commitSha,
        conclusion: status !== 'completed' ? 'pending' : mapConclusion(conclusion ?? 'neutral'),
        context: typeof checkRun['name'] === 'string' ? checkRun['name'] : 'check',
        prNumbers: readPrNumbers(checkRun['pull_requests']),
        headBranch: readHeadBranch(asRecord(checkRun['check_suite'])),
      };
    }

    // `check_suite` event: the AGGREGATE conclusion GitHub rolls all a commit's
    // check_runs into. A not-yet-completed suite is `pending`. The branch + the
    // associated PRs sit directly on `check_suite`; `context` is the App slug so
    // two Apps' suites keep distinct feedback.
    const checkSuite = asRecord(payload['check_suite']);
    if (checkSuite) {
      const commitSha = typeof checkSuite['head_sha'] === 'string' ? checkSuite['head_sha'] : null;
      if (!commitSha) return null;
      const status = typeof checkSuite['status'] === 'string' ? checkSuite['status'] : null;
      const conclusion =
        typeof checkSuite['conclusion'] === 'string' ? checkSuite['conclusion'] : null;
      const appSlug = asRecord(checkSuite['app'])?.['slug'];
      return {
        providerRepoId,
        commitSha,
        conclusion: status !== 'completed' ? 'pending' : mapConclusion(conclusion ?? 'neutral'),
        context: typeof appSlug === 'string' && appSlug.length > 0 ? appSlug : 'check_suite',
        prNumbers: readPrNumbers(checkSuite['pull_requests']),
        headBranch: readHeadBranch(checkSuite),
      };
    }

    // Legacy commit-`status` event: { sha, state, context } — no PR list / branch.
    const sha = typeof payload['sha'] === 'string' ? payload['sha'] : null;
    const state = typeof payload['state'] === 'string' ? payload['state'] : null;
    if (sha && state) {
      return {
        providerRepoId,
        commitSha: sha,
        conclusion: mapConclusion(state),
        context: typeof payload['context'] === 'string' ? payload['context'] : 'status',
        prNumbers: [],
        headBranch: null,
      };
    }

    return null;
  },

  parsePushEvent(rawPayload: unknown): NormalizedPushEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    const providerRepoId = idToString(asRecord(payload['repository'])?.['id']);
    if (!providerRepoId) return null;

    // Only a BRANCH push refreshes the graph: `ref` is `refs/heads/<branch>` for
    // a branch, `refs/tags/<tag>` for a tag; a branch DELETION carries
    // `deleted: true` (nothing to index at a removed ref).
    const ref = typeof payload['ref'] === 'string' ? payload['ref'] : null;
    if (!ref || !ref.startsWith('refs/heads/') || payload['deleted'] === true) return null;
    const branch = ref.slice('refs/heads/'.length);
    if (branch.length === 0) return null;

    const after = payload['after'];
    return {
      providerRepoId,
      branch,
      headSha: typeof after === 'string' && after.length > 0 ? after : null,
    };
  },

  // --- CI-minutes metering (Story MOTIR-1775 · MOTIR-1896) -------------------
  // GitHub is the only provider that implements these; see the capability note
  // on the `GitProvider` interface and `ci-minutes-allowance.md` §5.6.

  parseWorkflowRunEvent(rawPayload: unknown): NormalizedWorkflowRunEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload) return null;
    // Only a COMPLETED run is metered (§5.7 — the predicate is evaluated at run
    // completion, which is what makes the transfer edge need no special case).
    // `requested` / `in_progress` deliveries carry no billable duration.
    if (payload['action'] !== 'completed') return null;

    const run = asRecord(payload['workflow_run']);
    const repo = asRecord(payload['repository']);
    if (!run || !repo) return null;

    const providerRepoId = idToString(repo['id']);
    const runId = idToString(run['id']);
    // The repo OWNER comes from the run delivery's own `repository.owner.login`
    // — §5.5: never the stored mirror, which can hold a pre-transfer owner.
    const repoOwner =
      typeof asRecord(repo['owner'])?.['login'] === 'string'
        ? (asRecord(repo['owner'])!['login'] as string)
        : null;
    const repoName = typeof repo['name'] === 'string' ? repo['name'] : null;
    if (!providerRepoId || !runId || !repoOwner || !repoName) return null;

    // `run_attempt` is part of the idempotency key: a re-run is a NEW attempt
    // that GitHub bills again, so it must meter again (§5.8). A payload without
    // one is attempt 1.
    const rawAttempt = run['run_attempt'];
    const attempt =
      typeof rawAttempt === 'number' && Number.isInteger(rawAttempt) && rawAttempt > 0
        ? rawAttempt
        : 1;

    // `updated_at` is the completion instant on a `completed` delivery; fall
    // back to `run_started_at` only if it is missing, and refuse the delivery
    // when neither parses — a run with no usable instant cannot be assigned a
    // period (§4.5) or a rate effective-date (§3.3), and guessing one would
    // silently misfile real spend.
    const completedAt = parseDate(run['updated_at']) ?? parseDate(run['run_started_at']);
    if (!completedAt) return null;

    return {
      providerRepoId,
      runId,
      attempt,
      repoOwner,
      repoName,
      workflowName: typeof run['name'] === 'string' ? run['name'] : null,
      completedAt,
    };
  },

  async fetchWorkflowRunJobs(
    installationId: string,
    owner: string,
    name: string,
    runId: string,
    attempt: number,
  ): Promise<NormalizedWorkflowJob[]> {
    const { token } = await mintInstallationToken(installationId);
    // The ATTEMPT-scoped jobs endpoint, so a re-run reads only its OWN jobs —
    // `/runs/{id}/jobs` would return every attempt's jobs and double-count.
    //
    // Deliberately NOT `/runs/{id}/timing`: that endpoint returns `billable` per
    // OS directly and would be the obvious read, but GitHub has it "in the
    // process of closing down" (§5.8), as it does the product-specific billing
    // API. `/jobs` is not deprecated and carries `started_at`, `completed_at`
    // and `labels` — everything the normalization needs.
    const url =
      `${GITHUB_API}/repos/${owner}/${name}/actions/runs/${runId}` +
      `/attempts/${attempt}/jobs?per_page=100`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub workflow-jobs endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub workflow-jobs endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const list = Array.isArray(body?.['jobs']) ? (body!['jobs'] as unknown[]) : [];
    return list
      .map(normalizeWorkflowJob)
      .filter((job): job is NormalizedWorkflowJob => job !== null);
  },

  async fetchOrgComputeUsage(
    org: string,
    year: number,
    month: number,
    token: string,
  ): Promise<NormalizedComputeUsageLine[]> {
    // The ENHANCED-BILLING usage endpoint — the replacement for the closing-down
    // product-specific billing API (§5.8). Summarised by SKU/repo/day, which is
    // enough to RECONCILE and never enough to meter.
    const url = `${GITHUB_API}/organizations/${org}/settings/billing/usage?year=${year}&month=${month}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'motir',
        },
      });
    } catch (err) {
      throw new Error(
        `GitHub billing-usage endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitHub billing-usage endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const items = Array.isArray(body?.['usageItems']) ? (body!['usageItems'] as unknown[]) : [];
    return items
      .map(normalizeUsageLine)
      .filter((line): line is NormalizedComputeUsageLine => line !== null);
  },
};

/** Parse a GitHub ISO-8601 timestamp, or null when absent / unparseable. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalize one entry of the workflow-jobs listing. A job with no id/name is
 *  unusable; one with no timestamps still normalizes (the meter skips it, which
 *  keeps "why did this run meter nothing?" answerable from the job list). */
function normalizeWorkflowJob(value: unknown): NormalizedWorkflowJob | null {
  const job = asRecord(value);
  if (!job) return null;
  const id = idToString(job['id']);
  if (!id) return null;
  const labels = Array.isArray(job['labels'])
    ? (job['labels'] as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  return {
    id,
    name: typeof job['name'] === 'string' ? job['name'] : 'job',
    startedAt: parseDate(job['started_at']),
    completedAt: parseDate(job['completed_at']),
    labels,
  };
}

/** Normalize one `usageItems[]` entry of the enhanced-billing report. */
function normalizeUsageLine(value: unknown): NormalizedComputeUsageLine | null {
  const item = asRecord(value);
  if (!item) return null;
  const repositoryName = typeof item['repositoryName'] === 'string' ? item['repositoryName'] : null;
  const sku = typeof item['sku'] === 'string' ? item['sku'] : null;
  const quantity = typeof item['quantity'] === 'number' ? item['quantity'] : null;
  if (repositoryName === null || sku === null || quantity === null) return null;
  return {
    repositoryName,
    sku,
    quantity,
    unitType: typeof item['unitType'] === 'string' ? item['unitType'] : 'unknown',
    date: typeof item['date'] === 'string' ? item['date'] : '',
  };
}

/** Extract the associated PR/MR numbers from a check payload's `pull_requests`
 *  array (each entry is `{ number, ... }`), deduped. Empty when absent. */
function readPrNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const entry of value) {
    const number = asRecord(entry)?.['number'];
    if (typeof number === 'number' && Number.isInteger(number)) out.add(number);
  }
  return [...out];
}

/** The `head_branch` off a `check_suite` object (present on both the `check_suite`
 *  event and nested in a `check_run`), or null. */
function readHeadBranch(checkSuite: Record<string, unknown> | null): string | null {
  const branch = checkSuite?.['head_branch'];
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

// Register the GitHub provider on import. `lib/git/index.ts` imports this module
// for exactly this side-effect, so any consumer that imports `@/lib/git` gets
// GitHub registered before it resolves a provider.
registerGitProvider(githubProvider);
