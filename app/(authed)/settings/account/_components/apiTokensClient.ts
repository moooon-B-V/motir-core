import type { ApiTokenDto, CreateApiTokenResult } from '@/lib/dto/apiTokens';

// Thin fetch layer over the 7.8.3 routes (`/api/me/api-tokens`) for the API
// tokens pane's client island. The island owns its own list state and does
// OPTIMISTIC insert / mark-revoked from these responses (the
// page-state-after-mutation contract — no `router.refresh()` it can't see), so
// there is no list-refetch helper here: the create/revoke responses carry the
// authoritative row.

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
}): Promise<CreateApiTokenResult> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ApiError(await readErrorCode(res));
  return (await res.json()) as CreateApiTokenResult;
}

/** Soft-revoke one of the user's own tokens; returns the updated (revoked) row. */
export async function revokeToken(tokenId: string): Promise<ApiTokenDto> {
  const res = await fetch(`${BASE}/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(await readErrorCode(res));
  const data = (await res.json()) as { token: ApiTokenDto };
  return data.token;
}
