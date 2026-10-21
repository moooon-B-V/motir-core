import type { PageWorkItemsDto } from '@/lib/dto/pageLinks';

// The page's Linked work items read, from the browser (Story MOTIR-7567 ·
// MOTIR-9200) — `GET /api/pages/<pageId>/work-items?cursor=`, the route
// MOTIR-9198 built. One page of hand links per call, newest link first; the
// route's own page size is the strip's, so no `limit` is sent.
//
// A plain module, not part of the `'use client'` strip: it is a value, and a
// value exported from a client module is a client REFERENCE on the server
// (`tests/components/item-detail-client-imports.test.ts`).

/** The route answered with something other than a page of rows. */
export class PageLinkedWorkItemsReadError extends Error {
  constructor(readonly status: number) {
    super(`Page linked work items read failed (${status})`);
    this.name = 'PageLinkedWorkItemsReadError';
  }
}

/**
 * One page of the work items hand-linked to `pageId`; `cursor` is the previous
 * page's `nextCursor`, or `null` for the first. Throws
 * `PageLinkedWorkItemsReadError` on any non-2xx answer and lets a network failure
 * reject as it does.
 */
export async function fetchPageLinkedWorkItems(
  pageId: string,
  cursor: string | null,
): Promise<PageWorkItemsDto> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/work-items${query}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new PageLinkedWorkItemsReadError(res.status);
  return (await res.json()) as PageWorkItemsDto;
}
