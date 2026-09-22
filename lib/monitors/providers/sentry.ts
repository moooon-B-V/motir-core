import { MonitorIssueGoneError, MonitorProviderCallError } from '../errors';
import {
  MONITOR_GET_ISSUE_TIMEOUT_MS,
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_HEALTH_TIMEOUT_MS,
  MONITOR_ISSUE_CONTEXT_TIMEOUT_MS,
  MONITOR_ISSUES_PAGE_LIMIT,
  MONITOR_LIST_ISSUES_TIMEOUT_MS,
  MONITOR_LIST_PROJECTS_TIMEOUT_MS,
  MONITOR_REFRESH_TIMEOUT_MS,
  MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
  MONITOR_SEARCH_ISSUES_LIMIT,
  MONITOR_SEARCH_ISSUES_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
  type MonitorProvider,
} from '../provider';
import { boundExceptionMessage, filterEvidenceTags, requestPathOf } from '../evidence';
import { registerMonitorProvider } from '../registry';
import {
  MONITOR_ISSUE_FRAMES_MAX,
  type MonitorCredential,
  type NormalizedMonitorAssignee,
  type NormalizedMonitorException,
  type NormalizedMonitorHealth,
  type NormalizedMonitorIssue,
  type NormalizedMonitorIssueContext,
  type NormalizedMonitorIssuePage,
  type NormalizedMonitorProject,
  type NormalizedMonitorRequest,
  type NormalizedMonitorStackFrame,
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

/**
 * The env-var NAMES this adapter cannot work without (MOTIR-5831) — the
 * `MonitorProvider.requiredEnv` declaration, kept HERE, beside the reads, so the
 * list and the reads cannot drift.
 *
 * ⚠️ THE THREE ARE NOT ALL READ BY THE SAME FUNCTION, and that is the reason
 * this constant sits at module scope rather than inside {@link appCredentials}.
 * `SENTRY_APP_CLIENT_ID` and `SENTRY_APP_CLIENT_SECRET` are read by
 * `appCredentials()` below, on the grant exchange and the refresh.
 * `SENTRY_APP_SLUG` is read one layer up, by `externalInstallUrl()` in
 * `app/api/monitors/sentry/oauth/start/route.ts`, which builds the install URL —
 * and it is required in exactly the same sense: without it the flow cannot
 * start. `tests/monitors/monitorRequiredEnv.test.ts` pins each name to the read
 * that consumes it, so adding a name here without a read (or a read without a
 * name) fails.
 *
 * ⚠️ AND `SENTRY_TOKEN_ENCRYPTION_KEY` IS DELIBERATELY ABSENT. It is not
 * required: `lib/monitors/tokenCrypto.ts` resolves it with a documented FALLBACK
 * to `GITHUB_TOKEN_ENCRYPTION_KEY`, so a deployment that already wired GitHub
 * connects a monitor with zero new config. Declaring it here would fail the
 * health probe on a deployment that is correctly configured — a false alarm, and
 * the one failure mode `system.daily-health-check` is written to avoid.
 * `SENTRY_API_BASE_URL` and `SENTRY_WEB_BASE_URL` are absent for the plainer
 * reason that both have defaults.
 */
export const SENTRY_REQUIRED_ENV = [
  'SENTRY_APP_CLIENT_ID',
  'SENTRY_APP_CLIENT_SECRET',
  'SENTRY_APP_SLUG',
] as const;

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

  /** The three names above, declared on the seam every consumer asks through
   *  (MOTIR-5831). */
  requiredEnv: SENTRY_REQUIRED_ENV,

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
      /* v8 ignore next 6 -- unreachable: `call()` wraps every failure it can
         produce in a MonitorProviderCallError. Asserted by
         `monitorStoryArms.test.ts` › "call() surfaces EVERY failure as a
         MonitorProviderCallError"; kept so a future non-`call` read inside the try
         still yields a verdict rather than a throw. */
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
   * `GET /organizations/{orgSlug}/issues/?project=…&query=is:unresolved&sort=date&limit=100`
   * with Sentry's own `cursor` — see the interface for the contract.
   *
   * Rows arrive newest-last-seen first (`sort=date`), so the page is CUT at the
   * first row whose `lastSeen` is not strictly after `lastSeenAfter`, and the
   * cursor is then dropped: every row after the cut, on this page or any later
   * one, is older still. Only a page that lies ENTIRELY after the watermark hands
   * back the `Link` header's next cursor.
   */
  async listIssuesSince({
    accessToken,
    orgSlug,
    externalProjectId,
    lastSeenAfter,
    cursor,
  }): Promise<NormalizedMonitorIssuePage> {
    const url = new URL(`${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/issues/`);
    url.searchParams.set('project', externalProjectId);
    url.searchParams.set('query', 'is:unresolved');
    url.searchParams.set('sort', 'date');
    url.searchParams.set('limit', String(MONITOR_ISSUES_PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await call('listIssuesSince', MONITOR_LIST_ISSUES_TIMEOUT_MS, url.toString(), {
      method: 'GET',
      headers: jsonHeaders(accessToken),
    });
    const rows = (await res.json()) as Record<string, unknown>[];
    const issues = rows.filter((row) => typeof row['id'] === 'string').map(normalizeIssue);

    const cut =
      lastSeenAfter === null
        ? -1
        : issues.findIndex((issue) => issue.lastSeenAt.getTime() <= lastSeenAfter.getTime());
    if (cut >= 0) return { issues: issues.slice(0, cut), nextCursor: null };
    return { issues, nextCursor: nextCursorFromLinkHeader(res.headers.get('link')) };
  },

  /** `PUT /issues/{issueId}/` with `{ status: 'resolved' }`. A 404 is the
   *  typed {@link MonitorIssueGoneError}; everything else is `call()`'s refusal.
   *  Consumed by RESOLVE BACK (MOTIR-5703). */
  async resolveIssue({ accessToken, externalIssueId }): Promise<void> {
    try {
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
    } catch (err) {
      if (err instanceof MonitorProviderCallError && err.status === 404) {
        throw new MonitorIssueGoneError('resolveIssue', externalIssueId, err.providerReason);
      }
      throw err;
    }
  },

  /** `GET /organizations/{orgSlug}/issues/{issueId}/` — "Retrieve an Issue". A
   *  404 is `null` (the issue is gone), never an error. Consumed by ASSIGNEE FROM
   *  THE MONITOR (MOTIR-5705). */
  async getIssue({
    accessToken,
    orgSlug,
    externalIssueId,
  }): Promise<NormalizedMonitorIssue | null> {
    let res: Response;
    try {
      res = await call(
        'getIssue',
        MONITOR_GET_ISSUE_TIMEOUT_MS,
        `${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(externalIssueId)}/`,
        { method: 'GET', headers: jsonHeaders(accessToken) },
      );
    } catch (err) {
      if (err instanceof MonitorProviderCallError && err.status === 404) return null;
      throw err;
    }
    const row = (await res.json()) as Record<string, unknown>;
    return normalizeIssue({
      ...row,
      id: typeof row['id'] === 'string' ? row['id'] : externalIssueId,
    });
  },

  /**
   * `GET /organizations/{orgSlug}/issues/?project=…&query=…&shortIdLookup=1&limit=…`
   * — ONE request, no cursor followed, and deliberately no `is:unresolved` (see
   * the interface). Rows go through {@link normalizeIssue}, the mapper
   * `listIssuesSince` uses. Consumed by LINK BY HAND (MOTIR-5731).
   */
  async searchIssues({
    accessToken,
    orgSlug,
    externalProjectId,
    query,
    limit,
  }): Promise<NormalizedMonitorIssue[]> {
    const url = new URL(`${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/issues/`);
    url.searchParams.set('project', externalProjectId);
    url.searchParams.set('query', query.trim());
    url.searchParams.set('shortIdLookup', '1');
    url.searchParams.set(
      'limit',
      String(Math.max(1, Math.min(Math.floor(limit) || 1, MONITOR_SEARCH_ISSUES_LIMIT))),
    );
    const res = await call('searchIssues', MONITOR_SEARCH_ISSUES_TIMEOUT_MS, url.toString(), {
      method: 'GET',
      headers: jsonHeaders(accessToken),
    });
    const rows = (await res.json()) as Record<string, unknown>[];
    return rows.filter((row) => typeof row['id'] === 'string').map(normalizeIssue);
  },

  /**
   * `GET /organizations/{orgSlug}/issues/{issueId}/events/latest/` — the latest
   * event's `environment` tag, `release.version`, exception frames and the rest
   * of its EVIDENCE (MOTIR-5977). A 404 is the typed {@link MonitorIssueGoneError}.
   * Consumed by MOTIR-5729 and MOTIR-5731.
   */
  async getIssueContext({
    accessToken,
    orgSlug,
    externalIssueId,
  }): Promise<NormalizedMonitorIssueContext> {
    let res: Response;
    try {
      res = await call(
        'getIssueContext',
        MONITOR_ISSUE_CONTEXT_TIMEOUT_MS,
        `${apiBase()}/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(externalIssueId)}/events/latest/`,
        { method: 'GET', headers: jsonHeaders(accessToken) },
      );
    } catch (err) {
      if (err instanceof MonitorProviderCallError && err.status === 404) {
        throw new MonitorIssueGoneError('getIssueContext', externalIssueId, err.providerReason);
      }
      throw err;
    }
    return normalizeIssueContext((await res.json()) as Record<string, unknown>);
  },
};

/**
 * ONE Sentry event payload → the issue's context. Sentry states an event's tags
 * as `[{ key, value }]`, its release as `{ version }` (or `null`), its id as
 * `eventID` and its time as `dateCreated` — all DOCUMENTED EXPECTATIONS, read
 * 2026-09-19 and, for the evidence fields, 2026-09-22 (Sentry, "Retrieve an
 * Issue Event" and "Event Payloads": the Exception, Request and Tags
 * interfaces). Anything else is `null` / `[]`, never a guess: "no release" is an
 * ordinary event, and a made-up one is a lie on the work item.
 *
 * ⚠️ THE EVIDENCE IS FILTERED HERE, AT THE SEAM (MOTIR-5977). Tags go through
 * `filterEvidenceTags`, the request's URL through `requestPathOf`, and of the
 * request entry only `method` and `url` are read — `query`, `headers`,
 * `cookies`, `data` and `env` never are, so they cannot leak downstream.
 */
export function normalizeIssueContext(
  event: Record<string, unknown>,
): NormalizedMonitorIssueContext {
  const tags = Array.isArray(event['tags']) ? (event['tags'] as unknown[]) : [];
  let environment: string | null = null;
  for (const tag of tags) {
    if (!tag || typeof tag !== 'object') continue;
    const { key, value } = tag as { key?: unknown; value?: unknown };
    if (key === 'environment' && typeof value === 'string' && value) {
      environment = value;
      break;
    }
  }
  const release = event['release'];
  const version =
    release && typeof release === 'object' ? (release as { version?: unknown }).version : null;
  const eventId = event['eventID'];
  return {
    environment,
    release: typeof version === 'string' && version ? version : null,
    frames: normalizeEventFrames(event),
    exception: normalizeEventException(event),
    tags: filterEvidenceTags(tags),
    request: normalizeEventRequest(event),
    eventId: typeof eventId === 'string' && eventId ? eventId : null,
    eventAt: readOptionalDate(event['dateCreated']),
  };
}

/** The event's `entries[]` item of the given `type`, or `undefined`. */
function entryOfType(event: Record<string, unknown>, type: string): { data?: unknown } | undefined {
  const entries = Array.isArray(event['entries']) ? (event['entries'] as unknown[]) : [];
  return entries.find(
    (entry): entry is { data?: unknown } =>
      !!entry && typeof entry === 'object' && (entry as { type?: unknown }).type === type,
  );
}

/** The exception chain's `values[]` — cause first — or `[]`. */
function exceptionValues(event: Record<string, unknown>): unknown[] {
  const data = entryOfType(event, 'exception')?.data;
  return data && typeof data === 'object' && Array.isArray((data as { values?: unknown }).values)
    ? (data as { values: unknown[] }).values
    : [];
}

/**
 * The exception that SURFACED (MOTIR-5977) — the SAME value
 * {@link normalizeEventFrames} takes its frames from: the LAST value carrying
 * frames, falling back to the last value when none does. Its `type` and its
 * `value` (the message), bounded by `MONITOR_EVIDENCE_MESSAGE_MAX`. No exception
 * entry, or a surfaced value stating neither, is `null`.
 */
export function normalizeEventException(
  event: Record<string, unknown>,
): NormalizedMonitorException | null {
  const values = exceptionValues(event);
  if (values.length === 0) return null;
  let surfaced: unknown = values[values.length - 1];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (framesOfValue(values[i]).length > 0) {
      surfaced = values[i];
      break;
    }
  }
  if (!surfaced || typeof surfaced !== 'object') return null;
  const { type, value } = surfaced as { type?: unknown; value?: unknown };
  const exceptionType = typeof type === 'string' && type ? type : null;
  const message = typeof value === 'string' && value ? boundExceptionMessage(value) : null;
  return exceptionType === null && message === null ? null : { type: exceptionType, message };
}

/**
 * The request that triggered the event (MOTIR-5977): the `entries[]` item of
 * `type: "request"` — its `data.method` and the PATH of its `data.url`. Nothing
 * else on the entry is read. No request entry, or one whose URL does not parse,
 * is `null`.
 */
export function normalizeEventRequest(
  event: Record<string, unknown>,
): NormalizedMonitorRequest | null {
  const data = entryOfType(event, 'request')?.data;
  if (!data || typeof data !== 'object') return null;
  const { method, url } = data as { method?: unknown; url?: unknown };
  const path = requestPathOf(url);
  if (path === null) return null;
  return { method: typeof method === 'string' && method ? method.toUpperCase() : null, path };
}

/**
 * ONE Sentry event payload → its stack frames (MOTIR-5846), ordered in-app first
 * and most-recent call first, cut at {@link MONITOR_ISSUE_FRAMES_MAX}.
 *
 * Sentry states an event's exception as an `entries[]` item of
 * `type: "exception"` whose `data.values[]` is the exception CHAIN, cause first —
 * so the LAST value with frames is the exception that surfaced — and each
 * value's `stacktrace.frames[]` is ordered OLDEST call first. Both DOCUMENTED
 * EXPECTATIONS, read 2026-09-21. The two re-orderings below are therefore not
 * cosmetic: an unordered cut would keep the framework's outermost frames and
 * drop the application's own innermost ones, which are the ones a context ref
 * is written from.
 *
 * Anything malformed is ABSENCE, never a guess: no exception entry, no frames,
 * or a frame naming no file all contribute nothing, and the answer is `[]`.
 */
export function normalizeEventFrames(
  event: Record<string, unknown>,
): NormalizedMonitorStackFrame[] {
  const values = exceptionValues(event);
  let rawFrames: unknown[] = [];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const frames = framesOfValue(values[i]);
    if (frames.length > 0) {
      rawFrames = frames;
      break;
    }
  }
  // Oldest-first → most-recent-first, then a STABLE partition: in-app frames
  // keep their recency order ahead of everything else, and so do the rest.
  const recentFirst = rawFrames
    .map(normalizeFrame)
    .filter((frame): frame is NormalizedMonitorStackFrame => frame !== null)
    .reverse();
  return [
    ...recentFirst.filter((frame) => frame.inApp === true),
    ...recentFirst.filter((frame) => frame.inApp !== true),
  ].slice(0, MONITOR_ISSUE_FRAMES_MAX);
}

function framesOfValue(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const stacktrace = (value as { stacktrace?: unknown }).stacktrace;
  if (!stacktrace || typeof stacktrace !== 'object') return [];
  const frames = (stacktrace as { frames?: unknown }).frames;
  return Array.isArray(frames) ? frames : [];
}

/** One Sentry frame, or `null` when it names no file. `filename` is the path the
 *  SDK reported relative to the project where it could; `absPath` and `module`
 *  are the fallbacks, in that order, for runtimes that state only those. */
function normalizeFrame(raw: unknown): NormalizedMonitorStackFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Record<string, unknown>;
  const filePath = [frame['filename'], frame['absPath'], frame['module']].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  if (!filePath) return null;
  const fn = frame['function'];
  const line = frame['lineNo'];
  const inApp = frame['inApp'];
  return {
    filePath,
    function: typeof fn === 'string' && fn ? fn : null,
    lineNumber: typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
    inApp: typeof inApp === 'boolean' ? inApp : null,
  };
}

/**
 * ONE Sentry issue payload → the normalized issue. The ONLY place a normalized
 * issue is built, so `listIssuesSince` and `getIssue` cannot disagree about any
 * field — the assignee above all (MOTIR-5702).
 */
export function normalizeIssue(row: Record<string, unknown>): NormalizedMonitorIssue {
  return {
    externalId: String(row['id']),
    title: typeof row['title'] === 'string' ? row['title'] : String(row['id']),
    culprit: typeof row['culprit'] === 'string' ? row['culprit'] : null,
    level: typeof row['level'] === 'string' ? row['level'] : null,
    eventCount: Number(row['count'] ?? 0) || 0,
    firstSeenAt: readDate(row['firstSeen']),
    lastSeenAt: readDate(row['lastSeen']),
    permalink: typeof row['permalink'] === 'string' ? row['permalink'] : null,
    assignee: readAssignee(row['assignedTo']),
  };
}

/**
 * Sentry's `assignedTo` — `{ type, id, name, email }` per its list-issues
 * documentation (read 2026-09-18,
 * https://docs.sentry.io/api/events/list-an-organizations-issues/), a DOCUMENTED
 * EXPECTATION like every field here. `null`, or anything without a usable type
 * and id, is UNASSIGNED rather than a guess. A team never carries an email.
 */
function readAssignee(value: unknown): NormalizedMonitorAssignee | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { type?: unknown; id?: unknown; name?: unknown; email?: unknown };
  const kind = raw.type === 'user' || raw.type === 'team' ? raw.type : null;
  const externalId =
    typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : null;
  if (kind === null || externalId === null) return null;
  return {
    kind,
    externalId,
    email: kind === 'user' && typeof raw.email === 'string' && raw.email ? raw.email : null,
    name: typeof raw.name === 'string' && raw.name ? raw.name : null,
  };
}

/** A date the provider stated, or now — never an invalid `Date`, which reads as
 *  a value everywhere downstream and compares false against everything. */
function readDate(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** A date the provider stated, or `null` — for a fact that is OPTIONAL, where
 *  "now" would be a guess dressed up as a reading (MOTIR-5977's `eventAt`). */
function readOptionalDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
