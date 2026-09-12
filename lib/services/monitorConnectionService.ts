import type { Prisma } from '@/generated/prisma/client';
import type {
  AvailableMonitorProjectDto,
  BindMonitorProjectInput,
  MonitorConnectionDto,
  MonitorConnectionViewDto,
} from '@/lib/dto/monitors';
import { toMonitorConnectionDto, readOrgSlug } from '@/lib/mappers/monitorMappers';
import { getMonitorProvider } from '@/lib/monitors';
import {
  MonitorConnectionNotFoundError,
  MonitorGrantNotFoundError,
  MonitorProviderCallError,
} from '@/lib/monitors/errors';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The monitor CONNECTION service (Story MOTIR-4926 · Subtask MOTIR-5260) —
// business logic, transactions and DTOs for connecting an error monitor to a
// project, listing what is connected, and disconnecting one.
//
// Layering (CLAUDE.md): this is the only file that opens a transaction here, the
// repositories below it hold single Prisma operations, and the routes above it
// are HTTP transport. Every provider call goes through the `MonitorProvider`
// seam (MOTIR-5259), which touches no row.
//
// ⚠️ EVERY METHOD ASSERTS `integration:manage` ON THE PROJECT, and that is what
// makes the catalog key honest: `lib/permissions/catalog.ts`'s own header says a
// key exists "because the product has an operation it governs", and an
// `enforced` key with no call site fails the orphan guard. The key and its gate
// land in the same pull request for that reason.
//
// ⚠️ AND THE CREDENTIAL NEVER CROSSES A BOUNDARY. It is encrypted before it is
// persisted, decrypted only inside a method that is about to call the provider,
// and named by no DTO in `lib/dto/monitors.ts`. The `*Summary` reads the
// repository offers are the shape every render path gets.
//
// ⚠️ WHAT THIS SERVICE DOES NOT DO: keep the credential alive. It stores the
// access token, the refresh token and the expiry it was handed; it does not
// refresh, does not probe, and writes no `degraded` verdict. The eight-hour
// expiry means a connection made here stops working within a day on its own —
// that is MOTIR-5261's whole reason to exist, not a defect in this one.

/** Assert the actor may manage this project's integrations, then run `fn` inside
 *  one project-scoped RLS transaction. */
async function inProject<T>(
  projectId: string,
  ctx: ServiceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId }, fn);
}

export const monitorConnectionService = {
  /**
   * Persist the GRANT a provider's authorisation just issued, and land the
   * browser back on the room.
   *
   * ⚠️ IT BINDS NO PROJECT, and that is a reading of the card's flow worth
   * stating. The story is about a project holding a SET of monitored projects,
   * and the person authorising has not yet seen the list they are choosing from
   * — the provider's own install screen does not show it. Binding every project
   * in the org by default would be wrong the moment a customer has ten Sentry
   * projects and three Motir ones, which is the exact cardinality this story
   * exists to model. Both mirrors install first and link second, so this method
   * stores the grant and `bindProject` is the explicit second act.
   *
   * The project is the one the START leg recorded in its httpOnly cookie, where
   * the actor's `integration:manage` on it had just been asserted — never an id
   * from the callback's query string.
   */
  async completeGrant(
    input: {
      provider: string;
      providerInstallationId: string;
      code: string;
      projectId: string;
    },
    ctx: ServiceContext,
  ): Promise<{ installationId: string; orgSlug: string | null }> {
    await projectAccessService.assertPermission(input.projectId, ctx, 'integration:manage');

    const provider = getMonitorProvider(input.provider);

    // OUTSIDE the transaction, deliberately: two network round trips with a
    // provider are not something to hold a database transaction open across,
    // and neither call reads or writes a row. `CLAUDE.md`'s side-effects-outside-
    // the-transaction rule is the same instruction from the other direction.
    const credential = await provider.exchangeGrant({
      installationId: input.providerInstallationId,
      code: input.code,
    });
    // Verify the install so the provider leaves its pending state — an
    // installation left unverified is one the provider may reap, which would
    // leave Motir holding a credential for a grant that no longer exists.
    await provider.verifyInstall({
      installationId: input.providerInstallationId,
      accessToken: credential.accessToken,
    });

    // WHICH ORGANISATION this is. The install redirect carries an installation id
    // and no organisation, while every org-scoped provider method needs a slug —
    // so the grant asks once, here, and records the answer on the row. After
    // this, the room never has to call the provider to render a list, which
    // matters most when the credential is degraded and a call would fail.
    const { orgSlug } = await provider.describeInstallation({
      installationId: input.providerInstallationId,
      accessToken: credential.accessToken,
    });

    const installation = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: input.projectId },
      (tx) =>
        monitorInstallationRepository.upsertByProviderInstallation(
          {
            provider: input.provider,
            installationId: input.providerInstallationId,
            workspaceId: ctx.workspaceId,
            accessTokenEncrypted: encryptToken(credential.accessToken),
            refreshTokenEncrypted: encryptToken(credential.refreshToken),
            tokenExpiresAt: credential.expiresAt,
            ...(orgSlug ? { metadata: { orgSlug } } : {}),
          },
          tx,
        ),
    );

    return { installationId: installation.id, orgSlug: readOrgSlug(installation.metadata) };
  },

  /** The room's read: the workspace's grant (if any) and this project's
   *  bindings. */
  async getView(projectId: string, ctx: ServiceContext): Promise<MonitorConnectionViewDto> {
    return inProject(projectId, ctx, async (tx) => {
      const grants = await monitorInstallationRepository.listSummariesForWorkspace(
        ctx.workspaceId,
        tx,
      );
      const connections = await monitorConnectionRepository.listForProject(projectId, tx);
      const grant = grants[0] ?? null;
      return {
        installationId: grant?.id ?? null,
        orgSlug: grant ? readOrgSlug(grant.metadata) : null,
        health: grant?.health ?? null,
        healthReason: grant?.healthReason ?? null,
        connections: connections.map(toMonitorConnectionDto),
      };
    });
  },

  /** The picker's read: the grant's monitored projects, each flagged with
   *  whether THIS project already binds it. */
  async listAvailableProjects(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<AvailableMonitorProjectDto[]> {
    await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');

    const grant = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const grants = await monitorInstallationRepository.listSummariesForWorkspace(
        ctx.workspaceId,
        tx,
      );
      return grants[0] ?? null;
    });
    if (!grant) throw new MonitorGrantNotFoundError(ctx.workspaceId);

    const credential = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      monitorInstallationRepository.findCredentialById(grant.id, tx),
    );
    if (!credential) throw new MonitorGrantNotFoundError(ctx.workspaceId);

    const provider = getMonitorProvider(grant.provider);
    const orgSlug = readOrgSlug(grant.metadata);
    const projects = await provider.listProjects({
      // Decrypted HERE, one line before the call that needs it, and never
      // returned: the only method in this file that reaches the plaintext is one
      // about to hand it to the provider.
      accessToken: decryptToken(credential.accessTokenEncrypted),
      orgSlug: orgSlug ?? '',
    });

    const bound = new Set(
      (
        await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
          (tx) => monitorConnectionRepository.listForProject(projectId, tx),
        )
      ).map((row) => row.externalProjectId),
    );

    return projects.map((project) => ({
      externalId: project.externalId,
      slug: project.slug,
      name: project.name,
      bound: bound.has(project.externalId),
    }));
  },

  /**
   * Bind one monitored project to this Motir project.
   *
   * The already-bound refusal is the DATABASE's, translated by the repository
   * into a typed `MONITOR_CONNECTION_ALREADY_EXISTS` — no check-then-write guard
   * here, because two authorisation returns can land at once and a guard with no
   * constraint behind it only fails under a warm pool.
   */
  async bindProject(
    projectId: string,
    input: BindMonitorProjectInput,
    ctx: ServiceContext,
  ): Promise<MonitorConnectionDto> {
    return inProject(projectId, ctx, async (tx) => {
      const grants = await monitorInstallationRepository.listSummariesForWorkspace(
        ctx.workspaceId,
        tx,
      );
      const grant = grants[0];
      if (!grant) throw new MonitorGrantNotFoundError(ctx.workspaceId);

      await monitorConnectionRepository.create(
        {
          installationId: grant.id,
          projectId,
          workspaceId: ctx.workspaceId,
          externalProjectId: input.externalProjectId,
          externalProjectSlug: input.externalProjectSlug,
        },
        tx,
      );

      const rows = await monitorConnectionRepository.listForProject(projectId, tx);
      const created = rows.find((row) => row.externalProjectId === input.externalProjectId);
      if (!created) throw new MonitorConnectionNotFoundError(input.externalProjectId);
      return toMonitorConnectionDto(created);
    });
  },

  /**
   * Remove one binding, and the GRANT with it when it was the last one.
   *
   * ⚠️ "NO ORPHANED ROW" IS WHY THE GRANT GOES TOO. The credential lives on the
   * grant, so a grant with no bindings is a stored secret nothing can reach and
   * nothing will ever rotate — which is worse than an orphaned row, it is an
   * orphaned CREDENTIAL. Its remaining `monitor_connection` rows (there are none
   * by then) cascade with it.
   */
  async disconnect(
    projectId: string,
    connectionId: string,
    ctx: ServiceContext,
  ): Promise<{ removedGrant: boolean }> {
    return inProject(projectId, ctx, async (tx) => {
      const existing = await monitorConnectionRepository.findById(connectionId, tx);
      // RLS has already scoped the read, so a row in another workspace is
      // indistinguishable from one that does not exist — the no-existence-leak
      // posture every project-scoped service here keeps.
      if (!existing || existing.projectId !== projectId) {
        throw new MonitorConnectionNotFoundError(connectionId);
      }

      await monitorConnectionRepository.deleteById(connectionId, tx);
      const remaining = await monitorConnectionRepository.countForInstallation(
        existing.installationId,
        tx,
      );
      if (remaining > 0) return { removedGrant: false };

      await monitorInstallationRepository.deleteById(existing.installationId, tx);
      return { removedGrant: true };
    });
  },
};

export { MonitorProviderCallError };
