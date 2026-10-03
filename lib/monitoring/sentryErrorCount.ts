import 'server-only';

// THE PLATFORM'S OWN SENTRY ERROR COUNT (MOTIR-740) — a SERVER-ONLY leaf client
// the operator console's Errors card reads through.
//
// Two GET calls against Sentry's public API, both authorised by the read-only
// internal-integration token MOTIR-739 provisioned (`org:read`, `project:read`,
// `event:read`; no write scope):
//
//   GET /api/0/projects/{org}/{project}/                         → {id, slug, …}
//   GET /api/0/organizations/{org}/stats_v2/?field=sum(quantity)
//       &category=error&outcome=accepted&statsPeriod=24h&project={id}
//                                                                 → {groups: [{totals: {"sum(quantity)": n}}], …}
//
// The project id is resolved once per process and memoized: `stats_v2` filters
// by numeric id, not by slug, and a slug-to-id lookup on every page load would
// double the calls for a value that does not change.
//
// ⚠️ THIS IS NOT THE TENANT GRANT. `lib/monitors/providers/sentry.ts` holds a
// per-WORKSPACE Sentry App installation, behind workspace RLS; this reads Motir's
// own org with a platform credential, so one workspace disconnecting its
// integration can never blind the operator console.
//
// ⚠️ AND IT NEVER ANSWERS ZERO FOR A FAILED READ. Every non-2xx, every body that
// does not carry the total, every timeout THROWS; the service's `probe()` is the
// single place a throw becomes `unreachable`. A `?? 0` here would be the exact
// defect the board exists to prevent.

/** Sentry's US-region API — the region Motir's org lives in (`production-service-stack.md` Q2). */
export const SENTRY_API_BASE = 'https://sentry.io/api/0';

/** The deadline on each call; the card would rather say "no response" than spin. */
export const SENTRY_ERROR_COUNT_TIMEOUT_MS = 3_000;

/** The window the count covers. The copy says "· 24h", so the two must agree. */
export const SENTRY_ERROR_COUNT_WINDOW_HOURS = 24;

/** One clean reading. */
export interface SentryErrorCount {
  /** Errors Sentry ACCEPTED for the project over the window. */
  count: number;
  /** The project's numeric id, for the issues link-out. */
  projectId: string;
  org: string;
}

/** The thing the service reads through — the real client or the E2E fake. */
export interface ErrorCountReader {
  /** Are the token, org and project all set? */
  configured(): boolean;
  /** One reading. Throws on anything but a clean answer. */
  read(): Promise<SentryErrorCount>;
  /** The project-scoped issues view, or null when there is no honest page. */
  issuesUrl(reading: SentryErrorCount): string | null;
}

interface SentryReadConfig {
  token: string;
  org: string;
  project: string;
}

function readConfig(): SentryReadConfig | null {
  const token = process.env['SENTRY_READ_TOKEN']?.trim();
  const org = process.env['SENTRY_ORG']?.trim();
  const project = process.env['SENTRY_PROJECT']?.trim();
  if (!token || !org || !project) return null;
  return { token, org, project };
}

export function sentryErrorCountConfigured(): boolean {
  return readConfig() !== null;
}

/** Memoized per process, keyed by org/project so a changed setting is re-resolved. */
const projectIds = new Map<string, string>();

/** Test seam: forget the memoized project ids. */
export function resetSentryProjectIdCache(): void {
  projectIds.clear();
}

export async function readErrorCount24h(): Promise<SentryErrorCount> {
  const config = readConfig();
  if (!config) throw new Error('Sentry read credential is not configured');

  const projectId = await resolveProjectId(config);
  const params = new URLSearchParams({
    field: 'sum(quantity)',
    category: 'error',
    outcome: 'accepted',
    statsPeriod: `${SENTRY_ERROR_COUNT_WINDOW_HOURS}h`,
    project: projectId,
  });
  const body = await sentryGet(
    `${SENTRY_API_BASE}/organizations/${encodeURIComponent(config.org)}/stats_v2/?${params}`,
    config.token,
  );
  return { count: sumAccepted(body), projectId, org: config.org };
}

/** The real binding. */
export const httpErrorCountReader: ErrorCountReader = {
  configured: sentryErrorCountConfigured,
  read: readErrorCount24h,
  issuesUrl: ({ org, projectId }) =>
    `https://${encodeURIComponent(org)}.sentry.io/issues/?project=${encodeURIComponent(projectId)}&statsPeriod=${SENTRY_ERROR_COUNT_WINDOW_HOURS}h`,
};

async function resolveProjectId(config: SentryReadConfig): Promise<string> {
  const key = `${config.org}/${config.project}`;
  const known = projectIds.get(key);
  if (known) return known;

  const body = await sentryGet(
    `${SENTRY_API_BASE}/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(config.project)}/`,
    config.token,
  );
  const id = isRecord(body) ? body['id'] : undefined;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw new Error('Sentry project read carried no numeric id');
  }
  projectIds.set(key, id);
  return id;
}

async function sentryGet(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SENTRY_ERROR_COUNT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Sentry answered ${res.status}`);
    return await res.json();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Sentry did not answer within ${SENTRY_ERROR_COUNT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The window's total, summed over `groups[].totals["sum(quantity)"]`.
 *
 * Without a `groupBy` Sentry answers one group; summing is still right if it ever
 * answers more. An EMPTY `groups` array is a measured zero — Sentry's own shape
 * for a window with no events — and is the one case a zero is honest. A group
 * without a numeric total is not, and throws.
 */
function sumAccepted(body: unknown): number {
  const groups = isRecord(body) ? body['groups'] : undefined;
  if (!Array.isArray(groups)) throw new Error('Sentry stats carried no groups');
  let total = 0;
  for (const group of groups) {
    const totals = isRecord(group) ? group['totals'] : undefined;
    const value = isRecord(totals) ? totals['sum(quantity)'] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('Sentry stats group carried no total');
    }
    total += value;
  }
  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
