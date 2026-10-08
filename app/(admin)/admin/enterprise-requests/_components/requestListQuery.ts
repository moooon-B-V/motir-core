import {
  ENTERPRISE_REQUEST_FILTERS,
  type EnterpriseRequestFilter,
} from '@/lib/dto/platformEnterpriseRequest';

/**
 * The Enterprise-request list's URL state — design `platform-admin` § Enterprise
 * requests Panels 1–2. The state filter and the Newer/Older keyset stack live in
 * the query string, so a filtered page is linkable and a reload agrees with it.
 * The server answers every change (a new filter or page is a new read), so the
 * filter writes with `router.push` and the pager is plain links.
 *
 * The stack is the audit log's grammar (`audit-log/_components/auditLogUrl.ts`):
 * `?c=` carries the cursors of the pages BEHIND this one, oldest first, the last
 * being this page's. Older pushes the page's `nextCursor`; Newer pops.
 */
export interface RequestListView {
  /** The state filter; `open` (new · contacted · offer sent) by default. */
  filter: EnterpriseRequestFilter;
  /** The cursor stack — empty on the first page. */
  cursors: string[];
}

export type RequestListSearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** A request id as the service issues it (a cuid) — anything else is dropped. */
const CURSOR = /^[a-z0-9]{8,64}$/i;

/** Read the view from a page's search params. An unknown filter is the default view. */
export function readRequestListView(params: RequestListSearchParams): RequestListView {
  const raw = one(params['state']);
  const filter = (ENTERPRISE_REQUEST_FILTERS as readonly string[]).includes(raw)
    ? (raw as EnterpriseRequestFilter)
    : 'open';
  const cursors = one(params['c'])
    .split(',')
    .filter((c) => CURSOR.test(c))
    .slice(0, 200);
  return { filter, cursors };
}

/** The list's URL for a view — defaults omitted, so the bare route is the default view. */
export function requestListHref(view: Partial<RequestListView> = {}): string {
  const p = new URLSearchParams();
  if (view.filter && view.filter !== 'open') p.set('state', view.filter);
  if (view.cursors && view.cursors.length > 0) p.set('c', view.cursors.join(','));
  const s = p.toString();
  return `/admin/enterprise-requests${s ? `?${s}` : ''}`;
}

/** A request's detail URL. */
export function requestDetailHref(id: string): string {
  return `/admin/enterprise-requests/${encodeURIComponent(id)}`;
}

/** The tenant page an org link opens. */
export function tenantHref(organizationId: string): string {
  return `/admin/tenants/${encodeURIComponent(organizationId)}`;
}
