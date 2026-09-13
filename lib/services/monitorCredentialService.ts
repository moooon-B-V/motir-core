import type { Prisma } from '@/generated/prisma/client';
import { getMonitorProvider } from '@/lib/monitors';
import { MonitorGrantNotFoundError, MonitorProviderCallError } from '@/lib/monitors/errors';
import { readOrgSlug } from '@/lib/mappers/monitorMappers';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext } from '@/lib/workspaces/context';

// The monitor CREDENTIAL LIFECYCLE (Story MOTIR-4926 · Subtask MOTIR-5261) —
// the refresh that keeps a grant usable past eight hours, the on-demand health
// probe, and the stored `degraded` verdict.
//
// ⚠️ WHY THIS CARD EXISTS AT ALL. A Sentry public-integration token expires
// every eight hours, so a connection made by MOTIR-5260 and left alone stops
// working before the next working day. Shipping the connect flow without this
// would look complete in every test, demo perfectly, and be broken by morning —
// which is the failure shape the whole epic answers.
//
// ⚠️ ON DEMAND, NOT ON A SCHEDULE, AND THAT IS A BOUNDARY RATHER THAN AN
// OMISSION. Every schedule in this story belongs to MOTIR-4929, which owns the
// poll and everything it writes. So the probe runs when the room loads a
// connection and when a person presses re-check, and the STORED verdict is what
// the room reads in between. Nothing here defines a job, and
// `tests/integration/monitors/monitorCredential.test.ts` asserts that as a fact
// about the filesystem rather than leaving it to this comment.
//
// ⚠️ AND IT WRITES A VERDICT RATHER THAN RAISING AN ALARM. No email, no
// notification row. MOTIR-4918 measured an alert that WAS delivered and read and
// still created no obligation; the answer is that the state is visible where a
// person looks, not that one more message is sent.

/**
 * How long before a stated expiry a credential is treated as already expired.
 *
 * A token that expires in twenty seconds is useless to a call that takes ten:
 * the skew is what stops a refresh being skipped by a clock that is technically
 * right. Mirrors the same constant in the GitLab connection path.
 */
export const MONITOR_EXPIRY_SKEW_MS = 60_000;

/** What a caller gets to make one provider call with. */
export interface MonitorAccessToken {
  installationRowId: string;
  provider: string;
  orgSlug: string | null;
  token: string;
  expiresAt: Date;
}

/** Persist a `degraded` verdict carrying the PROVIDER'S OWN reason.
 *
 *  ⚠️ THE REASON IS PASSED THROUGH VERBATIM. A Motir-authored summary ("the
 *  connection failed") is a sentence nobody can act on; the provider's own words
 *  tell a person whether to re-authorise, restore a deleted integration, or wait.
 *  MOTIR-4918 is why this is load-bearing rather than cosmetic. */
async function writeDegraded(
  installationRowId: string,
  providerReason: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await monitorInstallationRepository.updateHealth(
    installationRowId,
    { health: 'degraded', healthReason: providerReason, healthCheckedAt: new Date() },
    tx,
  );
}

/**
 * What one locked read-decide-write produced. A DISCRIMINATED RESULT rather than
 * a thrown error, and that is the whole shape of the fix below.
 *
 * ⚠️ THROWING OUT OF THE TRANSACTION ROLLS THE VERDICT BACK. The first draft
 * wrote `degraded` under the same lock and then re-threw the provider's error —
 * and `$transaction` discarded the write on the way out, so the connection that
 * had just been refused still read `connected`. Its own two tests caught it: the
 * service returned exactly the right error and the row said nothing had
 * happened. So the refusal LEAVES the transaction as a value, and the verdict is
 * committed by a second one.
 *
 * That second write is deliberately NOT under the lock, and does not need to be:
 * the lock exists to stop two callers spending one rotating refresh token, and a
 * health verdict is a fact about the answer that came back rather than a write
 * derived from a row somebody else may be changing.
 */
type RefreshOutcome =
  | { kind: 'ok'; credential: MonitorAccessToken }
  | {
      kind: 'refused';
      installationRowId: string;
      provider: string;
      reason: string;
      error: unknown;
    };

/**
 * Lock the grant, decide, and refresh if needed — holding the lock ACROSS the
 * provider call.
 *
 * `force` skips the expiry check, for the one case where a stored token looks
 * fresh and has been refused anyway.
 */
async function refreshUnderLock(
  installationRowId: string,
  { force }: { force: boolean },
): Promise<RefreshOutcome> {
  return withSystemContext(async (tx) => {
    await monitorInstallationRepository.lockById(installationRowId, tx);
    const grant = await monitorInstallationRepository.findCredentialById(installationRowId, tx);
    if (!grant) throw new MonitorGrantNotFoundError(installationRowId);

    const orgSlug = readOrgSlug(grant.metadata);

    // The common path, and the one the LOSER of a race lands on: a stored token
    // that is still good. No provider call at all — which is the observable
    // consequence the concurrency test asserts.
    if (!force && grant.tokenExpiresAt.getTime() - MONITOR_EXPIRY_SKEW_MS > Date.now()) {
      return {
        kind: 'ok',
        credential: {
          installationRowId: grant.id,
          provider: grant.provider,
          orgSlug,
          token: decryptToken(grant.accessTokenEncrypted),
          expiresAt: grant.tokenExpiresAt,
        },
      };
    }

    const provider = getMonitorProvider(grant.provider);
    let refreshed;
    try {
      refreshed = await provider.refreshCredential({
        installationId: grant.installationId,
        refreshToken: decryptToken(grant.refreshTokenEncrypted),
      });
    } catch (error) {
      // A refusal here is the customer having revoked the integration far more
      // often than it is an outage, and either way the connection is not usable.
      return {
        kind: 'refused',
        installationRowId: grant.id,
        provider: grant.provider,
        reason:
          error instanceof MonitorProviderCallError ? error.providerReason : 'The refresh failed.',
        error,
      };
    }

    const updated = await monitorInstallationRepository.updateTokens(
      grant.id,
      {
        accessTokenEncrypted: encryptToken(refreshed.accessToken),
        refreshTokenEncrypted: encryptToken(refreshed.refreshToken),
        tokenExpiresAt: refreshed.expiresAt,
      },
      tx,
    );
    // A successful refresh is also evidence of HEALTH, so the terminal value of
    // the lifecycle is written here rather than left showing a stale failure — a
    // re-authorised connection that keeps reading `degraded` is the same silent
    // wrongness one polarity over.
    await monitorInstallationRepository.updateHealth(
      grant.id,
      { health: 'connected', healthReason: null, healthCheckedAt: new Date() },
      tx,
    );

    return {
      kind: 'ok',
      credential: {
        installationRowId: grant.id,
        provider: grant.provider,
        orgSlug,
        token: refreshed.accessToken,
        expiresAt: updated.tokenExpiresAt,
      },
    };
  });
}

/** Hand back the credential, or COMMIT the verdict and then throw. */
async function settle(outcome: RefreshOutcome): Promise<MonitorAccessToken> {
  if (outcome.kind === 'ok') return outcome.credential;

  await withSystemContext((tx) => writeDegraded(outcome.installationRowId, outcome.reason, tx));
  // ⚠️ THE LOG LINE CARRIES THE REASON AND NO CREDENTIAL. The error path is where
  // a token usually escapes — the happy path has nobody printing anything — so
  // the fields are named explicitly rather than spread from the row.
  console.warn('[monitorCredentialService] refresh refused; connection marked degraded', {
    installationRowId: outcome.installationRowId,
    provider: outcome.provider,
    providerReason: outcome.reason,
  });
  throw outcome.error;
}

export const monitorCredentialService = {
  /**
   * A USABLE access token for one grant — refreshing under a row lock when the
   * stored one is expired or nearly so.
   *
   * ⚠️ THE LOCK IS HELD ACROSS THE REFRESH HTTP CALL, DELIBERATELY, and this is
   * not the usual benign race. The provider ROTATES the refresh token on every
   * refresh, so a second concurrent refresh spending the same stored refresh
   * token either fails or invalidates the pair the first one just persisted — a
   * connection broken by nothing but two page loads arriving together. So a
   * concurrent caller BLOCKS on the lock, then re-reads and finds a credential
   * that is now fresh, and performs NO second refresh.
   *
   * That last clause is the observable part, which is what makes it testable at
   * all: "it is locked" is unobservable, "exactly one provider call is made and
   * the loser proceeds with the winner's token" is not.
   *
   * SYSTEM context, like the GitLab token mint: a refresh is a trusted operation
   * that a webhook, a poll or a page load may all reach, and the workspace is
   * discovered FROM the row rather than supplied by the caller.
   */
  async getAccessToken(installationRowId: string): Promise<MonitorAccessToken> {
    const outcome = await refreshUnderLock(installationRowId, { force: false });
    return settle(outcome);
  },

  /**
   * Run `fn` with a usable token, refreshing ONCE and retrying ONCE on a 401.
   *
   * ⚠️ ONCE, AND THE COUNT IS THE POINT. A credential believed fresh can still
   * be refused — the customer revoked it inside the window, or the provider
   * rotated it out of band — and the right answer is one refresh and one retry.
   * A loop is the failure this bounds: each attempt spends a refresh token, and a
   * provider that keeps answering 401 would be handed the whole chain. The second
   * 401 surfaces as a typed error and writes `degraded`.
   */
  async withFreshCredential<T>(
    installationRowId: string,
    fn: (credential: MonitorAccessToken) => Promise<T>,
  ): Promise<T> {
    const first = await monitorCredentialService.getAccessToken(installationRowId);
    try {
      return await fn(first);
    } catch (err) {
      if (!(err instanceof MonitorProviderCallError) || err.status !== 401) throw err;

      // Force the refresh the expiry check would have skipped: the stored token
      // LOOKS fresh and is not, which is the only case this arm exists for.
      const refreshed = await monitorCredentialService.forceRefresh(installationRowId);
      try {
        return await fn(refreshed);
      } catch (retryErr) {
        if (retryErr instanceof MonitorProviderCallError) {
          await withSystemContext((tx) =>
            writeDegraded(installationRowId, retryErr.providerReason, tx),
          );
        }
        throw retryErr;
      }
    }
  },

  /**
   * Refresh REGARDLESS of the stored expiry, under the same lock.
   *
   * Separate from {@link getAccessToken} rather than a flag on it, because the
   * two answer different questions — "give me something usable" and "the thing
   * you gave me was refused" — and a boolean parameter would let the second
   * case be reached by accident from the first.
   */
  async forceRefresh(installationRowId: string): Promise<MonitorAccessToken> {
    const outcome = await refreshUnderLock(installationRowId, { force: true });
    return settle(outcome);
  },

  /**
   * PROBE the connection now, and persist what the provider says.
   *
   * The method the settings room calls on load and on re-check — and the only
   * door into the probe, which is what keeps the no-schedule boundary honest:
   * there is nothing for a job to call.
   *
   * It asserts `integration:manage`, because a probe spends a provider call and
   * writes a row.
   */
  async probeHealth(
    projectId: string,
    installationRowId: string,
    ctx: ServiceContext,
  ): Promise<{ health: string; healthReason: string | null; healthCheckedAt: Date }> {
    await projectAccessService.assertPermission(projectId, ctx, 'integration:manage');

    // The refresh comes FIRST: probing with an expired token would report
    // `degraded` on a connection that is merely stale, which is the false
    // negative that would teach people to ignore the badge.
    let credential: MonitorAccessToken;
    try {
      credential = await monitorCredentialService.getAccessToken(installationRowId);
    } catch (err) {
      if (err instanceof MonitorProviderCallError) {
        // `getAccessToken` has already written the verdict under its own lock;
        // read it back rather than writing a second, so the stored value and the
        // returned one cannot disagree.
        const row = await withSystemContext((tx) =>
          monitorInstallationRepository.findCredentialById(installationRowId, tx),
        );
        /* v8 ignore next 5 -- the fallbacks are unreachable: the refused refresh
           writes all three fields before it throws. Asserted by
           `monitorStorySeams.test.ts` › "a refused refresh has written all three
           health fields before probeHealth reads them back". */
        return {
          health: row?.health ?? 'degraded',
          healthReason: row?.healthReason ?? err.providerReason,
          healthCheckedAt: row?.healthCheckedAt ?? new Date(),
        };
      }
      throw err;
    }

    const provider = getMonitorProvider(credential.provider);
    // `describeHealth` returns a VERDICT and does not throw (the seam's own
    // contract), so there is no catch here: an unhealthy answer is a value.
    const verdict = await provider.describeHealth({
      accessToken: credential.token,
      orgSlug: credential.orgSlug ?? '',
    });

    await withSystemContext((tx) =>
      monitorInstallationRepository.updateHealth(
        installationRowId,
        {
          health: verdict.status,
          healthReason: verdict.reason,
          healthCheckedAt: verdict.checkedAt,
        },
        tx,
      ),
    );

    return {
      health: verdict.status,
      healthReason: verdict.reason,
      healthCheckedAt: verdict.checkedAt,
    };
  },
};
