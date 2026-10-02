// THE DECLARED CREDENTIAL REGISTRY (MOTIR-1933) — every platform credential
// whose lapse would go silent, with the date it lapses on.
//
// ⚠️ EXPIRY IS DECLARED, NOT DISCOVERED. Neither a GitHub fine-grained token nor
// a Fly org token exposes its own expiry to the bearer in a way motir-core can
// read without a further privileged call, and that call would itself need a
// credential to watch. So the date lives HERE, typed by whoever minted the
// token, and a declared date can drift from the real one: a token re-minted
// early, or with a different lifetime, is wrong here until somebody edits this
// file. That is why every entry cites the card or comment that minted it
// (`source`) — the date is only as good as that record, and a reader checking it
// has to know where to look.
//
// ⚠️ WHY THIS EXISTS. When `GITHUB_BILLING_TOKEN` lapses, `billingUsageToken()`
// (`lib/ciMetering/config.ts`) still returns it — the variable is still SET — so
// `system.ci-minutes-reconcile` keeps calling GitHub with a token GitHub refuses,
// and the audit that falsifies meter drift stops with nothing going red. `system.daily-health-check` reads this registry every morning and
// fails, naming the credential, thirty days before that happens.
//
// ADDING A CREDENTIAL is one entry here and nothing else: the probe
// (`credentialExpiryProbe.ts`) iterates the registry and knows no names. Each
// later credential is registered by the card that introduces it — 10.2.4b
// (MOTIR-7332) does so for `FLY_DEPLOYMENT_READ_TOKEN`. A credential that does
// not expire (`SENTRY_READ_TOKEN`, MOTIR-739) is not registered at all.

/** One credential whose expiry is watched by the daily health check. */
export interface DeclaredCredential {
  /** The environment variable the credential is read from. A probe reports the NAME, never the value. */
  readonly envVar: string;
  /** What a human calls it, for the DLQ row. */
  readonly name: string;
  /** The day it lapses, as an ISO date (`YYYY-MM-DD`), read as 00:00 UTC on that day. */
  readonly expiresAt: string;
  /** Days ahead of `expiresAt` at which the probe starts failing. Defaults to {@link LEAD_TIME_DAYS}. */
  readonly leadTimeDays?: number;
  /** What the operator renews, and where — the sentence the DLQ row ends on. */
  readonly renewal: string;
  /** The card or comment that minted it, which is where `expiresAt` came from. */
  readonly source: string;
}

/**
 * How many days ahead of a declared expiry the daily health check starts
 * failing: **30**.
 *
 * Renewing either credential this registry exists for is a `manual` card — a
 * person mints a fine-grained GitHub token or a Fly org token in a dashboard,
 * sets it with `fly secrets set`, and confirms it on the card. That is minutes of
 * work, but it waits on a person reading the alert, picking the card up and
 * having the org-owner role, across weekends and leave. Thirty days covers a
 * missed fortnight with time to spare; a week would not survive one holiday, and
 * a quarter would leave the check red for so long that people learn to read past
 * it — the way MOTIR-3606 sat red for 23 days.
 */
export const LEAD_TIME_DAYS = 30;

/** The credentials the daily health check watches. */
export const CREDENTIAL_REGISTRY: readonly DeclaredCredential[] = [
  {
    envVar: 'GITHUB_BILLING_TOKEN',
    name: 'GitHub billing usage token (the CI-minutes reconciliation audit)',
    expiresAt: '2027-07-31',
    renewal:
      'mint a replacement fine-grained token the way MOTIR-1908 did, then ' +
      "`fly secrets set GITHUB_BILLING_TOKEN=… -a motir-core` and move this entry's expiresAt",
    source: 'MOTIR-1908, the manual card that minted it (expiry as recorded on MOTIR-1933)',
  },
];
