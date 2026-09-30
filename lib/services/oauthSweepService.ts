import { withSystemContext } from '@/lib/workspaces/context';
import { verificationRepository } from '@/lib/repositories/verificationRepository';
import { oauthAccessTokenRepository } from '@/lib/repositories/oauthAccessTokenRepository';
import { oauthRefreshTokenRepository } from '@/lib/repositories/oauthRefreshTokenRepository';
import { oauthClientRepository } from '@/lib/repositories/oauthClientRepository';

// The OAuth sweep (Story MOTIR-6973 · Subtask MOTIR-6984) — removes the rows the
// authorization server leaves behind that nothing can use any more. The provider
// deletes a code when it is redeemed and a token when it is revoked, but an
// abandoned authorization, an expired token and a client that registered and
// never got anyone's consent all stay for ever. Registration is open to anyone,
// so the last of those is the one that grows without bound.
//
// Four bounded deletes, in an order that lets the cascades do their share first:
// refresh tokens (which take their access tokens), access tokens, authorization
// codes, then unconnected clients older than {@link OAUTH_CLIENT_UNUSED_DAYS}.
// Every predicate is on the row's own expiry or age, so a repeated run finds
// nothing left, a missed run is caught up by the next, and no run-level state is
// kept. Each kind is capped per run (batch × max batches), so a backlog drains
// over several days instead of holding a long lock.
//
// SYSTEM CONTEXT, and not only for tidiness: the client delete's "has no
// connection" test reads `api_token`, whose RLS hides every row from a caller
// with no user — which would make every client look unconnected.

/** A dynamically registered client with no connection is pruned after this long. */
export const OAUTH_CLIENT_UNUSED_DAYS = 30;
export const OAUTH_SWEEP_BATCH_SIZE = 1_000;
export const OAUTH_SWEEP_MAX_BATCHES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OAuthSweepResult {
  refreshTokens: number;
  accessTokens: number;
  authorizationCodes: number;
  clients: number;
}

/** Run one bounded delete in batches until a short batch or the per-run cap.
 * `removeBatch` opens its own system-context transaction, naming its repository
 * method at the call, so the RLS guard reads each one. */
async function drain(removeBatch: () => Promise<number>, batchSize: number): Promise<number> {
  let deleted = 0;
  for (let pass = 0; pass < OAUTH_SWEEP_MAX_BATCHES; pass += 1) {
    const removed = await removeBatch();
    deleted += removed;
    if (removed < batchSize) break;
  }
  return deleted;
}

export const oauthSweepService = {
  /** `batchSize` is a parameter only so a test can reach the cap without
   * writing thousands of rows; the job never passes it. */
  async sweep(
    now: Date = new Date(),
    batchSize: number = OAUTH_SWEEP_BATCH_SIZE,
  ): Promise<OAuthSweepResult> {
    const refreshTokens = await drain(
      () =>
        withSystemContext((tx) => oauthRefreshTokenRepository.deleteUnusable(now, batchSize, tx)),
      batchSize,
    );
    const accessTokens = await drain(
      () =>
        withSystemContext((tx) => oauthAccessTokenRepository.deleteUnusable(now, batchSize, tx)),
      batchSize,
    );
    const authorizationCodes = await drain(
      () =>
        withSystemContext((tx) =>
          verificationRepository.deleteExpiredAuthorizationCodes(now, batchSize, tx),
        ),
      batchSize,
    );
    const clientCutoff = new Date(now.getTime() - OAUTH_CLIENT_UNUSED_DAYS * DAY_MS);
    const clients = await drain(
      () =>
        withSystemContext((tx) =>
          oauthClientRepository.deleteUnconnectedBefore(clientCutoff, batchSize, tx),
        ),
      batchSize,
    );
    return { refreshTokens, accessTokens, authorizationCodes, clients };
  },
};
