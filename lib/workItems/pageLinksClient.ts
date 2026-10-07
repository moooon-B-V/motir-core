import type { WorkItemPagesDto } from '@/lib/dto/pageLinks';

// The work item page's Pages read, from the browser (Story MOTIR-7565 ·
// MOTIR-7575) — `GET /api/work-items/<id>/pages?cursor=`, the route MOTIR-7573
// built. One page of rows per call, newest edit first; the route's own default
// page size (50) is the section's, so no `limit` is sent.
//
// A plain module, not part of the `'use client'` section: it is a value, and a
// value exported from a client module is a client REFERENCE on the server
// (`tests/components/item-detail-client-imports.test.ts`).

/** The route answered with something other than a page of rows. */
export class WorkItemPagesReadError extends Error {
  constructor(readonly status: number) {
    super(`Work item pages read failed (${status})`);
    this.name = 'WorkItemPagesReadError';
  }
}

/**
 * One page of the pages linking to `workItemId`; `cursor` is the previous page's
 * `nextCursor`, or `null` for the first. Throws `WorkItemPagesReadError` on any
 * non-2xx answer (403 without `page:view`, 404, 400 for a foreign cursor) and
 * lets a network failure reject as it does.
 */
export async function fetchWorkItemPages(
  workItemId: string,
  cursor: string | null,
): Promise<WorkItemPagesDto> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  const res = await fetch(`/api/work-items/${encodeURIComponent(workItemId)}/pages${query}`);
  if (!res.ok) throw new WorkItemPagesReadError(res.status);
  return (await res.json()) as WorkItemPagesDto;
}
