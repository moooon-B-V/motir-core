import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { getGitProvider } from '@/lib/git';
import { UnknownGitProviderError } from '@/lib/git/registry';
import type { GitProviderId, RepoFileReadResult } from '@/lib/git/types';

// The repo-file READ service (Story MOTIR-4585 · MOTIR-4586) — the core-owned
// read motir-ai calls back into DURING a planning job, so a session can look at
// the source it is planning against instead of only being TOLD about it.
//
// ── Why the read happens HERE ────────────────────────────────────────────────
// motir-ai holds no provider credential (the 7.5 ingest invariant), and this
// keeps it that way: motir-core resolves the provider off the stored
// discriminator, mints (or reuses) an installation token, calls the host, and
// returns TEXT. The token lives in-process for the length of one call, is never
// persisted (`mintInstallationToken`'s standing contract), and never appears in
// anything this service returns. That is the same shape
// `githubCodeScanningProxyService` uses, one capability over.
//
// ── But NOT the same DEGRADATION, and this is the part worth reading ─────────
// That proxy returns `null` for every failure — not connected, unconfigured
// App, mint failure, host unavailable — because its consumer is a DETECTOR that
// only ever asked "is there a source here?", and a detector may treat every no
// as the same no. This service's consumer is a MODEL deciding what it now
// knows, and for it those answers are different facts. Collapsing them means a
// session concludes "this project has no code connected" from "that branch does
// not exist", which is a wrong belief it will then plan on. So every outcome is
// NAMED (`RepoFileReadResult`), and nothing here returns null.
//
// ── Tenancy ─────────────────────────────────────────────────────────────────
// The caller is a job token and the WORKSPACE is the token's own, signed by
// core. The repo lookup runs under `withWorkspaceContext` (the RLS gate) and
// filters on that workspace, so a job for workspace A can only ever resolve a
// repo connected in workspace A. A `repoRef` naming somebody else's repository
// is indistinguishable from one naming nothing — `repo_not_connected` either
// way, no existence leak.

export interface RepoFileReadContext {
  userId: string;
  workspaceId: string;
}

/** The service's result: the provider's own outcomes, plus the two this layer
 *  decides — the repo is not connected here, and the provider is unusable. */
export type RepoFileServiceResult =
  | RepoFileReadResult
  | { outcome: 'repo_not_connected'; repoRef: string }
  | { outcome: 'provider_unavailable'; repoRef: string; detail: string };

/**
 * Split a `repoRef` into `(owner, name)` at the LAST slash.
 *
 * ⚠️ NOT `lib/github/codeScanning.ts`'s `parseRepoRef`, and the difference is
 * load-bearing rather than duplication. That one requires EXACTLY two segments,
 * which is right for GitHub and wrong here: a GitLab group nests, so
 * `acme/platform/web` is one project whose owner is `acme/platform` — and
 * `normalizeProject` in the GitLab provider already stores it that way, taking
 * everything before the last slash as the owner. Reusing the two-segment parser
 * would refuse every nested-group project with "not connected", which is a
 * false statement about a repository that is connected.
 */
export function splitRepoRef(repoRef: string): { owner: string; name: string } | null {
  const ref = repoRef
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(github|gitlab)\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const cut = ref.lastIndexOf('/');
  if (cut <= 0 || cut === ref.length - 1) return null;
  const owner = ref.slice(0, cut);
  const name = ref.slice(cut + 1);
  if (!owner || !name || owner.includes('..') || name.includes('/')) return null;
  return { owner, name };
}

export const repoFileReadService = {
  /**
   * Read one file's text from a connected repository, at `ref` or at the
   * repository's own default branch.
   *
   * The default branch comes from the STORED row, not from a second host call:
   * it is a mirrored column, it is what every other consumer already reads, and
   * asking the host for it would double the latency of the common case to learn
   * something we wrote down at connect time.
   */
  async readFile(
    ctx: RepoFileReadContext,
    repoRef: string,
    path: string,
    ref?: string,
  ): Promise<RepoFileServiceResult> {
    const coords = splitRepoRef(repoRef);
    if (!coords) return { outcome: 'repo_not_connected', repoRef };

    const connected = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) =>
        githubRepoRepository.findConnectedByWorkspaceAndName(
          ctx.workspaceId,
          coords.owner,
          coords.name,
          tx,
        ),
    );
    if (!connected) return { outcome: 'repo_not_connected', repoRef };

    let provider;
    try {
      provider = getGitProvider(connected.installation.provider as GitProviderId);
    } catch (err) {
      // A row whose provider is not registered on this deployment. Named rather
      // than thrown: it is a deployment fact, and a session that is told which
      // one can stop asking about this repository instead of retrying.
      return {
        outcome: 'provider_unavailable',
        repoRef,
        detail:
          err instanceof UnknownGitProviderError
            ? err.message
            : `the ${connected.installation.provider} provider could not be resolved`,
      };
    }

    // The STORED canonical coordinates, never the caller's ref — casing on
    // GitHub is the host's, and the caller's spelling is model-supplied.
    try {
      return await provider.readFileAtRef(
        connected.installation.installationId,
        connected.owner,
        connected.name,
        path,
        ref?.trim() || connected.defaultBranch,
      );
    } catch (err) {
      // The mint failed (an App not configured on this deploy, a revoked
      // connection), or the host answered a status no arm names. Both are
      // "we could not ask", which is a different fact from any answer.
      return {
        outcome: 'provider_unavailable',
        repoRef,
        detail: err instanceof Error ? err.message : 'unknown',
      };
    }
  },
};
