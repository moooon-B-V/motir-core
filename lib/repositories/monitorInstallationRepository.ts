import { Prisma, type MonitorInstallation } from '@/generated/prisma/client';

// Monitor-installation repository — single Prisma operations on the
// `monitor_installation` table (Story MOTIR-4926 · MOTIR-5258). The service
// (`monitorConnectionService`, MOTIR-5260) owns orchestration, transactions and
// DTO mapping; this leaf holds none of that.
//
// ⚠️ SEPARATE FROM `monitorConnectionRepository`, and the split is the entity
// rule rather than a preference: "repository naming matches the primary entity,
// NOT the call site" (CLAUDE.md). `github_installation` and `github_repo` — the
// pair these two tables mirror — each have their own repository for the same
// reason.
//
// ⚠️ AND THIS IS THE ONLY REPOSITORY THAT SEES A CREDENTIAL. Every method below
// returns the row with its encrypted columns as stored; nothing here decrypts,
// and the ONE method that is allowed to hand a caller a decryptable value says
// so in its own name (`findCredentialById`). The `*Summary` reads exist so that
// a list or a detail render — the paths that end up in a DTO, a log line or an
// API response — cannot carry a token even by accident, because the selected
// shape has no token field in it at all.

export interface CreateMonitorInstallationInput {
  provider: string;
  /** The provider's own installation id — unique WITHIN a provider. */
  installationId: string;
  workspaceId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  /** Per-provider context carrying NO secret (the Sentry org slug). */
  metadata?: Prisma.InputJsonValue;
}

/**
 * A monitor installation WITHOUT its credential columns — the shape every read
 * path above the repository is given.
 *
 * Prisma's `select` is what enforces it: a `MonitorInstallation` with the token
 * fields omitted is a DIFFERENT TYPE, so a caller that tries to reach a token
 * through one of these does not compile. A comment saying "do not log this"
 * would be a convention; this is the type checker.
 */
export type MonitorInstallationSummary = Omit<
  MonitorInstallation,
  'accessTokenEncrypted' | 'refreshTokenEncrypted'
>;

const SUMMARY_SELECT = {
  id: true,
  provider: true,
  installationId: true,
  workspaceId: true,
  tokenExpiresAt: true,
  health: true,
  healthReason: true,
  healthCheckedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const monitorInstallationRepository = {
  /** Create-or-refresh a grant, keyed on the provider's own installation id.
   *  Re-authorising the same installation replaces the token set in place rather
   *  than accumulating grants — the credential lives on the grant, so a second
   *  row would be a second copy of one secret to rotate. */
  async upsertByProviderInstallation(
    input: CreateMonitorInstallationInput,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorInstallation> {
    const { provider, installationId, ...rest } = input;
    return tx.monitorInstallation.upsert({
      where: { provider_installationId: { provider, installationId } },
      create: { provider, installationId, ...rest },
      update: rest,
    });
  },

  /** The workspace's grants, WITHOUT their credentials — the settings room's
   *  read. Ordered deterministically (`created_at`, then `id`) and carrying no
   *  preference: a stable order is what keeps a render from reshuffling between
   *  two reads of the same page. */
  async listSummariesForWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorInstallationSummary[]> {
    return tx.monitorInstallation.findMany({
      where: { workspaceId },
      select: SUMMARY_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * THE ONE READ THAT HANDS BACK A DECRYPTABLE VALUE, and it is named so that a
   * reviewer can grep for every caller in one search.
   *
   * Everything else in this repository returns a summary. A single-purpose read
   * is what makes "the plaintext appears in no DTO and no response body" a
   * property of the code rather than of everyone's attention: this is the only
   * door, and it is opened by the refresh and the probe.
   */
  async findCredentialById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<MonitorInstallation | null> {
    return tx.monitorInstallation.findUnique({ where: { id } });
  },

  /** Lock a grant FOR UPDATE by its internal id — the read that guards the token
   *  refresh. The provider rotates the refresh token on every refresh, so two
   *  concurrent mints MUST serialize on this lock or the later token is
   *  invalidated by the earlier one. The caller re-reads through
   *  `findCredentialById` inside the SAME transaction. (Written for the
   *  credential-lifecycle card, MOTIR-5261, which is the only caller.) */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM monitor_installation WHERE id = ${id} FOR UPDATE`;
  },

  /** Persist a rotated token set, after a refresh under the lock above. */
  async updateTokens(
    id: string,
    tokens: { accessTokenEncrypted: string; refreshTokenEncrypted: string; tokenExpiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<MonitorInstallation> {
    return tx.monitorInstallation.update({ where: { id }, data: tokens });
  },

  /** Record a health verdict — the `degraded` write the whole epic exists for, or
   *  the `connected` write that clears it. `healthReason` is the PROVIDER's own
   *  string, passed through rather than re-worded. */
  async updateHealth(
    id: string,
    health: { health: string; healthReason: string | null; healthCheckedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<MonitorInstallation> {
    return tx.monitorInstallation.update({ where: { id }, data: health });
  },

  /** Remove a grant. `deleteMany` (not `delete`) so a retried disconnect after the
   *  row is gone is an idempotent no-op (count 0) rather than a `P2025` throw. Its
   *  `monitor_connection` rows cascade with it (the FK `onDelete: Cascade`), which
   *  is what leaves no orphaned binding behind. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.monitorInstallation.deleteMany({ where: { id } });
    return result.count;
  },
};
