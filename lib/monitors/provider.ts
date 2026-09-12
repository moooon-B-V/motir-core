import type {
  MonitorCredential,
  MonitorProviderId,
  NormalizedMonitorHealth,
  NormalizedMonitorIssuePage,
  NormalizedMonitorProject,
} from './types';

// The MonitorProvider seam (Story MOTIR-4926 · MOTIR-5259). ONE interface every
// error monitor implements; consumers dispatch by the stored `provider`
// discriminator through the registry (`lib/monitors/registry.ts`) and hold NO
// host-specific types. Sentry is the FIRST — and today the only — registered
// implementation (`lib/monitors/providers/sentry.ts`).
//
// ⚠️ THE INTERFACE IS DEFINED ALONGSIDE ITS FIRST IMPLEMENTATION, not in a
// vacuum (the MOTIR-1566 planning lesson, which `lib/git/provider.ts` states in
// the same words one seam over). Every method below is one SENTRY ACTUALLY
// BACKS, with the endpoint named on it. There is no speculative capability here
// and no second provider.
//
// ⚠️ TWO METHODS SHIP WITH NO PRODUCTION CALLER, AND THAT IS A DECISION RATHER
// THAN DEAD CODE. `listIssuesSince` is consumed by the reconciling poll in
// MOTIR-4929, and `resolveIssue` by the resolve-back sync in MOTIR-4931 —
// neither of which exists yet. Both are exercised here by this card's own tests
// and by the fake. Defining the whole seam once, against one real
// implementation, is cheaper and more honest than growing it a method at a time
// across three stories; the two consuming stories are named so a later reader
// does not delete them as unreachable.
//
// ⚠️ AND EVERY ENDPOINT NAMED BELOW IS A DOCUMENTED EXPECTATION, NOT A READ.
// This code cannot reach sentry.io — the suite is required not to — so each
// path, parameter and response field comes from Sentry's integration-platform
// documentation as of 2026-09-12 and from the work item that pinned it. A
// PROVISIONING card (MOTIR-5257) is what confronts the real dashboard, and
// MOTIR-4941 owns the deployed round trip. If a path turns out to differ,
// that is one adapter file to change and no consumer.
// https://docs.sentry.io/organization/integrations/integration-platform/public-integration/

/**
 * Deadline for the GRANT EXCHANGE, in ms.
 *
 * It bounds the one call a person is waiting on inside an OAuth callback: the
 * browser is parked on Motir's redirect until this resolves, so a dead provider
 * has to surface as a named refusal on the settings surface rather than as a
 * gateway timeout with no body. Named rather than inlined, mirroring
 * `REPO_FILE_READ_TIMEOUT_MS` / `COMMIT_COMPARE_TIMEOUT_MS`, so the bound is
 * greppable and a route's `maxDuration` can be read against it.
 */
export const MONITOR_GRANT_EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Deadline for the verify-install PUT, in ms. The same callback is waiting on
 * it, and it happens after the exchange — so the two together must still fit
 * inside the route's budget, which is why this is the smaller number.
 */
export const MONITOR_VERIFY_INSTALL_TIMEOUT_MS = 5_000;

/**
 * Deadline for a token REFRESH, in ms. Longer than the interactive bounds above
 * because nobody is watching: it runs on the eight-hourly sweep
 * (MOTIR-5261), where a slow answer still beats a connection going
 * `degraded` for no reason. It is a bound and not a budget — a hung host must
 * not hold a job open indefinitely.
 */
export const MONITOR_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Deadline for a HEALTH probe, in ms. The tightest of the set, and deliberately:
 * the probe's whole job is to answer "does this credential still work?", and a
 * provider slow enough to exceed this IS a degraded connection as far as a
 * person reading the settings room is concerned.
 */
export const MONITOR_HEALTH_TIMEOUT_MS = 5_000;

/** Deadline for the project LIST a person picks from, in ms — an interactive
 *  read, bounded like the exchange it follows. */
export const MONITOR_LIST_PROJECTS_TIMEOUT_MS = 10_000;

/** Deadline for ONE PAGE of issues, in ms. The poll (MOTIR-4929) pages, so this
 *  bounds a page and never the sweep. */
export const MONITOR_LIST_ISSUES_TIMEOUT_MS = 15_000;

/** Deadline for a resolve-back write, in ms (MOTIR-4931's consumer). */
export const MONITOR_RESOLVE_ISSUE_TIMEOUT_MS = 10_000;

/**
 * ONE error monitor, as Motir talks to it.
 *
 * ⚠️ IT IS A PURE ADAPTER. Every method takes what it needs and returns a
 * normalized value; NOTHING here touches a Prisma client, a repository or a
 * transaction. That is the same split `GitProvider` ↔ `gitlabConnectionService`
 * has, it is the layering `CLAUDE.md` requires (the adapter below the service,
 * not beside it), and it is why this card carries no dependency edge to the
 * schema card: the two are genuinely parallel.
 *
 * A non-2xx from the provider becomes a typed error that CARRIES THE PROVIDER'S
 * OWN REASON STRING. The credential-lifecycle card surfaces that string to a
 * person, so it may not be swallowed or re-worded here.
 */
export interface MonitorProvider {
  readonly id: MonitorProviderId;

  /**
   * Turn the authorisation code from the install redirect into a stored
   * credential.
   *
   * `POST /api/0/sentry-app-installations/{installationId}/authorizations/`
   * with `grant_type: 'authorization_code'`.
   *
   * Bounded by {@link MONITOR_GRANT_EXCHANGE_TIMEOUT_MS}. Consumed by the
   * CONNECT card (MOTIR-5260).
   */
  exchangeGrant(input: { installationId: string; code: string }): Promise<MonitorCredential>;

  /**
   * Tell the provider the install is complete, so it leaves its pending state.
   *
   * `PUT /api/0/sentry-app-installations/{installationId}/` with
   * `{ status: 'installed' }`.
   *
   * Bounded by {@link MONITOR_VERIFY_INSTALL_TIMEOUT_MS}. Consumed by the
   * CONNECT card (MOTIR-5260) immediately after the exchange — an installation
   * left unverified is one the provider may reap.
   */
  verifyInstall(input: { installationId: string; accessToken: string }): Promise<void>;

  /**
   * Mint the next credential from the stored refresh token.
   *
   * The SAME authorizations endpoint as {@link exchangeGrant}, with
   * `grant_type: 'refresh_token'`.
   *
   * Bounded by {@link MONITOR_REFRESH_TIMEOUT_MS}. Consumed by the
   * credential-lifecycle card (MOTIR-5261), which serializes concurrent mints on
   * a row lock — the provider rotates the refresh token, so two unserialized
   * refreshes invalidate the newer one.
   */
  refreshCredential(input: {
    installationId: string;
    refreshToken: string;
  }): Promise<MonitorCredential>;

  /**
   * A cheap authenticated read that proves the credential still works.
   *
   * `GET /api/0/organizations/{orgSlug}/` — the smallest authenticated response
   * the grant can ask for. A 401/403 is the `degraded` answer WITH the
   * provider's reason; any other failure is also `degraded`, because a probe
   * that cannot reach the provider has not established health.
   *
   * ⚠️ IT RETURNS A VERDICT AND DOES NOT THROW ON AN UNHEALTHY ONE. `degraded`
   * is the fact this epic exists to make visible (MOTIR-4918), so it is a value
   * to store and render rather than an exception to handle — a probe whose
   * failure path is a throw is a probe whose answer gets logged and lost.
   *
   * Bounded by {@link MONITOR_HEALTH_TIMEOUT_MS}. Consumed by the
   * credential-lifecycle card (MOTIR-5261).
   */
  describeHealth(input: { accessToken: string; orgSlug: string }): Promise<NormalizedMonitorHealth>;

  /**
   * The organisation's projects, so a person can choose which to bind.
   *
   * `GET /api/0/organizations/{orgSlug}/projects/`.
   *
   * Bounded by {@link MONITOR_LIST_PROJECTS_TIMEOUT_MS}. Consumed by the CONNECT
   * card (MOTIR-5260).
   */
  listProjects(input: {
    accessToken: string;
    orgSlug: string;
  }): Promise<NormalizedMonitorProject[]>;

  /**
   * One page of issues seen since a cursor.
   *
   * `GET /api/0/projects/{orgSlug}/{projectSlug}/issues/` with the provider's
   * own cursor parameter.
   *
   * ⚠️ NO PRODUCTION CALLER YET — MOTIR-4929's reconciling poll is the consumer,
   * and it owns the cursor's storage. This seam hands back the next cursor and
   * remembers nothing.
   *
   * Bounded by {@link MONITOR_LIST_ISSUES_TIMEOUT_MS}.
   */
  listIssuesSince(input: {
    accessToken: string;
    orgSlug: string;
    projectSlug: string;
    cursor: string | null;
  }): Promise<NormalizedMonitorIssuePage>;

  /**
   * Mark an issue resolved on the provider — the write that closes the loop when
   * a Motir bug is fixed.
   *
   * `PUT /api/0/issues/{issueId}/` with `{ status: 'resolved' }`.
   *
   * ⚠️ NO PRODUCTION CALLER YET — MOTIR-4931's resolve-back sync is the consumer.
   *
   * Bounded by {@link MONITOR_RESOLVE_ISSUE_TIMEOUT_MS}.
   */
  resolveIssue(input: { accessToken: string; externalIssueId: string }): Promise<void>;
}
