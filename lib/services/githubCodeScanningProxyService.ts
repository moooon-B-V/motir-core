import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { getGitProvider } from '@/lib/git';
import {
  fetchCodeScanningAnalyses,
  fetchCodeScanningSarif,
  parseRepoRef,
  type CodeScanningAnalysisSummary,
} from '@/lib/github/codeScanning';
import type { GitProviderId } from '@/lib/git/types';

// Code-scanning PROXY service (Story 7.14 · MOTIR-1605) — the core-owned read
// motir-ai calls back into DURING a `code_audit` job (the ai→core §4 boundary)
// to detect an existing GitHub code-scanning source for a PRIVATE connected repo.
//
// Why a proxy and not a token handed across: motir-ai holds NO GitHub credential
// (the 7.5 ingest invariant). Rather than mint a token and ship it to the closed
// service — persisting a credential in a job envelope (a security smell) or
// over-scoping (the App token spans every selected repo) — motir-core does the
// authenticated read itself and returns only the data. The installation token is
// minted per call via the provider seam, lives in-process, and NEVER crosses the
// boundary or gets persisted.
//
// Tenancy: the caller is a job token, and the WORKSPACE is the token's own
// (`ctx.workspaceId`, signed by core). The repo lookup runs under
// `withWorkspaceContext` (the RLS gate) AND filters on the installation's
// workspace, so a job for workspace A can only ever resolve repos connected in
// workspace A — no cross-tenant credential leakage.
//
// NEVER a gate (§10.3): a not-connected repo, an unconfigured App, a mint
// failure, or an unavailable API all return null, so motir-ai's detection
// degrades to "source absent" exactly as the unauthenticated probe did.

export interface CodeScanningProxyContext {
  userId: string;
  workspaceId: string;
}

/** Resolve `repoRef` to the connected repo's coordinates + a freshly-minted
 *  installation token, or null when it can't be resolved (degrade). */
async function resolveRepoToken(
  ctx: CodeScanningProxyContext,
  repoRef: string,
): Promise<{ token: string; owner: string; name: string } | null> {
  const gh = parseRepoRef(repoRef);
  if (!gh) return null;

  const connected = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) =>
      githubRepoRepository.findConnectedByWorkspaceAndName(ctx.workspaceId, gh.owner, gh.name, tx),
  );
  if (!connected) return null;

  try {
    const provider = getGitProvider(connected.installation.provider as GitProviderId);
    const { token } = await provider.mintInstallationToken(connected.installation.installationId);
    // Use the STORED canonical coordinates (GitHub casing), not the caller's ref.
    return { token, owner: connected.owner, name: connected.name };
  } catch {
    // App not configured on this deploy / token-mint failure — degrade, never gate.
    return null;
  }
}

export const githubCodeScanningProxyService = {
  /** The code-scanning analyses for `repoRef`, read with the tenant's
   *  installation token. Null when unresolvable / unavailable. */
  async listAnalyses(
    ctx: CodeScanningProxyContext,
    repoRef: string,
  ): Promise<CodeScanningAnalysisSummary[] | null> {
    const resolved = await resolveRepoToken(ctx, repoRef);
    if (!resolved) return null;
    return fetchCodeScanningAnalyses(resolved.token, resolved.owner, resolved.name);
  },

  /** The SARIF document for one analysis of `repoRef`, read with the tenant's
   *  installation token. Returned opaque. Null when unresolvable / unavailable. */
  async getSarif(
    ctx: CodeScanningProxyContext,
    repoRef: string,
    analysisId: number,
  ): Promise<unknown | null> {
    const resolved = await resolveRepoToken(ctx, repoRef);
    if (!resolved) return null;
    return fetchCodeScanningSarif(resolved.token, resolved.owner, resolved.name, analysisId);
  },
};
