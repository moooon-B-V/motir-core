import type {
  ArchivePageResultDto,
  DeletePageResultDto,
  PageArchiveSetDto,
  RestorePageResultDto,
} from '@/lib/dto/pages';

// The browser's half of the page archive doors (Story MOTIR-5755 · MOTIR-7423) —
// `app/api/pages/[pageId]/archive` (GET describe · POST archive · DELETE restore)
// and `DELETE /api/pages/[pageId]` (permanent delete, MOTIR-7422). One place
// turns each answer into a typed outcome, so the tree, the page's own menu, the
// archived banner and the Archived pages list read the SAME refusal codes:
//
//   409 PAGE_ARCHIVED               → 'alreadyArchived' (archive, from a stale tab)
//   409 PAGE_NOT_ARCHIVED           → 'notArchived'     (restore or delete, stale)
//   409 PAGE_ARCHIVE_ROOT_REQUIRED  → 'rootRequired'    (with the root's id)
//   404 PAGE_NOT_FOUND              → 'gone'
//   anything else, or no answer     → 'failed'

export type ArchiveRefusal =
  | { kind: 'alreadyArchived' }
  | { kind: 'notArchived' }
  | { kind: 'rootRequired'; rootId: string | null }
  | { kind: 'gone' }
  | { kind: 'failed' };

export type ArchiveOutcome<T> = { ok: true; result: T } | ({ ok: false } & ArchiveRefusal);

function archiveUrl(pageId: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/archive`;
}

async function call<T>(url: string, init?: RequestInit): Promise<ArchiveOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, kind: 'failed' };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, result: body as T };
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'PAGE_ARCHIVED') return { ok: false, kind: 'alreadyArchived' };
  if (code === 'PAGE_NOT_ARCHIVED') return { ok: false, kind: 'notArchived' };
  if (code === 'PAGE_ARCHIVE_ROOT_REQUIRED') {
    return {
      ok: false,
      kind: 'rootRequired',
      rootId: typeof body.rootId === 'string' ? body.rootId : null,
    };
  }
  if (res.status === 404) return { ok: false, kind: 'gone' };
  return { ok: false, kind: 'failed' };
}

/** The sub-pages an archive of the page takes (live) or took (archived). */
export function readArchiveSet(pageId: string): Promise<ArchiveOutcome<PageArchiveSetDto>> {
  return call<PageArchiveSetDto>(archiveUrl(pageId));
}

/** Archive the page with every live sub-page under it. */
export function archivePageRequest(pageId: string): Promise<ArchiveOutcome<ArchivePageResultDto>> {
  return call<ArchivePageResultDto>(archiveUrl(pageId), { method: 'POST' });
}

/** Restore an archive root and its set. */
export function restorePageRequest(pageId: string): Promise<ArchiveOutcome<RestorePageResultDto>> {
  return call<RestorePageResultDto>(archiveUrl(pageId), { method: 'DELETE' });
}

/** Permanently delete an archive root and its set (Manager only). */
export function deletePageRequest(pageId: string): Promise<ArchiveOutcome<DeletePageResultDto>> {
  return call<DeletePageResultDto>(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'DELETE',
  });
}
