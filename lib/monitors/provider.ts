import type {
  MonitorCredential,
  MonitorProviderId,
  NormalizedMonitorHealth,
  NormalizedMonitorIssue,
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
// ⚠️ EVERY METHOD NAMES ITS CONSUMER. Two shipped before theirs existed, and
// that was a decision rather than dead code: `listIssuesSince` is consumed by the
// reconciling poll (MOTIR-4929 · MOTIR-5580), and `resolveIssue` by the
// resolve-back (MOTIR-4931 · MOTIR-5703). `getIssue` arrived WITH its consumer,
// the assignee refresh (MOTIR-4931 · MOTIR-5705). A method whose consumer is not
// named is one a later reader deletes as unreachable.
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

/** How many issues ONE `listIssuesSince` page asks for — Sentry's documented
 *  maximum. On the SEAM rather than in an adapter because its consumer, the
 *  poll (MOTIR-5580), states its page cap in these pages, and a consumer may not
 *  import a provider implementation (`tests/monitors/monitorBoundaries.test.ts`). */
export const MONITOR_ISSUES_PAGE_LIMIT = 100;

/** Deadline for a resolve-back write, in ms (MOTIR-4931's consumer). */
export const MONITOR_RESOLVE_ISSUE_TIMEOUT_MS = 10_000;

/** Deadline for a read of ONE issue, in ms — the assignee refresh (MOTIR-5705)
 *  makes a bounded number of these per poll, so each is bounded like a page. */
export const MONITOR_GET_ISSUE_TIMEOUT_MS = 10_000;

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
   * WHICH ORGANISATION this installation belongs to.
   *
   * `GET /api/0/sentry-app-installations/{installationId}/` — the same resource
   * {@link verifyInstall} PUTs to, read rather than written.
   *
   * ⚠️ IT WAS ADDED BY ITS CONSUMER, WHICH IS THIS SEAM'S OWN RULE WORKING. The
   * interface is defined alongside its first implementation, and MOTIR-5260 —
   * the first real caller — found that every other org-scoped method takes an
   * `orgSlug` and nothing could supply one: the install redirect carries an
   * installation id and no organisation. So the grant has to ASK, once, at
   * connect, and record the answer on the installation row. A seam whose
   * consumer cannot use it is the failure the alongside rule exists to prevent,
   * and finding that out at the first call site rather than in a vacuum is
   * precisely the intended outcome.
   *
   * Bounded by {@link MONITOR_VERIFY_INSTALL_TIMEOUT_MS} — it is the same
   * resource, read on the same interactive leg.
   */
  describeInstallation(input: {
    installationId: string;
    accessToken: string;
  }): Promise<{ orgSlug: string | null }>;

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
   * One page of the monitored project's UNRESOLVED issues last seen AFTER a
   * watermark, newest-last-seen first.
   *
   * `GET /api/0/organizations/{orgSlug}/issues/` with `project={externalProjectId}`,
   * `query=is:unresolved`, `sort=date` (last seen, newest first), `limit=100` and
   * the provider's own `cursor`. MOTIR-5577 moved it here from the per-project
   * issues endpoint, which Sentry documents as DEPRECATED in favour of this one.
   *
   * ⚠️ THE WATERMARK IS APPLIED CLIENT-SIDE, HERE. Sentry documents no absolute
   * last-seen filter, so the adapter reads pages sorted by last seen and CUTS the
   * page at the first row whose `lastSeen` is not strictly after `lastSeenAfter`
   * — and then returns `nextCursor: null`, because every later row is older
   * still. `lastSeenAfter: null` cuts nothing.
   *
   * ⚠️ `is:unresolved` IS EXPLICIT, not left to the endpoint's default:
   * MOTIR-4931's loop guard depends on a resolved issue NOT coming back.
   *
   * Every path and parameter here is a DOCUMENTED EXPECTATION (read 2026-09-15,
   * https://docs.sentry.io/api/events/list-an-organizations-issues/) — the suite
   * cannot reach sentry.io. MOTIR-4941 owns the deployed reading.
   *
   * Consumed by the reconciling poll (MOTIR-4929 · MOTIR-5580), which owns where
   * the watermark and the cursor live; this seam remembers nothing and filters
   * nothing but time. Bounded by {@link MONITOR_LIST_ISSUES_TIMEOUT_MS} per page.
   */
  listIssuesSince(input: {
    accessToken: string;
    orgSlug: string;
    /** The provider's own id for the monitored project — what the connection
     *  row stores as `externalProjectId`. */
    externalProjectId: string;
    /** EXCLUSIVE: only issues last seen strictly after this. `null` = no cut. */
    lastSeenAfter: Date | null;
    cursor: string | null;
  }): Promise<NormalizedMonitorIssuePage>;

  /**
   * Mark an issue resolved on the provider — the write that closes the loop when
   * a Motir bug is fixed.
   *
   * `PUT /api/0/issues/{issueId}/` with `{ status: 'resolved' }`.
   *
   * ⚠️ A 404 IS A TYPED ANSWER — `MonitorIssueGoneError` — NOT a generic
   * refusal: the provider no longer has the issue, which the caller states once
   * and never retries. Every other non-2xx (a 401 included, so the credential
   * service's refresh-and-retry is unchanged) is a `MonitorProviderCallError`.
   *
   * Consumed by RESOLVE BACK (MOTIR-4931 · MOTIR-5703). Bounded by
   * {@link MONITOR_RESOLVE_ISSUE_TIMEOUT_MS}.
   */
  resolveIssue(input: { accessToken: string; externalIssueId: string }): Promise<void>;

  /**
   * Read ONE issue by the provider's own id — `null` when the provider no longer
   * has it.
   *
   * `GET /api/0/organizations/{orgSlug}/issues/{issueId}/`, the documented
   * "Retrieve an Issue". It exists because Sentry documents NO batch-by-id read on
   * the list endpoint, and the poll's watermark read cannot see an assignment
   * made on an issue whose last-seen did not move.
   *
   * ⚠️ A 404 RETURNS `null` AND IS NOT AN ERROR. Every other non-2xx throws
   * `MonitorProviderCallError` carrying the provider's reason; a 401 keeps
   * `status: 401` so the credential service's refresh-and-retry applies.
   *
   * A DOCUMENTED EXPECTATION like every path here (read 2026-09-18,
   * https://docs.sentry.io/api/events/retrieve-an-issue/); MOTIR-4941 owns the
   * deployed reading. Consumed by ASSIGNEE FROM THE MONITOR (MOTIR-4931 ·
   * MOTIR-5705). Bounded by {@link MONITOR_GET_ISSUE_TIMEOUT_MS}.
   */
  getIssue(input: {
    accessToken: string;
    orgSlug: string;
    externalIssueId: string;
  }): Promise<NormalizedMonitorIssue | null>;
}
