import type { WorkItemDeletePreviewDto } from '@/lib/dto/workItems';

// Client fetch helpers for the work-item ⋯ actions menu (Story 2.8 · Subtask
// 2.8.4) — the thin layer the menu + delete dialog call from detail / list /
// board. Each wraps one route; a non-2xx throws a typed `WorkItemActionError`
// carrying the route's `code` so the caller can branch (the menu re-checks the
// server's verdict; the dialog surfaces an atomic-failure message).

/** The typed `code` off a route's `{ code, error }` error body. */
export class WorkItemActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkItemActionError';
  }
}

async function readCode(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return data.code ?? 'UNKNOWN';
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new WorkItemActionError(await readCode(res));
  return res;
}

/** The cascade impact (2.8.7) the confirm dialog reads BEFORE deleting. */
export async function fetchDeletePreview(id: string): Promise<WorkItemDeletePreviewDto> {
  const res = await ensureOk(
    await fetch(`/api/work-items/${encodeURIComponent(id)}/delete-preview`),
  );
  return res.json() as Promise<WorkItemDeletePreviewDto>;
}

/** Permanent delete (2.8.3) — the item + its whole subtree. 204 on success. */
export async function deleteWorkItem(id: string): Promise<void> {
  await ensureOk(await fetch(`/api/work-items/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

/** Soft-archive (reversible, single-node). */
export async function archiveWorkItem(id: string): Promise<void> {
  await ensureOk(
    await fetch(`/api/work-items/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  );
}

/** Unarchive (restore) — the "Undo" after an archive. */
export async function unarchiveWorkItem(id: string): Promise<void> {
  await ensureOk(
    await fetch(`/api/work-items/${encodeURIComponent(id)}/archive`, { method: 'DELETE' }),
  );
}

/**
 * Set the item's sprint (Subtask 2.4.14) — `sprintId` a sprint to assign into,
 * or `null` to move it back to the backlog. Wraps the existing
 * `POST /api/work-items/[id]/sprint` route (4.1.4 — assignToSprint /
 * moveToBacklog); the response is the updated `WorkItemDto`. Used by the detail
 * rail's inline Sprint field AND the ⋯ menu's "Add to active sprint" quick
 * action.
 */
export async function setWorkItemSprint(
  id: string,
  sprintId: string | null,
): Promise<{ updatedAt: string; sprintId: string | null }> {
  const res = await ensureOk(
    await fetch(`/api/work-items/${encodeURIComponent(id)}/sprint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sprintId }),
    }),
  );
  const item = (await res.json()) as { updatedAt: string; sprintId: string | null };
  return { updatedAt: item.updatedAt, sprintId: item.sprintId };
}
