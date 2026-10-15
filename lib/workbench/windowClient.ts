import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// The typed client for `GET /api/workbench/window` (Story MOTIR-8539 · Subtask
// MOTIR-8573) — what a Workbench applier re-reads in place of a route refresh.
// It moves no route and touches no address: the caller owns what it does with
// the answer.

export const WORKBENCH_WINDOW_PATH = '/api/workbench/window';

/** The window's address for `tab` and `page`. */
export function workbenchWindowUrl(tab: WorkbenchTab, page: number): string {
  const params = new URLSearchParams({ tab });
  if (page > 1) params.set('page', String(page));
  return `${WORKBENCH_WINDOW_PATH}?${params.toString()}`;
}

/** Read the active tab's window and every strip count. Throws on a non-2xx answer. */
export async function fetchWorkbenchWindow({
  tab,
  page,
  signal,
}: {
  tab: WorkbenchTab;
  page: number;
  signal?: AbortSignal;
}): Promise<WorkbenchWindowDto> {
  const res = await fetch(workbenchWindowUrl(tab, page), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`workbench window ${res.status}`);
  return (await res.json()) as WorkbenchWindowDto;
}
