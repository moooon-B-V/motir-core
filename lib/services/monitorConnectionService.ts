import type { Prisma } from '@/generated/prisma/client';
import type {
  AvailableMonitorProjectDto,
  BindMonitorProjectInput,
  MonitorConnectionDto,
  MonitorConnectionViewDto,
  SetMonitorSyncDirectionsInput,
} from '@/lib/dto/monitors';
import {
  readInstallPending,
  readOrgSlug,
  toMonitorConnectionDto,
} from '@/lib/mappers/monitorMappers';
import { getMonitorProvider } from '@/lib/monitors';
import { isLowerThan, isMonitorLevel } from '@/lib/monitors/levels';
import {
  InvalidMonitorLevelError,
  InvalidMonitorSyncDirectionError,
  MonitorConnectionNotFoundError,
  MonitorGrantNotFoundError,
  MonitorProviderCallError,
} from '@/lib/monitors/errors';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
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
/** The switches a body carries, validated: each supplied key must be a boolean,
 *  and at least one must be supplied. Anything else is
 *  {@link InvalidMonitorSyncDirectionError}. */
function readSyncDirections(input: unknown): SetMonitorSyncDirectionsInput {
  if (typeof input !== 'object' || input === null) {
    throw new InvalidMonitorSyncDirectionError(input);
  }
  const body = input as Record<string, unknown>;
  const out: SetMonitorSyncDirectionsInput = {};
  for (const key of ['resolveOnDone', 'syncAssignee'] as const) {
    if (!(key in body) || body[key] === undefined) continue;
    const value = body[key];
    if (typeof value !== 'boolean') throw new InvalidMonitorSyncDirectionError(value);
    out[key] = value;
  }
  if (out.resolveOnDone === undefined && out.syncAssignee === undefined) {
    throw new InvalidMonitorSyncDirectionError(input);
  }
  return out;
}

/** Lock ONE binding of THIS project, or refuse with a not-found — a binding in
 *  another project (or, through RLS, another workspace) is indistinguishable
 *  from one that does not exist. */
async function lockOwnBinding(
  projectId: string,
  connectionId: string,
  tx: Prisma.TransactionClient,
): Promise<{ minimumLevel: string | null }> {
  await monitorConnectionRepository.lockById(connectionId, tx);
  const existing = await monitorConnectionRepository.findById(connectionId, tx);
  if (!existing || existing.projectId !== projectId) {
    throw new MonitorConnectionNotFoundError(connectionId);
  }
  return existing;
}

/** The binding as the room renders it, re-read inside the write's transaction. */
async function bindingDto(
  projectId: string,
  connectionId: string,
  tx: Prisma.TransactionClient,
): Promise<MonitorConnectionDto> {
  const rows = await monitorConnectionRepository.listForProject(projectId, tx);
  const updated = rows.find((row) => row.id === connectionId);
  /* v8 ignore next -- unreachable: the row was locked and written in this
     transaction, under the same binding. */
  if (!updated) throw new MonitorConnectionNotFoundError(connectionId);
  return toMonitorConnectionDto(updated);
}

async function inProject<T>(
  projectId: string,
  ctx: ServiceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId }, fn);
}

/**
 * A fresh grant for an organisation SUPERSEDES the workspace's older grants for
 * it (MOTIR-6005): their bindings move onto the fresh grant, and each older grant
 * left with no binding is deleted.
 *
 * ⚠️ WHY A RECONNECT NEEDS THIS AT ALL. A Sentry integration cannot be
 * re-authorised while installed, so the only recovery from a dead credential is
 * uninstall → reinstall — and the reinstall arrives under a NEW provider
 * installation id, which the upsert above stores as a second row. Without this,
 * the bindings (and the room, which shows the oldest grant) stay on the dead one.
 *
 * ⚠️ IT MOVES, IT NEVER RE-CREATES. A binding's `monitor_issue` links hang off
 * the binding, so moving the row keeps them; deleting and re-binding would drop
 * them and the next poll would file every live issue as a duplicate bug.
 *
 * A binding the fresh grant ALREADY holds for the same (project, monitored
 * project) is left where it is rather than colliding with the unique index, and
 * its grant is then kept — nothing here deletes a binding.
 */
async function adoptSupersededGrants(
  args: { workspaceId: string; provider: string; orgSlug: string; grantId: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const supersededIds = await monitorInstallationRepository.listOtherIdsForOrg(
    {
      workspaceId: args.workspaceId,
      provider: args.provider,
      orgSlug: args.orgSlug,
      excludeId: args.grantId,
    },
    tx,
  );
  if (supersededIds.length === 0) return;

  const held = new Set(
    (await monitorConnectionRepository.listPairsForInstallation(args.grantId, tx)).map(
      (c) => `${c.projectId}\u0000${c.externalProjectId}`,
    ),
  );
  for (const oldId of supersededIds) {
    const pairs = await monitorConnectionRepository.listPairsForInstallation(oldId, tx);
    const movable = pairs.filter((c) => !held.has(`${c.projectId}\u0000${c.externalProjectId}`));
    await monitorConnectionRepository.moveToInstallation(
      movable.map((c) => c.id),
      args.grantId,
      tx,
    );
    for (const c of movable) held.add(`${c.projectId}\u0000${c.externalProjectId}`);
    if ((await monitorConnectionRepository.countForInstallation(oldId, tx)) === 0) {
      await monitorInstallationRepository.deleteById(oldId, tx);
    }
  }
}

/**
 * The two calls that FINISH an install once its grant is stored (MOTIR-6008):
 * verify it, so the provider leaves its pending state and does not reap it,
 * then read which organisation it belongs to — the slug every org-scoped call
 * needs and the install redirect does not carry. On success the organisation is
 * recorded, the pending marker is cleared, and the grant supersedes any older
 * grant for the same organisation (MOTIR-6005).
 *
 * Both calls stay OUTSIDE the transaction: network round trips are not held
 * across one. A provider refusal propagates for the caller to keep the grant
 * pending.
 */
async function finishInstall(
  args: { grantId: string; provider: string; providerInstallationId: string; accessToken: string },
  scope: { userId: string; workspaceId: string; projectId: string },
): Promise<string | null> {
  const provider = getMonitorProvider(args.provider);
  await provider.verifyInstall({
    installationId: args.providerInstallationId,
    accessToken: args.accessToken,
  });
  const { orgSlug } = await provider.describeInstallation({
    installationId: args.providerInstallationId,
    accessToken: args.accessToken,
  });

  await withWorkspaceContext(scope, async (tx) => {
    await monitorInstallationRepository.setMetadata(args.grantId, orgSlug ? { orgSlug } : {}, tx);
    if (orgSlug) {
      await adoptSupersededGrants(
        {
          workspaceId: scope.workspaceId,
          provider: args.provider,
          orgSlug,
          grantId: args.grantId,
        },
        tx,
      );
    }
  });
  return orgSlug;
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

    // ⚠️ STORE THE GRANT THE MOMENT IT EXISTS (MOTIR-6008). The exchange spent
    // Sentry's SINGLE-USE grant code, so these tokens can never be asked for
    // again. The verify and the organisation read used to run first, and a slow
    // answer to either threw the credential away and left Sentry holding an
    // install Motir had nothing for — recoverable only by a person uninstalling
    // in Sentry. So the row is written now, marked `installPending`, and the two
    // follow-ups below finish it.
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
            metadata: { installPending: true },
          },
          tx,
        ),
    );

    // A follow-up that fails is NOT a failed connect: the grant is stored and
    // usable, and `completePendingInstall` retries the rest from the picker and
    // from Re-check. Only the provider's own refusal is absorbed here; anything
    // else is a defect and still throws.
    let orgSlug: string | null = null;
    try {
      orgSlug = await finishInstall(
        {
          grantId: installation.id,
          provider: input.provider,
          providerInstallationId: input.providerInstallationId,
          accessToken: credential.accessToken,
        },
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: input.projectId },
      );
    } catch (err) {
      if (!(err instanceof MonitorProviderCallError)) throw err;
      console.warn('[monitorConnectionService] grant stored; install follow-up deferred', {
        installationRowId: installation.id,
        providerReason: err.providerReason,
      });
    }

    return { installationId: installation.id, orgSlug };
  },

  /**
   * FINISH any grant stored before its install was verified (MOTIR-6008) — the
   * retry for a connect whose follow-up calls failed.
   *
   * Called where the missing piece is first needed: the project picker, which
   * cannot list a Sentry organisation it does not know, and Re-check. Returns
   * whether every pending grant was finished; a provider that is still slow
   * leaves the grant stored and pending for the next try, never deleted.
   */
  async completePendingInstall(projectId: string, ctx: ServiceContext): Promise<boolean> {
    await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');

    const pending = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) =>
      (await monitorInstallationRepository.listSummariesForWorkspace(ctx.workspaceId, tx)).filter(
        (grant) => readInstallPending(grant.metadata),
      ),
    );

    let allFinished = true;
    for (const grant of pending) {
      try {
        const credential = await monitorCredentialService.getAccessToken(grant.id);
        await finishInstall(
          {
            grantId: grant.id,
            provider: grant.provider,
            providerInstallationId: grant.installationId,
            accessToken: credential.token,
          },
          { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
        );
      } catch (err) {
        if (!(err instanceof MonitorProviderCallError)) throw err;
        allFinished = false;
        console.warn('[monitorConnectionService] install follow-up still failing', {
          installationRowId: grant.id,
          providerReason: err.providerReason,
        });
      }
    }
    return allFinished;
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
        healthCheckedAt: grant?.healthCheckedAt?.toISOString() ?? null,
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

    // A connect whose follow-ups failed left the organisation unknown, and the
    // picker cannot list an organisation it does not know — so finish it first
    // (MOTIR-6008). Still pending afterwards is not fatal here: the listing
    // below then fails with the provider's own reason, which the picker renders.
    await monitorConnectionService.completePendingInstall(projectId, ctx);

    const grant = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const grants = await monitorInstallationRepository.listSummariesForWorkspace(
        ctx.workspaceId,
        tx,
      );
      return grants[0] ?? null;
    });
    if (!grant) throw new MonitorGrantNotFoundError(ctx.workspaceId);

    // ⚠️ THE CREDENTIAL COMES THROUGH `getAccessToken`, NEVER STRAIGHT OFF THE ROW
    // (fixed under MOTIR-5263, the story's seam gate). This read used to decrypt
    // the stored access token itself, which skipped the expiry check: a token
    // past its eight-hour life was sent as-is, Sentry refused it, and the picker
    // reported a healthy grant as degraded until the next refresh sweep. The
    // credential service refreshes first, under its lock, and writes a real
    // refusal's verdict — so this read sees the same token every other caller
    // does. The plaintext is still reached one line before the call that needs
    // it and never returned.
    const credential = await monitorCredentialService.getAccessToken(grant.id);

    const provider = getMonitorProvider(credential.provider);
    const orgSlug = credential.orgSlug;
    const projects = await provider.listProjects({
      accessToken: credential.token,
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
          // WHOSE identity the reconciler files this binding's bugs as
          // (MOTIR-4929 · MOTIR-5576) — the person binding it, never a system
          // principal and never someone substituted later.
          boundByUserId: ctx.userId,
        },
        tx,
      );

      const rows = await monitorConnectionRepository.listForProject(projectId, tx);
      const created = rows.find((row) => row.externalProjectId === input.externalProjectId);
      /* v8 ignore next -- unreachable: the read-back runs in the write's own
         transaction and context. Asserted by `monitorStorySeams.test.ts` › "a bind
         reads back the row it created, inside the same transaction". */
      if (!created) throw new MonitorConnectionNotFoundError(input.externalProjectId);
      return toMonitorConnectionDto(created);
    });
  },

  /**
   * Set one binding's MINIMUM LEVEL — the one per-connection control over what
   * files a bug (Story MOTIR-4929 · Subtask MOTIR-5579).
   *
   * `null` means every level; anything else must be one of `MONITOR_LEVELS`, or
   * it is {@link InvalidMonitorLevelError} (400). A binding in another project —
   * or another workspace, which RLS makes the same answer — is
   * {@link MonitorConnectionNotFoundError} (404), with no existence leak.
   *
   * ⚠️ LOWERING REWINDS, RAISING DOES NOT. Lowering admits levels the poll has
   * already read past and skipped, so the watermark is reset to `null` and the
   * next poll re-reads everything last seen since the binding was made — dedup
   * on the provider's issue id is what makes that re-read safe. Raising admits
   * nothing new and never un-files what was filed.
   *
   * The decision reads the level it REPLACES, so the row is LOCKED first: two
   * concurrent changes must not both decide against the same stale value. The
   * poll's own watermark advance is a compare-and-set on the level it read, so a
   * lowering that lands mid-poll is not undone by that poll finishing.
   */
  async setMinimumLevel(
    projectId: string,
    connectionId: string,
    level: unknown,
    ctx: ServiceContext,
  ): Promise<MonitorConnectionDto> {
    return inProject(projectId, ctx, async (tx) => {
      if (level !== null && !isMonitorLevel(level)) throw new InvalidMonitorLevelError(level);
      const existing = await lockOwnBinding(projectId, connectionId, tx);
      const rewind = isLowerThan(level, existing.minimumLevel);
      await monitorConnectionRepository.setMinimumLevel(connectionId, level, rewind, tx);
      return bindingDto(projectId, connectionId, tx);
    });
  },

  /**
   * Set one binding's DIRECTION SWITCHES (Story MOTIR-4931 · Subtask MOTIR-5706)
   * — `resolveOnDone` (Motir → monitor) and `syncAssignee` (monitor → Motir).
   *
   * SPARSE: an omitted key is left unchanged. Each supplied key must be a
   * boolean, and at least one must be supplied — otherwise
   * {@link InvalidMonitorSyncDirectionError} (400). Same gate, same not-found
   * posture and same answer as {@link setMinimumLevel}: the room renders the
   * write's own DTO. The switches govern nothing here — RESOLVE BACK
   * (MOTIR-5703) and ASSIGNEE FROM THE MONITOR (MOTIR-5705) read the columns.
   */
  async setSyncDirections(
    projectId: string,
    connectionId: string,
    input: unknown,
    ctx: ServiceContext,
  ): Promise<MonitorConnectionDto> {
    return inProject(projectId, ctx, async (tx) => {
      const directions = readSyncDirections(input);
      await lockOwnBinding(projectId, connectionId, tx);
      await monitorConnectionRepository.setSyncDirections(connectionId, directions, tx);
      return bindingDto(projectId, connectionId, tx);
    });
  },

  /**
   * The connection PATCH (MOTIR-5579 + MOTIR-5706): any non-empty subset of
   * `minimumLevel`, `resolveOnDone`, `syncAssignee`, applied in ONE transaction
   * so a combined body is all-or-nothing.
   *
   * A body with none of the three keys is refused as an invalid LEVEL — the
   * answer the route gave before the switches existed, kept so a client that
   * sends `{}` still hears the same code.
   */
  async updateConnection(
    projectId: string,
    connectionId: string,
    body: unknown,
    ctx: ServiceContext,
  ): Promise<MonitorConnectionDto> {
    const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const hasLevel = 'minimumLevel' in fields;
    const hasSwitch = 'resolveOnDone' in fields || 'syncAssignee' in fields;
    if (!hasLevel && !hasSwitch) throw new InvalidMonitorLevelError(undefined);

    return inProject(projectId, ctx, async (tx) => {
      const level = fields['minimumLevel'];
      if (hasLevel && level !== null && !isMonitorLevel(level)) {
        throw new InvalidMonitorLevelError(level);
      }
      const directions = hasSwitch ? readSyncDirections(fields) : null;
      const existing = await lockOwnBinding(projectId, connectionId, tx);
      if (hasLevel) {
        const next = level as string | null;
        const rewind = isLowerThan(next, existing.minimumLevel);
        await monitorConnectionRepository.setMinimumLevel(connectionId, next, rewind, tx);
      }
      if (directions) {
        await monitorConnectionRepository.setSyncDirections(connectionId, directions, tx);
      }
      return bindingDto(projectId, connectionId, tx);
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
