import {
  canChangeSavedFilterOwner,
  canManageSavedFilter,
  type SavedFilterProjectCapabilities,
} from '@/lib/savedFilters/access';
import type {
  BuiltinFilterSummaryDto,
  ResolvedSavedFilterDto,
  SavedFilterDependentsDto,
  SavedFilterPageDto,
  SavedFilterSummaryDto,
} from '@/lib/dto/savedFilters';

// Client helpers for the Filters directory (Story 6.2 · Subtask 6.2.4) — the
// thin fetch layer over the 6.2.1 routes plus the per-row capability
// derivation. The matrix itself lives once in lib/savedFilters/access.ts (pure,
// no IO) and is REUSED here so the UI gating and the server gate can never
// drift — the client decides whether to SHOW an action, the route re-checks it
// (403) on every write.

export type { SavedFilterSummaryDto, BuiltinFilterSummaryDto };

/** The actor's project-level tier, resolved server-side and handed down. */
export interface Viewer extends SavedFilterProjectCapabilities {
  userId: string;
}

/** Whether each row action is allowed for the viewer — computed from the pure
 * matrix over the page-level tier + the row's facts (the row is, by being in
 * the list, already visible). */
export interface RowCapabilities {
  canManage: boolean;
  canChangeOwner: boolean;
}

export function rowCapabilities(viewer: Viewer, row: SavedFilterSummaryDto): RowCapabilities {
  const facts = { isOwner: row.owner.id === viewer.userId, visibility: row.visibility };
  return {
    canManage: canManageSavedFilter(viewer, facts),
    canChangeOwner: canChangeSavedFilterOwner(viewer, facts),
  };
}

/** Pull the typed `code` off an error JSON body (the routes return
 * `{ code, error }`); falls back to `'UNKNOWN'`. */
export async function readErrorCode(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return data.code ?? 'UNKNOWN';
}

export class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiError';
  }
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new ApiError(await readErrorCode(res));
  return res;
}

const base = (projectKey: string) =>
  `/api/projects/${encodeURIComponent(projectKey)}/saved-filters`;

export interface ListParams {
  q?: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export async function listFilters(
  projectKey: string,
  { q, cursor, limit = 50, signal }: ListParams,
): Promise<SavedFilterPageDto> {
  const params = new URLSearchParams({ view: 'all', limit: String(limit) });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const res = await ensureOk(await fetch(`${base(projectKey)}?${params.toString()}`, { signal }));
  return res.json() as Promise<SavedFilterPageDto>;
}

export async function resolveFilter(
  projectKey: string,
  filterId: string,
): Promise<ResolvedSavedFilterDto> {
  const res = await ensureOk(await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}`));
  return res.json() as Promise<ResolvedSavedFilterDto>;
}

export interface UpdateFilterInput {
  name?: string;
  description?: string | null;
  visibility?: 'private' | 'project';
}

export async function updateFilter(
  projectKey: string,
  filterId: string,
  input: UpdateFilterInput,
): Promise<SavedFilterSummaryDto> {
  const res = await ensureOk(
    await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  const data = (await res.json()) as { filter: SavedFilterSummaryDto };
  return data.filter;
}

export async function changeOwner(
  projectKey: string,
  filterId: string,
  ownerId: string,
): Promise<SavedFilterSummaryDto> {
  const res = await ensureOk(
    await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerId }),
    }),
  );
  const data = (await res.json()) as { filter: SavedFilterSummaryDto };
  return data.filter;
}

export async function deleteFilter(projectKey: string, filterId: string): Promise<void> {
  await ensureOk(
    await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}`, { method: 'DELETE' }),
  );
}

export async function getDependents(
  projectKey: string,
  filterId: string,
): Promise<SavedFilterDependentsDto> {
  const res = await ensureOk(
    await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}/dependents`),
  );
  return res.json() as Promise<SavedFilterDependentsDto>;
}

export async function setStar(
  projectKey: string,
  filterId: string,
  starred: boolean,
): Promise<SavedFilterSummaryDto> {
  const res = await ensureOk(
    await fetch(`${base(projectKey)}/${encodeURIComponent(filterId)}/star`, {
      method: starred ? 'PUT' : 'DELETE',
    }),
  );
  const data = (await res.json()) as { filter: SavedFilterSummaryDto };
  return data.filter;
}

export interface ProjectMemberOption {
  userId: string;
  name: string;
  email: string;
}

export async function listProjectMembers(projectKey: string): Promise<ProjectMemberOption[]> {
  const res = await ensureOk(
    await fetch(`/api/projects/${encodeURIComponent(projectKey)}/members`),
  );
  const data = (await res.json()) as { members: ProjectMemberOption[] };
  return data.members;
}
