import { type GithubInstallation, type GithubRepo, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// GitHub-repo repository — single Prisma operations on the `github_repo` table
// (Story 7.10 · MOTIR-891). `installationId` here is the INTERNAL
// GithubInstallation.id (a cuid), never GitHub's numeric installation id.

export interface UpsertGithubRepoInput {
  installationId: string;
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export const githubRepoRepository = {
  /** The repos selected on an installation, stable-ordered for display. Runs
   *  inside a context transaction, so it takes `tx`. */
  async listByInstallation(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { installationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** One selected repo by its `(installation_id, repo_id)` pair — the webhook's
   *  lookup from a normalized change request's `providerRepoId` (GitHub's numeric
   *  repo id) to the internal `GithubRepo.id` the PR row FKs against. Null when
   *  the repo isn't selected on this installation. */
  async findByInstallationAndRepoId(
    installationId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo | null> {
    return tx.githubRepo.findUnique({
      where: { installationId_repoId: { installationId, repoId } },
    });
  },

  /** Create-or-refresh one selected repo, keyed on the unique
   *  `(installation_id, repo_id)` pair. */
  async upsert(input: UpsertGithubRepoInput, tx: Prisma.TransactionClient): Promise<GithubRepo> {
    const { installationId, repoId, ...rest } = input;
    return tx.githubRepo.upsert({
      where: { installationId_repoId: { installationId, repoId } },
      create: { installationId, repoId, ...rest },
      update: rest,
    });
  },

  /** One connected repo by `(owner, name)` within a WORKSPACE — the code-scanning
   *  proxy's resolution (MOTIR-1605) from an audit `repoRef` to the tenant's
   *  installation. Owner/name match case-insensitively (GitHub coordinates are
   *  case-insensitive). The `installation.workspaceId` filter scopes the lookup
   *  to the caller's own workspace (defense-in-depth alongside the withWorkspaceContext
   *  RLS gate on `github_installation`) — a repo connected under another tenant's
   *  installation can never resolve. Includes the parent installation (its
   *  provider + numeric `installationId` drive the token mint). Null when the
   *  repo isn't connected in this workspace. Read inside a context transaction, so
   *  it takes `tx`. */
  async findConnectedByWorkspaceAndName(
    workspaceId: string,
    owner: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
        installation: { is: { workspaceId } },
      },
      include: { installation: true },
    });
  },

  /** Resolve a connected repo GLOBALLY by `(owner, name)` — the keyless-OIDC
   *  trust seam (MOTIR-1650). A GitHub Actions OIDC token's `repository` claim
   *  (`owner/name`) DETERMINES the tenant, so this read runs OUTSIDE any
   *  workspace context (like the webhook keying on GitHub's global installation
   *  id), on the `db` singleton. Case-insensitive (GitHub coordinates are).
   *  Returns EVERY match so the caller can reject an AMBIGUOUS coordinate (the
   *  same repo connected under two workspaces) rather than silently pick one —
   *  it never scopes to a workspace because the caller has none yet. Read-only →
   *  no `tx`. Includes the parent installation (its `workspaceId` is the tenant). */
  async findConnectedByName(
    owner: string,
    name: string,
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    return db.githubRepo.findMany({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
      },
      include: { installation: true },
    });
  },

  /** Resolve a connected repo by its host repo id under a given PROVIDER (Story
   *  7.23 · MOTIR-1475) — the GitLab webhook's key. A GitLab MR/pipeline delivery
   *  carries the project id but NO Motir connection id (unlike GitHub's App
   *  delivery, which carries its global installation id), so the webhook resolves
   *  the connection through the repo: match `(repo_id, installation.provider)` and
   *  include the parent installation (its workspace + provider drive the sync).
   *  Runs OUTSIDE any workspace context (the webhook has no active workspace, like
   *  the GitHub path keying on the global installation id), inside the sync's
   *  system-context transaction, so it takes `tx`. A host project id is unique per
   *  GitLab instance; the oldest-connected row wins if the same project is somehow
   *  connected twice. Null when the project isn't connected. */
  async findByRepoIdAndProvider(
    repoId: string,
    provider: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: { repoId, installation: { is: { provider } } },
      include: { installation: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Reconcile the selected set: delete every repo on this installation whose
   *  `repo_id` is NOT in `keepRepoIds` (a de-selected repo). An empty keep set
   *  deletes them all (`NOT IN ()` is always true). Returns the delete count. */
  async deleteExcept(
    installationId: string,
    keepRepoIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({
      where: { installationId, NOT: { repoId: { in: keepRepoIds } } },
    });
    return result.count;
  },
};
