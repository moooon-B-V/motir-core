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
  // MOTIR-6769 — the pending feature requests (`public-request-board-retired.md`
  // Decision 2), after Roadmap where the design (MOTIR-6767) places its rail row.
  'requested-features',
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
 * The ten served shapes: eight views, plus `items/<key>` and `plans/<id>`. Any
 * other `/p/*` path — the bare `/p/<identifier>`, its changelog, a sub-segment
 * under any other view — is NOT a Visitor path and keeps its 308 to motir.co.
 */
const VIEW_PATH =
  /^\/p\/([^/]+)\/(?:(items|plans)(?:\/([^/]+))?|(tree|runs|board|roadmap|requested-features|approvals))\/?$/;

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
    // The Visitor's Requested features is the members' own Triage inbox
    // (MOTIR-7043 gave the members' side its old name back).
    case 'requested-features':
      return withQuery('/triage', params);
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
      // `/items/archived` is the member ARCHIVE, not a work item keyed `archived`:
      // the Visitor has no archive (MOTIR-6888).
      if (decodedSub === 'archived') return null;
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
    case 'triage':
      return decodedSub
        ? null
        : withQuery(visitorViewPath(identifier, 'requested-features'), params);
    default:
      return null;
  }
}

/**
 * Where a READER follows a MEMBER route (MOTIR-6888). The eight page bodies are
 * shared with the member app (MOTIR-6643), so every href they build names a
 * member route; on the Visitor route tree that route is the wrong project — the
 * member page reads the reader's OWN active project. `identifier` is the public
 * project the body is being served for, or null on a member page.
 *
 * - null identifier → the member path, unchanged;
 * - otherwise → its Visitor path inside `identifier`'s views (a `#fragment`
 *   kept), or null where the Visitor has none (an edit page, the archive, a
 *   sprint report), which the caller renders as no link at all.
 *
 * `proxy.ts`'s `visitorLinkRedirect` stays as a safety net, but it needs the
 * `motir_visitor` cookie, and a body that already emits the Visitor path needs
 * nothing.
 */
export function readerPath(identifier: string | null, memberPath: string): string | null {
  if (identifier === null) return memberPath;
  const hashAt = memberPath.indexOf('#');
  const hash = hashAt < 0 ? '' : memberPath.slice(hashAt);
  const path = hashAt < 0 ? memberPath : memberPath.slice(0, hashAt);
  const queryAt = path.indexOf('?');
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  const search = queryAt < 0 ? '' : path.slice(queryAt);
  const visitor = visitorPathForMemberPath(identifier, pathname, search);
  return visitor === null ? null : `${visitor}${hash}`;
}

/** The addresses a shared page body builds, for whichever reader it serves. */
export interface ReaderRoutes {
  /** The public project the body is served for, or null on a member page. */
  readonly identifier: string | null;
  /** A work item's page — every Visitor can read one, so never null. */
  item(key: string, hash?: string): string;
  /** A plan's page — every Visitor can read one, so never null. */
  plan(id: string): string;
  /**
   * One of the eight views' own lists, with its query (`/runs?scope=…`,
   * `/boards?…`, `/approvals?page=2`) — every Visitor has these, so never null.
   * An address the Visitor may have NO view of goes through {@link path}.
   */
  view(memberPath: string): string;
  /** Any other member route — null where the Visitor has no view of it. */
  path(memberPath: string): string | null;
}

/**
 * {@link ReaderRoutes} for a body served under `identifier` (null on a member
 * page). A Server Component takes the identifier from its page scope
 * (`pageScope(ctx).visitor?.project.identifier`); a client component uses
 * `useReaderRoutes`, which reads it from the pathname.
 */
export function readerRoutes(identifier: string | null): ReaderRoutes {
  return {
    identifier,
    item: (key, hash) =>
      `${
        identifier === null
          ? `/items/${encodeURIComponent(key)}`
          : visitorViewPath(identifier, 'items', key)
      }${hash ? `#${hash}` : ''}`,
    plan: (id) =>
      identifier === null
        ? `/plans/${encodeURIComponent(id)}`
        : visitorViewPath(identifier, 'plans', id),
    // A list address always maps (`visitorPathForMemberPath` answers every view
    // with any query); the member path is only a type-level fallback.
    view: (memberPath) => readerPath(identifier, memberPath) ?? memberPath,
    path: (memberPath) => readerPath(identifier, memberPath),
  };
}
