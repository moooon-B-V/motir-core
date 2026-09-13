// The `?monitor=<outcome>` statuses the Monitoring room renders a banner for
// (Story MOTIR-4928 · MOTIR-5262; design/monitoring §11, panel 10).
//
// ONE declaration of the outcome → tone map, directive-free so the server page
// and any client module import the same symbol. It is also the ALLOW-LIST: a
// hand-typed `?monitor=whatever` is not a key, so it renders nothing rather than
// reaching a `banner.<anything>` message lookup. The eight keys are exactly the
// statuses `app/api/monitors/sentry/oauth/{start,callback}` redirect with, and
// `tests/monitors/returnBanner.test.ts` reads both route files to hold that.

export const MONITOR_BANNER_TONE = {
  connected: 'success',
  error: 'danger',
  denied: 'info',
  no_state: 'info',
  state_error: 'danger',
  forbidden: 'danger',
  no_project: 'danger',
  not_configured: 'info',
} as const;

export type MonitorBannerStatus = keyof typeof MONITOR_BANNER_TONE;
export type MonitorBannerTone = (typeof MONITOR_BANNER_TONE)[MonitorBannerStatus];

/** Narrow an untrusted search param to a known outcome, or `null`. */
export function parseMonitorBannerStatus(
  value: string | null | undefined,
): MonitorBannerStatus | null {
  if (typeof value !== 'string' || !Object.hasOwn(MONITOR_BANNER_TONE, value)) return null;
  return value as MonitorBannerStatus;
}

/** The banner as the room renders it, already translated. */
export interface MonitoringBannerCopy {
  tone: MonitorBannerTone;
  title: string;
  body: string;
}

/** The subset of a next-intl translator this needs, so the decision is testable
 *  with the real catalog and no server runtime. */
export type MonitoringBannerTranslator = (key: string, values?: Record<string, string>) => string;

/**
 * Decide the return banner from what the request carried.
 *
 * ⚠️ `reasonCookie` IS THE ONLY SOURCE OF A REASON. The search params are taken
 * whole and only `monitor` is read from them, so a `?reason=` on a crafted link
 * has no path onto the page. The cookie is httpOnly and set by the callback on
 * its redirect (`lib/monitors/connectResult.ts`), and it is consulted only for
 * `error`, so a stale one cannot colour any other outcome.
 */
export function buildMonitoringBanner({
  searchParams,
  reasonCookie,
  org,
  t,
  decodeReason,
}: {
  searchParams: { monitor?: string | string[] };
  reasonCookie: string | undefined;
  org: string;
  t: MonitoringBannerTranslator;
  decodeReason: (raw: string | undefined) => string | null;
}): MonitoringBannerCopy | null {
  const raw = searchParams.monitor;
  const status = parseMonitorBannerStatus(Array.isArray(raw) ? raw[0] : raw);
  if (!status) return null;
  const reason = status === 'error' ? decodeReason(reasonCookie) : null;
  return {
    tone: MONITOR_BANNER_TONE[status],
    title: t(`banner.${status}.title`, { org }),
    body: reason
      ? t('banner.error.bodyWithReason', { reason })
      : t(`banner.${status}.body`, { org }),
  };
}
