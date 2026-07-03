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

export const githubInstallationRepository = {
  /** The workspace's installation, or null when it has none (a valid
   *  "not connected" state — the two grants are independent). */
  async findByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallation | null> {
    return tx.githubInstallation.findFirst({ where: { workspaceId } });
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
};
