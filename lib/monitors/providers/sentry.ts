import { MonitorProviderCallError } from '../errors';
import {
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_HEALTH_TIMEOUT_MS,
  MONITOR_LIST_ISSUES_TIMEOUT_MS,
  MONITOR_LIST_PROJECTS_TIMEOUT_MS,
  MONITOR_REFRESH_TIMEOUT_MS,
  MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
  type MonitorProvider,
} from '../provider';
import { registerMonitorProvider } from '../registry';
import type {
  MonitorCredential,
  NormalizedMonitorHealth,
  NormalizedMonitorIssuePage,
  NormalizedMonitorProject,
} from '../types';

// The SENTRY implementation of the `MonitorProvider` seam (Story MOTIR-4926 ·
// MOTIR-5259) — the FIRST and today the ONLY one. `lib/git/providers/github.ts`
// is the shape this mirrors: a pure adapter that takes credentials, calls the
// host, and returns normalized values. It touches no Prisma client and no
// repository.
//
// ⚠️ EVERY PATH AND FIELD BELOW IS A DOCUMENTED EXPECTATION, NOT A READ. This
// code cannot reach sentry.io and its tests are required not to, so the
// endpoints, the grant parameters and the response fields come from Sentry's
// integration-platform documentation as of 2026-09-12 and from the work item
// that pinned them. That is a claim about somebody else's internals, and the
// honest disposition is to say so where it is made rather than to let a
// confident comment read as a verification: MOTIR-5257 is the card that meets
// the real dashboard, and MOTIR-4941 owns the deployed round trip.
// https://docs.sentry.io/organization/integrations/integration-platform/public-integration/
//
// ⚠️ AND THE CLIENT SECRET NEVER LEAVES THIS FILE'S CALLS. It is read from the
// environment at CALL time (never module load), so a deployment that has not
// registered the integration simply cannot reach the flow instead of crashing on
// boot — the same rule `lib/crypto/tokenCrypto.ts` states for its key.

/** Sentry's API root. Overridable because the account's DATA REGION decides it
 *  (MOTIR-1161 provisioned Motir's org in the US region), and because the tests
 *  point it at a stub rather than at the internet. */
const apiBase = (): string =>
  process.env['SENTRY_API_BASE_URL']?.replace(/\/+$/, '') ?? 'https://sentry.io/api/0';

/** The registered integration's credentials. Read at call time; a missing pair is
 *  an operator misconfiguration, so it refuses loudly and names the env vars
 *  MOTIR-5257 sets. */
function appCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env['SENTRY_APP_CLIENT_ID'];
  const clientSecret = process.env['SENTRY_APP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    throw new MonitorProviderCallError(
      'configuration',
      null,
      'SENTRY_APP_CLIENT_ID and SENTRY_APP_CLIENT_SECRET are not set on this deployment.',
    );
  }
  return { clientId, clientSecret };
}

/**
 * One bounded request, with the provider's own failure text preserved.
 *
 * ⚠️ THE TIMEOUT IS AN `AbortController`, NOT A PROMISE RACE, for the reason
 * `lib/git/providers/github.ts` gives: a race leaves the request running and the
 * socket held, and on a serverless invocation that is what turns a slow host
 * into a function timeout with no body. Aborting bounds time-to-headers, which
 * is where a dead host hangs.
 */
async function call(
  operation: string,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new MonitorProviderCallError(
      operation,
      null,
      controller.signal.aborted
        ? `No response within ${timeoutMs}ms.`
        : err instanceof Error
          ? err.message
          : 'unknown transport failure',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new MonitorProviderCallError(operation, res.status, await providerReason(res));
  }
  return res;
}

/**
 * The provider's OWN words for a refusal.
 *
 * Sentry answers an error as `{ detail }` most of the time and as
 * `{ error_description }` on the OAuth-shaped endpoints; a gateway in front of
 * it answers with neither. All three are read, and the raw body is the last
 * resort — trimmed, because the string is rendered to a person, and never
 * replaced by one of ours.
 */
async function providerReason(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  if (!raw) return `${res.status} ${res.statusText || 'no response body'}`;
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; error_description?: unknown };
    const detail = parsed.detail ?? parsed.error_description;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return raw.trim().slice(0, 500);
}

/** Sentry's authorization response: an access token, a refresh token, and an
 *  ABSOLUTE expiry it calls `expiresAt`. Read defensively — a missing token is a
 *  refusal wearing a 200. */
function readCredential(operation: string, payload: unknown): MonitorCredential {
  const body = payload as {
    token?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
  if (typeof body.token !== 'string' || typeof body.refreshToken !== 'string') {
    throw new MonitorProviderCallError(
      operation,
      200,
      'The authorization response carried no token pair.',
    );
  }
  // The provider states an absolute expiry; a missing or unparseable one falls
  // back to the documented eight-hour life rather than to "never expires",
  // because a credential believed permanent is one nothing ever refreshes.
  const stated = typeof body.expiresAt === 'string' ? new Date(body.expiresAt) : null;
  const expiresAt =
    stated && !Number.isNaN(stated.getTime()) ? stated : new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { accessToken: body.token, refreshToken: body.refreshToken, expiresAt };
}

const jsonHeaders = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  'content-type': 'application/json',
  accept: 'application/json',
  'user-agent': 'motir',
});

export const sentryMonitorProvider: MonitorProvider = {
  id: 'sentry',

  /** `POST /sentry-app-installations/{installationId}/authorizations/` with
   *  `grant_type: 'authorization_code'`. */
  async exchangeGrant({ installationId, code }): Promise<MonitorCredential> {
    const { clientId, clientSecret } = appCredentials();
    const res = await call(
      'exchangeGrant',
      MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
      `${apiBase()}/sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
    return readCredential('exchangeGrant', await res.json());
  },

  /** `PUT /sentry-app-installations/{installationId}/` with
   *  `{ status: 'installed' }` — an installation left unverified is one the
   *  provider may reap. */
  async verifyInstall({ installationId, accessToken }): Promise<void> {
    await call(
      'verifyInstall',
      MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
      `${apiBase()}/sentry-app-installations/${encodeURIComponent(installationId)}/`,
      {
        method: 'PUT',
        headers: jsonHeaders(accessToken),
        body: JSON.stringify({ status: 'installed' }),
      },
    );
  },

  /** `GET /sentry-app-installations/{installationId}/` — the same resource the
   *  verify PUTs to. The organisation is what every org-scoped method needs and
   *  what the install redirect does not carry (see the interface's note). */
  async describeInstallation({ installationId, accessToken }): Promise<{ orgSlug: string | null }> {
    const res = await call(
      'describeInstallation',
      MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
      `${apiBase()}/sentry-app-installations/${encodeURIComponent(installationId)}/`,
      { method: 'GET', headers: jsonHeaders(accessToken) },
    );
    const body = (await res.json()) as { organization?: { slug?: unknown } };
    const slug = body.organization?.slug;
    return { orgSlug: typeof slug === 'string' && slug.length > 0 ? slug : null };
  },

  /** The SAME authorizations endpoint as the exchange, with
   *  `grant_type: 'refresh_token'`. */
  async refreshCredential({ installationId, refreshToken }): Promise<MonitorCredential> {
    const { clientId, clientSecret } = appCredentials();
    const res = await call(
      'refreshCredential',
      MONITOR_REFRESH_TIMEOUT_MS,
      `${apiBase()}/sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
    return readCredential('refreshCredential', await res.json());
  },

  /**
   * `GET /organizations/{orgSlug}/` — the cheapest authenticated read the grant
   * can ask for.
   *
   * ⚠️ IT RETURNS A VERDICT AND DOES NOT THROW. `degraded` is the fact the epic
   * exists to make visible, so every failure arm becomes a value carrying the
   * provider's own reason: a probe whose unhealthy path throws is a probe whose
   * answer gets logged and lost, which is the shape MOTIR-4918 recorded.
   */
  async describeHealth({ accessToken, orgSlug }): Promise<NormalizedMonitorHealth> {
    const checkedAt = new Date();
    try {
      await call(
        'describeHealth',
        MONITOR_HEALTH_TIMEOUT_MS,
        `${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/`,
        { method: 'GET', headers: jsonHeaders(accessToken) },
      );
      return { status: 'connected', reason: null, checkedAt };
    } catch (err) {
      if (err instanceof MonitorProviderCallError) {
        return { status: 'degraded', reason: err.providerReason, checkedAt };
      }
      return {
        status: 'degraded',
        reason: err instanceof Error ? err.message : 'unknown failure',
        checkedAt,
      };
    }
  },

  /** `GET /organizations/{orgSlug}/projects/`. */
  async listProjects({ accessToken, orgSlug }): Promise<NormalizedMonitorProject[]> {
    const res = await call(
      'listProjects',
      MONITOR_LIST_PROJECTS_TIMEOUT_MS,
      `${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/projects/`,
      { method: 'GET', headers: jsonHeaders(accessToken) },
    );
    const rows = (await res.json()) as { id?: unknown; slug?: unknown; name?: unknown }[];
    return rows
      .filter((row) => typeof row.id === 'string' && typeof row.slug === 'string')
      .map((row) => ({
        externalId: String(row.id),
        slug: String(row.slug),
        name: typeof row.name === 'string' ? row.name : String(row.slug),
      }));
  },

  /**
   * `GET /projects/{orgSlug}/{projectSlug}/issues/` with Sentry's own `cursor`.
   *
   * ⚠️ NO PRODUCTION CALLER YET — MOTIR-4929's reconciling poll is the consumer,
   * and it owns where the cursor is stored. The next cursor comes out of the
   * `Link` header, which is Sentry's pagination carrier; this method hands it
   * back and remembers nothing.
   */
  async listIssuesSince({
    accessToken,
    orgSlug,
    projectSlug,
    cursor,
  }): Promise<NormalizedMonitorIssuePage> {
    const url = new URL(
      `${apiBase()}/projects/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}/issues/`,
    );
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await call('listIssuesSince', MONITOR_LIST_ISSUES_TIMEOUT_MS, url.toString(), {
      method: 'GET',
      headers: jsonHeaders(accessToken),
    });
    const rows = (await res.json()) as Record<string, unknown>[];
    return {
      issues: rows
        .filter((row) => typeof row['id'] === 'string')
        .map((row) => ({
          externalId: String(row['id']),
          title: typeof row['title'] === 'string' ? row['title'] : String(row['id']),
          culprit: typeof row['culprit'] === 'string' ? row['culprit'] : null,
          level: typeof row['level'] === 'string' ? row['level'] : null,
          eventCount: Number(row['count'] ?? 0) || 0,
          firstSeenAt: readDate(row['firstSeen']),
          lastSeenAt: readDate(row['lastSeen']),
          permalink: typeof row['permalink'] === 'string' ? row['permalink'] : null,
        })),
      nextCursor: nextCursorFromLinkHeader(res.headers.get('link')),
    };
  },

  /** `PUT /issues/{issueId}/` with `{ status: 'resolved' }`.
   *
   *  ⚠️ NO PRODUCTION CALLER YET — MOTIR-4931's resolve-back sync is the consumer. */
  async resolveIssue({ accessToken, externalIssueId }): Promise<void> {
    await call(
      'resolveIssue',
      MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
      `${apiBase()}/issues/${encodeURIComponent(externalIssueId)}/`,
      {
        method: 'PUT',
        headers: jsonHeaders(accessToken),
        body: JSON.stringify({ status: 'resolved' }),
      },
    );
  },
};

/** A date the provider stated, or now — never an invalid `Date`, which reads as
 *  a value everywhere downstream and compares false against everything. */
function readDate(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Sentry paginates with a `Link` header carrying `results="true|false"` and a
 * `cursor="…"` per relation. The NEXT cursor is only meaningful when that
 * relation says it has results — `results="false"` with a cursor present is the
 * END of the list, and reading the cursor anyway is how a poll loops for ever on
 * the last page.
 */
export function nextCursorFromLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    if (!/rel="?next"?/.test(part)) continue;
    if (/results="?false"?/.test(part)) return null;
    const match = /cursor="?([^";]+)"?/.exec(part);
    return match?.[1] ?? null;
  }
  return null;
}

registerMonitorProvider(sentryMonitorProvider);
