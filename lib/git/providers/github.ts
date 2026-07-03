import { registerGitProvider } from '../registry';
import { mintInstallationToken } from '@/lib/github/appAuth';
import type { GitProvider } from '../provider';
import type {
  ChangeRequestLifecycle,
  CiConclusion,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedRepo,
  NormalizedStatusEvent,
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

    // Modern `check_run` event: a not-yet-completed run is `pending`.
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
      };
    }

    // Legacy commit-`status` event: { sha, state, context }.
    const sha = typeof payload['sha'] === 'string' ? payload['sha'] : null;
    const state = typeof payload['state'] === 'string' ? payload['state'] : null;
    if (sha && state) {
      return {
        providerRepoId,
        commitSha: sha,
        conclusion: mapConclusion(state),
        context: typeof payload['context'] === 'string' ? payload['context'] : 'status',
      };
    }

    return null;
  },
};

// Register the GitHub provider on import. `lib/git/index.ts` imports this module
// for exactly this side-effect, so any consumer that imports `@/lib/git` gets
// GitHub registered before it resolves a provider.
registerGitProvider(githubProvider);
