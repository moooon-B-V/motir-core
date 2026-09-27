// The Visitor's ADDRESSES (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panel
// 5). Pure, so `proxy.ts`, the Visitor layout, the member redirect and the tests
// all read one table: which `/p/<identifier>/<view>` paths the app serves, and
// which member route each one is.

/** The Visitor's views, in the order the design's rail lists them. */
export const VISITOR_VIEWS = [
  'items',
  'tree',
  'runs',
  'board',
  'roadmap',
  'plans',
  'approvals',
] as const;

export type VisitorView = (typeof VISITOR_VIEWS)[number];

/** A view path, taken apart: the project key, the view and its one sub-segment. */
export interface VisitorPath {
  readonly identifier: string;
  readonly view: VisitorView;
  /** The work-item key (`items/<key>`) or the plan id (`plans/<id>`), else null. */
  readonly sub: string | null;
}

/**
 * The nine served shapes: seven views, plus `items/<key>` and `plans/<id>`. Any
 * other `/p/*` path — the bare `/p/<identifier>`, its changelog, a sub-segment
 * under any other view — is NOT a Visitor path and keeps its 308 to motir.co.
 */
const VIEW_PATH =
  /^\/p\/([^/]+)\/(?:(items|plans)(?:\/([^/]+))?|(tree|runs|board|roadmap|approvals))\/?$/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The Visitor view a PATHNAME names (no search string), or null. */
export function parseVisitorPath(pathname: string): VisitorPath | null {
  const match = VIEW_PATH.exec(pathname);
  if (!match) return null;
  const identifier = decode(match[1]!);
  if (!identifier) return null;
  const view = (match[2] ?? match[4]) as VisitorView;
  const rawSub = match[3];
  const sub = rawSub === undefined ? null : decode(rawSub);
  if (rawSub !== undefined && !sub) return null;
  return { identifier, view, sub };
}

/** `/p/<identifier>/<view>[/<sub>]` — a Visitor view's own path. */
export function visitorViewPath(identifier: string, view: VisitorView, sub?: string): string {
  const base = `/p/${encodeURIComponent(identifier)}/${view}`;
  return sub ? `${base}/${encodeURIComponent(sub)}` : base;
}

/** Split `path?search` into the pathname and the `URLSearchParams` after it. */
function splitPath(path: string): { pathname: string; params: URLSearchParams } {
  const at = path.search(/[?#]/);
  if (at < 0) return { pathname: path, params: new URLSearchParams() };
  const query = path[at] === '?' ? path.slice(at + 1).split('#')[0]! : '';
  return { pathname: path.slice(0, at), params: new URLSearchParams(query) };
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * The MEMBER route a Visitor path is (design panel 5's last column) — where a
 * reader who can ENTER the project is sent instead of the Visitor view. The query
 * the Visitor URL carried is kept; the list/tree choice becomes `?view=`.
 */
export function memberPathForVisitorPath(path: string): string | null {
  const { pathname, params } = splitPath(path);
  const parsed = parseVisitorPath(pathname);
  if (!parsed) return null;
  const { view, sub } = parsed;
  switch (view) {
    case 'items':
      if (sub) return withQuery(`/items/${encodeURIComponent(sub)}`, params);
      params.set('view', 'list');
      return withQuery('/items', params);
    case 'tree':
      params.set('view', 'tree');
      return withQuery('/items', params);
    case 'board':
      return withQuery('/boards', params);
    case 'plans':
      return withQuery(sub ? `/plans/${encodeURIComponent(sub)}` : '/plans', params);
    case 'roadmap':
    case 'approvals':
    case 'runs':
      return withQuery(`/${view}`, params);
  }
}

/**
 * The Visitor path a MEMBER route is, inside `identifier`'s Visitor views — the
 * inverse of {@link memberPathForVisitorPath}. A page body shared with the member
 * app emits member hrefs (a row's `/items/<key>`, a pager's `/runs?…`); followed
 * from a Visitor page, `proxy.ts` sends each one here instead of onto the member
 * gate. Null for a member route that has no Visitor view.
 */
export function visitorPathForMemberPath(
  identifier: string,
  pathname: string,
  search: string,
): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const segments = pathname.replace(/\/+$/, '').split('/').slice(1);
  const [head, sub, ...rest] = segments;
  if (rest.length > 0 || head === undefined) return null;
  const decodedSub = sub === undefined ? undefined : (decode(sub) ?? undefined);
  if (sub !== undefined && decodedSub === undefined) return null;
  switch (head) {
    case 'items': {
      if (decodedSub) return withQuery(visitorViewPath(identifier, 'items', decodedSub), params);
      const tree = params.get('view') === 'tree';
      params.delete('view');
      return withQuery(visitorViewPath(identifier, tree ? 'tree' : 'items'), params);
    }
    case 'plans':
      return withQuery(visitorViewPath(identifier, 'plans', decodedSub), params);
    case 'boards':
      return decodedSub ? null : withQuery(visitorViewPath(identifier, 'board'), params);
    case 'roadmap':
    case 'approvals':
    case 'runs':
      return decodedSub ? null : withQuery(visitorViewPath(identifier, head), params);
    default:
      return null;
  }
}
