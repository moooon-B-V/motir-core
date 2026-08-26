import type { ApiTokenDto, CreateApiTokenResult } from '@/lib/dto/apiTokens';
import type { PermissionKey } from '@/lib/permissions/catalog';

// Thin fetch layer over the 7.8.3 routes (`/api/me/api-tokens`) for the API
// tokens pane's client island. The island owns its own list state and does
// OPTIMISTIC insert / REMOVE from these responses (the
// page-state-after-mutation contract — no `router.refresh()` it can't see), so
// there is no list-refetch helper here: create carries the authoritative row,
// and a revoke DELETES its row (MOTIR-3546) so there is no row to carry back —
// a `204` is the whole answer and the island splices the row out.

export type { ApiTokenDto, CreateApiTokenResult };

/** The expiry options the create modal offers — days, or `null` for "never". */
export type ExpiryChoice = 30 | 90 | 365 | null;

export class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Pull the typed `code` off an error JSON body (`{ code, error }`). */
async function readErrorCode(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return data.code ?? 'UNKNOWN';
}

const BASE = '/api/me/api-tokens';

/** Mint a token. The result's `token` is the FULL plaintext secret, returned
 * ONCE — the caller shows it once and never persists it. */
export async function createToken(input: {
  label: string;
  expiresInDays: ExpiryChoice;
  /** The workspace the token is scoped to (bug 7.21) — chosen in the modal. */
  workspaceId: string;
  /** The GRANT — the permission keys toggled in the modal's Permissions picker
   * (MOTIR-2580). Travels WITH `projectId`: a chosen grant must name the project
   * it applies to, because permissions resolve per project. */
  permissions: PermissionKey[];
  /** The PROJECT the token is bound to (MOTIR-2606) — required alongside a
   * chosen grant. */
  projectId: string;
}): Promise<CreateApiTokenResult> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ApiError(await readErrorCode(res));
  return (await res.json()) as CreateApiTokenResult;
}

/**
 * Revoke one of the user's own tokens — the row is DELETED (MOTIR-3546), so the
 * route answers `204` with no body and there is nothing to return. The caller
 * removes the row from its own state.
 */
export async function revokeToken(tokenId: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(await readErrorCode(res));
}
