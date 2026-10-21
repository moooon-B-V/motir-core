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

/**
 * A hand-link write's answer (Story MOTIR-7567 · MOTIR-9199): the HTTP status
 * and the refusal's `code`, read from the response body — the shape
 * `pageErrorResponse` sends — so a caller discriminates refusals without parsing
 * prose. `code` is `null` when the body carried none (a network proxy's 502, say).
 * A network failure rejects as `fetch` does.
 */
export type PageLinkWriteResult =
  | { ok: true; status: number }
  | { ok: false; status: number; code: string | null };

async function writeResult(res: Response): Promise<PageLinkWriteResult> {
  if (res.ok) return { ok: true, status: res.status };
  let code: string | null = null;
  try {
    const body = (await res.json()) as { code?: unknown };
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // A non-JSON refusal has no code; the status family decides.
  }
  return { ok: false, status: res.status, code };
}

/** Hand-link `pageId` to `workItemId` — `POST /api/work-items/<id>/pages { pageId }`. */
export async function linkPageToWorkItem(
  workItemId: string,
  pageId: string,
): Promise<PageLinkWriteResult> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(workItemId)}/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ pageId }),
  });
  return writeResult(res);
}

/** Remove the hand link — `DELETE /api/work-items/<id>/pages/<pageId>`. */
export async function unlinkPageFromWorkItem(
  workItemId: string,
  pageId: string,
): Promise<PageLinkWriteResult> {
  const res = await fetch(
    `/api/work-items/${encodeURIComponent(workItemId)}/pages/${encodeURIComponent(pageId)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
  );
  return writeResult(res);
}
