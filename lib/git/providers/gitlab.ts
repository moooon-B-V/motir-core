import { registerGitProvider } from '../registry';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
import type { GitProvider } from '../provider';
import type {
  ChangeRequestLifecycle,
  CiConclusion,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedInstallation,
  NormalizedPushEvent,
  NormalizedRepo,
  NormalizedStatusEvent,
} from '../types';

// The GitLab implementation of the GitProvider seam (Story 7.23 · MOTIR-1474) —
// the SECOND registered provider, proving the 7.10.10/MOTIR-891 seam is additive.
// It normalizes GitLab's merge-request / pipeline / push webhook payloads into the
// provider-agnostic shapes, and reaches GitLab's REST API with the connection's
// stored access token (refreshed as needed by `gitlabConnectionService`). Every
// consumer (MOTIR-1475 status sync, MOTIR-1476 code-graph feed) dispatches through
// the `GitProvider` interface by the stored `provider` discriminator and holds NO
// GitLab-specific types — exactly as it does for GitHub.

/** Narrow an `unknown` to a plain object without asserting `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The GitLab numeric id (project) as our string form, or null. */
function idToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/** Normalize one project object from `GET /projects`. GitLab's
 *  `path_with_namespace` is `<owner>/<name>`; `path` is the project slug. */
function normalizeProject(value: unknown): NormalizedRepo | null {
  const project = asRecord(value);
  if (!project) return null;
  const providerRepoId = idToString(project['id']);
  const pathWithNamespace =
    typeof project['path_with_namespace'] === 'string' ? project['path_with_namespace'] : null;
  const name = typeof project['path'] === 'string' ? project['path'] : null;
  // `owner` is everything before the last `/` of the full path (a group can be
  // nested, so keep the whole namespace, not just the top level).
  const owner = pathWithNamespace
    ? pathWithNamespace.slice(0, pathWithNamespace.lastIndexOf('/'))
    : null;
  const defaultBranch =
    typeof project['default_branch'] === 'string' && project['default_branch'].length > 0
      ? project['default_branch']
      : 'main';
  if (!providerRepoId || !name || !owner) return null;
  return { providerRepoId, owner, name, defaultBranch };
}

/** Map a GitLab pipeline `status` to our normalized CI conclusion. */
function mapPipelineStatus(raw: string): CiConclusion {
  switch (raw) {
    case 'success':
      return 'success';
    case 'failed':
    case 'canceled':
    case 'cancelled':
      return 'failure';
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'pending';
    default:
      return 'neutral'; // skipped / manual / anything unrecognised
  }
}

const ZERO_SHA = '0'.repeat(40);

export const gitlabProvider: GitProvider = {
  id: 'gitlab',

  mintInstallationToken(installationId: string): Promise<InstallationToken> {
    return gitlabConnectionService.getAccessToken(installationId);
  },

  async fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]> {
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    let res: Response;
    try {
      res = await fetch(
        `${gitlabBaseUrl()}/api/v4/projects?membership=true&simple=true&per_page=100`,
        { headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' } },
      );
    } catch (err) {
      throw new Error(
        `GitLab projects endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitLab projects endpoint returned ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? (body as unknown[]) : [];
    return list.map(normalizeProject).filter((repo): repo is NormalizedRepo => repo !== null);
  },

  async fetchRepoTarball(
    installationId: string,
    owner: string,
    name: string,
    ref: string,
  ): Promise<ArrayBuffer> {
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    // GitLab addresses a project by its URL-encoded `<owner>/<name>` path; the
    // archive endpoint streams a gzipped tarball at `?sha=<ref>`.
    const projectPath = encodeURIComponent(`${owner}/${name}`);
    let res: Response;
    try {
      res = await fetch(
        `${gitlabBaseUrl()}/api/v4/projects/${projectPath}/repository/archive?sha=${encodeURIComponent(ref)}`,
        { headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' } },
      );
    } catch (err) {
      throw new Error(
        `GitLab archive endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitLab archive endpoint returned ${res.status}`);
    return res.arrayBuffer();
  },

  async fetchInstallation(installationId: string): Promise<NormalizedInstallation> {
    // GitLab has no App-installation read; the connection's account is the
    // authorized user. Fetch it with the connection's own token.
    const { token } = await gitlabConnectionService.getAccessToken(installationId);
    let res: Response;
    try {
      res = await fetch(`${gitlabBaseUrl()}/api/v4/user`, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'motir' },
      });
    } catch (err) {
      throw new Error(
        `GitLab user endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (!res.ok) throw new Error(`GitLab user endpoint returned ${res.status}`);
    const body = asRecord(await res.json());
    const accountLogin = typeof body?.['username'] === 'string' ? body['username'] : '';
    if (!accountLogin) throw new Error('GitLab user endpoint returned no username');
    return { installationId, accountLogin, accountType: 'User' };
  },

  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'merge_request') return null;
    const attrs = asRecord(payload['object_attributes']);
    const project = asRecord(payload['project']);
    if (!attrs || !project) return null;

    const providerRepoId = idToString(project['id']);
    const number = typeof attrs['iid'] === 'number' ? attrs['iid'] : null;
    const headRef = typeof attrs['source_branch'] === 'string' ? attrs['source_branch'] : null;
    const state = typeof attrs['state'] === 'string' ? attrs['state'] : null;
    if (!providerRepoId || number === null || !headRef || !state) return null;

    // GitLab MR states: opened | closed | merged | locked. `merged` is its own
    // state (not a boolean), so collapse it into our orthogonal state/merged pair.
    return {
      providerRepoId,
      number,
      state: state === 'opened' || state === 'locked' ? 'open' : 'closed',
      merged: state === 'merged',
      headRef,
      title: typeof attrs['title'] === 'string' ? attrs['title'] : null,
    };
  },

  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle {
    if (cr.merged) return 'done';
    if (cr.state === 'closed') return 'todo'; // closed WITHOUT merging — not done
    return 'in_review'; // open
  },

  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'pipeline') return null;
    const attrs = asRecord(payload['object_attributes']);
    const project = asRecord(payload['project']);
    if (!attrs || !project) return null;

    const providerRepoId = idToString(project['id']);
    const commitSha = typeof attrs['sha'] === 'string' ? attrs['sha'] : null;
    const status = typeof attrs['status'] === 'string' ? attrs['status'] : null;
    if (!providerRepoId || !commitSha || !status) return null;

    // A pipeline hook carries the associated MR iid on `merge_request.iid` when it
    // ran for one; `object_attributes.ref` is the branch it ran on.
    const mrIid = asRecord(payload['merge_request'])?.['iid'];
    return {
      providerRepoId,
      commitSha,
      conclusion: mapPipelineStatus(status),
      context: 'pipeline',
      prNumbers: typeof mrIid === 'number' && Number.isInteger(mrIid) ? [mrIid] : [],
      headBranch: typeof attrs['ref'] === 'string' && attrs['ref'].length > 0 ? attrs['ref'] : null,
    };
  },

  parsePushEvent(rawPayload: unknown): NormalizedPushEvent | null {
    const payload = asRecord(rawPayload);
    if (!payload || payload['object_kind'] !== 'push') return null;
    const providerRepoId = idToString(asRecord(payload['project'])?.['id']);
    if (!providerRepoId) return null;

    // Only a BRANCH push refreshes the graph. GitLab's `ref` is `refs/heads/<b>`
    // for a branch (a tag push is `object_kind: 'tag_push'`, already filtered);
    // a branch DELETION carries an all-zero `after` sha.
    const ref = typeof payload['ref'] === 'string' ? payload['ref'] : null;
    if (!ref || !ref.startsWith('refs/heads/')) return null;
    const branch = ref.slice('refs/heads/'.length);
    if (branch.length === 0) return null;

    const after = payload['after'];
    if (after === ZERO_SHA) return null; // branch deletion — nothing to index
    return {
      providerRepoId,
      branch,
      headSha: typeof after === 'string' && after.length > 0 ? after : null,
    };
  },
};

// Register the GitLab provider on import. `lib/git/index.ts` imports this module
// for exactly this side-effect, so any consumer that imports `@/lib/git` gets
// GitLab registered before it resolves a provider.
registerGitProvider(gitlabProvider);
