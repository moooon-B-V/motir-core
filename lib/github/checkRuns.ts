import { mintInstallationToken } from './appAuth';

// Writing a CHECK RUN — the leaf primitive Motir did not have (MOTIR-3675).
//
// Until this file every GitHub check in the codebase was READ: `parseCiStatusEvent`
// normalizes `check_run` / `check_suite` deliveries, and nothing wrote one. That
// asymmetry was deliberate for as long as a pull request's association with a card
// could be inferred; once MOTIR-3674 retired the parse, a pull request nobody
// linked associates with nothing at all, and the only way that absence becomes
// visible while somebody can still act on it is a check on the pull request
// itself. `docs/decisions/unlinked-pull-request-check.md` is where that was
// decided, including why option B (a workflow job per repository) does not reach
// the population this exists for.
//
// ⚠️ THE PERMISSION MAY NOT BE THERE, AND THAT IS A NORMAL ANSWER, NOT AN ERROR.
// The `motir-integration` App holds `checks: read`; `checks: write` is an ADDITION,
// and GitHub keeps an installation on its OLD permission set until an account
// admin approves the new one. So a deployment can be fully up to date and still be
// refused here, per installation, for as long as nobody has clicked approve —
// measured on 2026-08-27, `POST /check-runs` answers **403 Resource not accessible
// by integration**. Every function below reports that as `not_permitted` rather
// than throwing: the caller is a webhook delivery or an MCP write, and neither may
// fail because a repository has not consented to a check.
//
// A leaf primitive in the `lib/email.ts` sense — SERVICES import it, routes never
// do — and config is read at call time by `mintInstallationToken`, so a
// self-hosted deploy that never wires the App simply cannot reach it.

const GITHUB_API = 'https://api.github.com';

/** The check run's name, as a person reads it in the GitHub UI. Stable: it is
 *  the key this module re-writes in place, and what a branch-protection rule
 *  would name. `docs/mcp.md` documents it by this string. */
export const LINK_CHECK_NAME = 'Motir / work item link';

/** What a write attempt did. `not_permitted` is the App lacking `checks: write`
 *  on this installation — expected, quiet, and never an error; `unavailable` is
 *  GitHub being unreachable or refusing for any other reason. */
export type CheckRunWriteOutcome = 'created' | 'updated' | 'not_permitted' | 'unavailable';

export interface CheckRunSpec {
  installationId: string;
  owner: string;
  name: string;
  /** The commit the check is attached to. A check run belongs to a SHA, not to a
   *  pull request, which is why every caller has to have one. */
  headSha: string;
  /** `success` clears a previous failure in place; `failure` is the hold. */
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

interface GithubJson {
  [key: string]: unknown;
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'motir',
    'content-type': 'application/json',
  };
}

/**
 * Find THIS app's existing `LINK_CHECK_NAME` run at `headSha`, if there is one.
 *
 * The idempotence half of the contract (the card's AC 5: *one check, not one per
 * delivery*). `POST /check-runs` always creates, so a redelivery would stack a
 * second identical run on the same commit and the pull request would show two.
 * Filtering by `check_name` narrows to this check; GitHub scopes the listing to
 * the authenticated app on its own, so no `app_id` filter is needed.
 *
 * Returns `null` when there is none, and also when the read fails — a failed read
 * degrades to "create one", which is the safe direction: a duplicate check is
 * ugly, a missing one is the defect this whole story is about.
 */
async function findExistingRun(
  token: string,
  owner: string,
  name: string,
  headSha: string,
): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${owner}/${name}/commits/${headSha}/check-runs` +
        `?check_name=${encodeURIComponent(LINK_CHECK_NAME)}&per_page=1`,
      { headers: headers(token) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: GithubJson | null;
  try {
    body = (await res.json()) as GithubJson;
  } catch {
    return null;
  }
  const runs = Array.isArray(body?.['check_runs']) ? (body['check_runs'] as unknown[]) : [];
  const first = runs[0] as GithubJson | undefined;
  const id = first?.['id'];
  return typeof id === 'number' ? id : null;
}

/**
 * Write (or re-write) the link check on one commit.
 *
 * ⚠️ It is UPSERT-BY-NAME, not create: an existing run at the same SHA is PATCHed,
 * so linking a pull request turns the SAME check green rather than adding a
 * second, contradictory one below the first. That is the card's *"it must CLEAR
 * when the link arrives"* criterion, and the reason this is not two functions.
 */
export async function writeCheckRun(spec: CheckRunSpec): Promise<CheckRunWriteOutcome> {
  let token: string;
  try {
    ({ token } = await mintInstallationToken(spec.installationId));
  } catch {
    // Unconfigured App, unmintable token, unreachable host — all the same answer
    // to the caller, which is "no check was written and nothing is wrong".
    return 'unavailable';
  }

  const existingId = await findExistingRun(token, spec.owner, spec.name, spec.headSha);
  const payload = {
    name: LINK_CHECK_NAME,
    head_sha: spec.headSha,
    status: 'completed',
    conclusion: spec.conclusion,
    output: { title: spec.title, summary: spec.summary },
  };

  let res: Response;
  try {
    res = await fetch(
      existingId === null
        ? `${GITHUB_API}/repos/${spec.owner}/${spec.name}/check-runs`
        : `${GITHUB_API}/repos/${spec.owner}/${spec.name}/check-runs/${existingId}`,
      {
        method: existingId === null ? 'POST' : 'PATCH',
        headers: headers(token),
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return 'unavailable';
  }

  if (res.status === 403) return 'not_permitted';
  if (!res.ok) return 'unavailable';
  return existingId === null ? 'created' : 'updated';
}

/**
 * The head SHA of a pull request, read from the host.
 *
 * ⚠️ WHY THIS EXISTS AND WHY IT IS NOT A COLUMN. A check run is addressed by
 * commit, and only ONE of the two callers has one: a `pull_request` delivery
 * carries `pull_request.head.sha`, while `link_pull_request` is a call about a
 * pull request the caller may have opened seconds earlier and knows only by
 * number. `docs/decisions/unlinked-pull-request-check.md` proposed stamping a
 * `head_sha` column from every delivery and falling back to a read; the column is
 * NOT added, because a schema change on the shared development database is a cost
 * every parallel session pays (a migration it did not write shows up as drift in
 * its own `migrate diff`), and this read is one call on a path that is already
 * doing network I/O. The ADR is amended in the same pull request rather than left
 * describing a design that was not built.
 *
 * `pull_requests: write` covers the read, so it needs no new permission.
 */
export async function readPullRequestHeadSha(
  installationId: string,
  owner: string,
  name: string,
  number: number,
): Promise<string | null> {
  let token: string;
  try {
    ({ token } = await mintInstallationToken(installationId));
  } catch {
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${owner}/${name}/pulls/${number}`, {
      headers: headers(token),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: GithubJson | null;
  try {
    body = (await res.json()) as GithubJson;
  } catch {
    return null;
  }
  const head = body?.['head'];
  const sha = typeof head === 'object' && head !== null ? (head as GithubJson)['sha'] : null;
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}
