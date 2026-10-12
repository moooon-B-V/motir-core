import {
  type GithubInstallation,
  type GithubInstallationOrgLink,
  type Prisma,
} from '@/generated/prisma/client';

// GitHub installation ↔ organisation link repository — single Prisma
// operations on the `github_installation_org_link` table (Story MOTIR-8216 ·
// MOTIR-8218). A GitHub App is installed ONCE per GitHub account, so one
// `github_installation` row can serve several Motir organisations; this table
// records which. The service (githubInstallationService) owns orchestration,
// transactions and DTO mapping; this leaf holds none of that.
//
// Layer rules (CLAUDE.md): every method takes `tx`. Writes run under
// `withSystemContext` (the table's only write policy is the system escape);
// reads run inside a workspace or organisation context so RLS scopes them.

export interface UpsertGithubInstallationOrgLinkInput {
  /** The INTERNAL GithubInstallation.id (a cuid), never GitHub's numeric id. */
  installationId: string;
  organizationId: string;
  /** The workspace the link was made FROM — the tier the workspace read arm
   *  and the audit trail key on. Re-stamped on a re-link. */
  workspaceId: string;
}

export type GithubInstallationOrgLinkWithInstallation = GithubInstallationOrgLink & {
  installation: GithubInstallation;
};

export const githubInstallationOrgLinkRepository = {
  /** The link between one installation and one organisation, or null. */
  async findByInstallationAndOrg(
    installationId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallationOrgLink | null> {
    return tx.githubInstallationOrgLink.findUnique({
      where: { installationId_organizationId: { installationId, organizationId } },
    });
  },

  /** The organisation's linked GitHub installations, each with its
   *  installation row. Ordered deterministically (`created_at`, then `id`) and
   *  carrying no preference — the first link is not the "real" one. GitLab
   *  connections are per-organisation rows and are never linked here; the
   *  provider filter keeps that true if one ever is. */
  async listByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallationOrgLinkWithInstallation[]> {
    return tx.githubInstallationOrgLink.findMany({
      where: { organizationId, installation: { is: { provider: 'github' } } },
      include: { installation: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Every organisation an installation is linked to — the webhook fan-out and
   *  the uninstall cleanup read this. Same deterministic order. */
  async listByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallationOrgLink[]> {
    return tx.githubInstallationOrgLink.findMany({
      where: { installationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Link an installation to an organisation. Idempotent on the pair: a re-link
   *  re-stamps the workspace it was made from and changes nothing else. */
  async upsert(
    input: UpsertGithubInstallationOrgLinkInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubInstallationOrgLink> {
    const { installationId, organizationId, workspaceId } = input;
    return tx.githubInstallationOrgLink.upsert({
      where: { installationId_organizationId: { installationId, organizationId } },
      create: { installationId, organizationId, workspaceId },
      update: { workspaceId },
    });
  },

  /** Remove one organisation's link. `deleteMany`, so a re-run after the link
   *  is gone is a no-op (count 0) rather than a `P2025` throw. Returns the
   *  count. The installation row and other organisations' links are untouched. */
  async deleteByInstallationAndOrg(
    installationId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubInstallationOrgLink.deleteMany({
      where: { installationId, organizationId },
    });
    return result.count;
  },

  /** How many organisations an installation is still linked to — zero is what
   *  lets a per-organisation disconnect uninstall the App for the last one. */
  async countByInstallationId(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.githubInstallationOrgLink.count({ where: { installationId } });
  },
};
