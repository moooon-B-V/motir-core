// The CLONE URL of a connected repository (Story MOTIR-1775 · MOTIR-1783) —
// derived from the coordinates the mirror row already stores (`provider`,
// `owner`, `name`), never a column of its own.
//
// Why DERIVED and not stored: the host's clone URL is a pure function of the
// coordinates plus the instance base, and the instance base is DEPLOYMENT config
// (`GITLAB_BASE_URL`) that can change under a row that outlives it. A stored
// column would freeze whatever the base was at connect time and then disagree
// with the running deployment — the same freeze-a-guess defect
// `docs/decisions/target-repo-attribution.md` §3 rejects for the repo pin
// itself.
//
// HTTPS, not SSH: the agent that consumes this clones with whatever credential
// the CLI already has (a token / the user's git credential helper), and an
// `https://` URL works under both a PAT and a credential helper, while `git@`
// requires a key the runner may not have. `.git` suffixed, which every host
// accepts and which keeps a bare `git clone <url>` from taking a directory name
// with a query or fragment in it.

import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';

const GITHUB_BASE_URL = 'https://github.com';

/** The coordinates a clone URL is derived from — the `GithubRepo` mirror row's
 *  own fields (the table holds GitLab projects too; `provider` discriminates). */
export interface RepoCoordinates {
  /** `github` | `gitlab` — the mirror row's provider discriminator. */
  provider: string;
  /** The owning account / group login. */
  owner: string;
  /** The bare repository name. */
  name: string;
}

/**
 * The HTTPS clone URL for a connected repository, or `null` when Motir cannot
 * derive one.
 *
 * `null` is a real answer, and the only honest one for a provider this build
 * does not know how to address (a value that arrives from a future connector, or
 * a row written by a newer version). Guessing a host would hand an agent a URL
 * that fails at `git clone` — strictly worse than telling it Motir does not
 * know, which is exactly the posture the resolved repo NAME already takes.
 */
export function repoCloneUrl(repo: RepoCoordinates): string | null {
  const owner = repo.owner.trim();
  const name = repo.name.trim();
  if (owner.length === 0 || name.length === 0) return null;
  switch (repo.provider) {
    case 'github':
      return `${GITHUB_BASE_URL}/${owner}/${name}.git`;
    // The GitLab instance is configurable (`GITLAB_BASE_URL`), so a self-managed
    // deployment's clone URL addresses ITS host, not gitlab.com — read at call
    // time, the same rule `gitlabBaseUrl` itself follows.
    case 'gitlab':
      return `${gitlabBaseUrl()}/${owner}/${name}.git`;
    default:
      return null;
  }
}

/**
 * The repository's WEB url — the link-out a human follows to see their code
 * (MOTIR-1782's established rows). Same derivation as {@link repoCloneUrl} minus
 * the `.git` suffix, and `null` on the same unknown-provider terms, so the two can
 * never disagree about which host a repository lives on.
 */
export function repoWebUrl(repo: RepoCoordinates): string | null {
  const clone = repoCloneUrl(repo);
  return clone === null ? null : clone.replace(/\.git$/, '');
}
