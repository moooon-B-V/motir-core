import type { PlatformAuditSearchFiltersDTO } from '@/lib/dto/platform';

/**
 * The audit log's URL state (MOTIR-752, design `platform-admin` AMENDMENT
 * 2026-10-03 Panel 6). Filters, the Newer/Older keyset stack and the open entry
 * all live in the query string, so a filtered view is linkable — the org page's
 * "Open in the audit log" is just `?org=<id>` — and the server answers every
 * change (a new filter or page is a new query: `router.push`, not a shallow
 * write).
 */
export interface AuditLogQuery {
  /** Free text over reasons and targets. */
  q: string;
  /** Operator — a user id. */
  actor: string;
  /** Tenant — an organization id. */
  org: string;
  /** One exact action key. */
  action: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive (the service's bound is exclusive — see `toSearchFilters`). */
  to: string;
  /** `writes` (the default) or `all` — "Writes & reads". */
  scope: 'writes' | 'all';
  /** The cursors of the pages BEHIND this one, oldest-first; the last is this page's. */
  cursors: string[];
  /** The entry number open in the detail, or null. */
  entry: number | null;
}

type RawParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseAuditLogQuery(params: RawParams): AuditLogQuery {
  const entryRaw = one(params['entry']);
  const from = one(params['from']);
  const to = one(params['to']);
  return {
    q: one(params['q']).slice(0, 200),
    actor: one(params['actor']),
    org: one(params['org']),
    action: one(params['action']),
    from: DAY.test(from) ? from : '',
    to: DAY.test(to) ? to : '',
    scope: one(params['scope']) === 'all' ? 'all' : 'writes',
    cursors: one(params['c'])
      .split(',')
      .filter((c) => /^[1-9]\d{0,9}$/.test(c)),
    entry: /^[1-9]\d{0,9}$/.test(entryRaw) ? Number(entryRaw) : null,
  };
}

/** The page's URL for a query (defaults omitted, so the bare route is the default view). */
export function auditLogHref(query: Partial<AuditLogQuery>): string {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.actor) p.set('actor', query.actor);
  if (query.org) p.set('org', query.org);
  if (query.action) p.set('action', query.action);
  if (query.from) p.set('from', query.from);
  if (query.to) p.set('to', query.to);
  if (query.scope === 'all') p.set('scope', 'all');
  if (query.cursors && query.cursors.length > 0) p.set('c', query.cursors.join(','));
  if (query.entry) p.set('entry', String(query.entry));
  const s = p.toString();
  return `/admin/audit-log${s ? `?${s}` : ''}`;
}

/** The day after `YYYY-MM-DD`, as an ISO date — the inclusive "Through" made exclusive. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The service's filters for a query. */
export function toSearchFilters(query: AuditLogQuery): PlatformAuditSearchFiltersDTO {
  return {
    text: query.q || null,
    actorUserId: query.actor || null,
    organizationId: query.org || null,
    action: query.action || null,
    dateFrom: query.from || null,
    dateTo: query.to ? nextDay(query.to) : null,
    writesOnly: query.scope !== 'all',
  };
}

/** True when any filter narrows the view (Clear filters shows). */
export function hasFilters(query: AuditLogQuery): boolean {
  return Boolean(query.q || query.actor || query.org || query.action || query.from || query.to);
}

/** The design's abbreviated hash — `9f3c…a41e`. */
export function shortHash(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;
}
