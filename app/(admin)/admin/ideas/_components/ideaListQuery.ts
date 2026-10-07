import type { IdeaCategory, IdeaKind, IdeaStatus } from '@/generated/prisma/client';
import { isIdeaCategory, isIdeaKind } from '@/lib/ideas/categories';

/**
 * The Ideas list's URL ↔ filter model (MOTIR-7680, design `platform-admin`
 * § Ideas → Data). A plain module, not a client file: the server page reads it
 * to build the service query, and the client filter bar reads it to build the
 * next URL — a value exported from a `'use client'` file reaches a Server
 * Component only as a client reference, never as the function.
 *
 * `?q=&status=active|retired|all&kind=&category=&tag=&cursor=`
 *  - `status` ABSENT is Active, the default; `all` is no status filter. So the
 *    default never appears in the URL, and a deep link with no query string is
 *    the page an operator lands on from the rail.
 *  - an unknown `kind` / `category` / `status` is dropped, never passed on, so a
 *    hand-edited URL reads as "no such filter" rather than an error state.
 *  - any filter change drops `cursor`: a cursor is a position in ONE result set.
 */

export const IDEA_FILTER_KEYS = ['q', 'status', 'kind', 'category', 'tag'] as const;
export type IdeaFilterKey = (typeof IDEA_FILTER_KEYS)[number];

/** The Status control's three values. `active` is the default and is never written. */
export type IdeaStatusView = 'active' | 'retired' | 'all';

export type IdeaSearchParams = Record<string, string | string[] | undefined>;

export interface IdeaListView {
  q?: string;
  status: IdeaStatusView;
  kind?: IdeaKind;
  category?: IdeaCategory;
  tag?: string;
  cursor?: string;
}

/** The service query a view asks for — `StaffIdeaFilters` without the limit. */
export interface IdeaListQuery {
  status?: IdeaStatus;
  kind?: IdeaKind;
  category?: IdeaCategory;
  tag?: string;
  q?: string;
  cursor?: string;
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read the view from a page's `searchParams`, dropping every value the store does not know. */
export function readIdeaListView(params: IdeaSearchParams): IdeaListView {
  const status = one(params['status']);
  const kind = one(params['kind']);
  const category = one(params['category']);
  const q = one(params['q']);
  const tag = one(params['tag']);
  const cursor = one(params['cursor']);
  return {
    status: status === 'retired' || status === 'all' ? status : 'active',
    ...(q ? { q } : {}),
    ...(kind && isIdeaKind(kind) ? { kind } : {}),
    ...(category && isIdeaCategory(category) ? { category } : {}),
    ...(tag ? { tag } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** The `listForStaff` filters for a view. */
export function toIdeaListQuery(view: IdeaListView): IdeaListQuery {
  return {
    ...(view.status === 'all' ? {} : { status: view.status }),
    ...(view.kind ? { kind: view.kind } : {}),
    ...(view.category ? { category: view.category } : {}),
    ...(view.tag ? { tag: view.tag } : {}),
    ...(view.q ? { q: view.q } : {}),
    ...(view.cursor ? { cursor: view.cursor } : {}),
  };
}

/** True when anything narrows the list beyond the default (Active, no filter). */
export function isFilteredView(view: IdeaListView): boolean {
  return view.status !== 'active' || Boolean(view.q || view.kind || view.category || view.tag);
}

/**
 * The list URL for a view. A filter change is `{ ...view, [key]: next }` with
 * `cursor` left out, which is what drops it; the pager keeps every filter and
 * sets `cursor` alone.
 */
export function ideaListHref(view: Partial<IdeaListView>): string {
  const url = new URLSearchParams();
  if (view.q) url.set('q', view.q);
  if (view.status && view.status !== 'active') url.set('status', view.status);
  if (view.kind) url.set('kind', view.kind);
  if (view.category) url.set('category', view.category);
  if (view.tag) url.set('tag', view.tag);
  if (view.cursor) url.set('cursor', view.cursor);
  const qs = url.toString();
  return qs ? `/admin/ideas?${qs}` : '/admin/ideas';
}

/** The same view with one filter changed (or cleared with `undefined`) and the cursor dropped. */
export function withIdeaFilter<K extends IdeaFilterKey>(
  view: IdeaListView,
  key: K,
  value: IdeaListView[K] | undefined,
): IdeaListView {
  const next: IdeaListView = { ...view };
  delete next.cursor;
  if (key === 'status') {
    next.status = (value as IdeaStatusView | undefined) ?? 'active';
  } else if (value === undefined || value === '') {
    delete next[key];
  } else {
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}
