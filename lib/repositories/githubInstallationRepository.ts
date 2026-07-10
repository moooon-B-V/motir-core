import { type GithubInstallation, type Prisma } from '@prisma/client';

// GitHub-installation repository — single Prisma operations on the
// `github_installation` table (Story 7.10 · MOTIR-891). The service
// (githubInstallationService) owns orchestration, transactions, and DTO mapping;
// this leaf holds none of that.
//
// Layer rules (CLAUDE.md): the write (`upsert`) REQUIRES `tx`. The reads take
// `tx` too — both run inside a context transaction (`withWorkspaceContext` for
// the settings read, `withSystemContext` for the webhook write path), so RLS
// scopes them.

export interface UpsertGithubInstallationInput {
  installationId: string;
  workspaceId: string;
  accountLogin: string;
  accountType: string;
}

/** A GitLab connection upsert (Story 7.23 · MOTIR-1474) — the SAME table under
 *  `provider: 'gitlab'`, plus the encrypted token set GitLab's OAuth model stores
 *  (GitHub leaves these null). */
export interface UpsertGitlabConnectionInput {
  installationId: string;
  workspaceId: string;
  accountLogin: string;
  accountType: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
}

export const githubInstallationRepository = {
  /** The workspace's GitHub installation, or null when it has none (a valid
   *  "not connected" state — the two grants are independent). Filtered to
   *  `provider: 'github'` so a GitLab connection on the same workspace (same
   *  table, MOTIR-1474) never leaks into a GitHub read. */
  async findByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({ where: { workspaceId, provider: 'github' } });
  },

  /** The workspace's connection for a specific provider (`github` | `gitlab`), or
   *  null. The provider-aware read a GitLab caller uses. */
  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({ where: { workspaceId, provider } });
  },

  /** Look up by GitHub's numeric installation id (the webhook's key). */
  async findByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findUnique({ where: { installationId } });
  },

  /** Create-or-refresh the installation, keyed on the unique GitHub
   *  `installation_id` (a re-install / repo-selection change refreshes in place). */
  async upsert(
    input: UpsertGithubInstallationInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    const { installationId, ...rest } = input;
    return tx.githubInstallation.upsert({
      where: { installationId },
      create: { installationId, ...rest },
      update: rest,
    });
  },

  /** Remove an installation by its GitHub `installation_id` (the `installation
   *  deleted` webhook — an uninstall). `deleteMany` (not `delete`) so a redelivery
   *  of the uninstall event after the row is gone is an idempotent no-op (count 0)
   *  rather than a `P2025` throw. The `github_repo` / `github_pull_request` rows
   *  cascade with it (the FK `onDelete: Cascade`). Returns the delete count. */
  async deleteByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubInstallation.deleteMany({ where: { installationId } });
    return result.count;
  },

  /** Create-or-refresh a GitLab connection (Story 7.23 · MOTIR-1474), keyed on the
   *  unique `installation_id` (the minted connection id). Re-connecting the same
   *  connection refreshes the account + token set in place. `provider` is pinned
   *  to `'gitlab'`; the encrypted token columns GitHub leaves null are populated. */
  async upsertGitlabConnection(
    input: UpsertGitlabConnectionInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    const { installationId, ...rest } = input;
    return tx.githubInstallation.upsert({
      where: { installationId },
      create: { installationId, provider: 'gitlab', ...rest },
      update: { provider: 'gitlab', ...rest },
    });
  },

  /** Lock a connection row FOR UPDATE by its `installation_id` (Story 7.23 ·
   *  MOTIR-1474) — the read that guards the token refresh. GitLab rotates the
   *  refresh token on every refresh, so concurrent mint calls MUST serialize on
   *  this lock or a double-refresh invalidates the newer token. The caller
   *  re-reads via `findByInstallationId` inside the SAME transaction. */
  async lockByInstallationId(installationId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_installation WHERE installation_id = ${installationId} FOR UPDATE`;
  },

  /** Persist a rotated token set on a connection (Story 7.23 · MOTIR-1474), after
   *  a refresh under the FOR UPDATE lock above. */
  async updateTokens(
    id: string,
    tokens: { accessTokenEncrypted: string; refreshTokenEncrypted: string; tokenExpiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation> {
    return tx.githubInstallation.update({ where: { id }, data: tokens });
  },
};
