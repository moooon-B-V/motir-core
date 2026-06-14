// DTOs for the api-token surface (Story 7.8 · Subtask 7.8.1) — the shape that
// crosses the API boundary to the Settings → Account → API tokens surface
// (7.8.3) and back. The `tokenHash` NEVER appears in a DTO; the plaintext
// secret appears in exactly one place ever — `CreateApiTokenResult.token`.

/** One token as the settings list renders it. Display-safe: the `tokenPrefix`
 * is a hint, never the secret, and there is no `tokenHash`. Dates are ISO
 * strings (the API-boundary convention). */
export interface ApiTokenDto {
  id: string;
  label: string;
  /** First chars of the secret, e.g. `motir_pat_Ab` — display-only. */
  tokenPrefix: string;
  createdAt: string;
  /** Null = never expires. */
  expiresAt: string | null;
  /** Null = never used since mint. */
  lastUsedAt: string | null;
  /** Non-null = soft-revoked (the muted "Revoked" row). */
  revokedAt: string | null;
}

/** The create result. `token` is the FULL plaintext secret — returned ONCE,
 * never persisted, never logged; the caller shows it once with a copy
 * affordance and then it is irretrievable. `dto` is the same display-safe row
 * the list shows. */
export interface CreateApiTokenResult {
  token: string;
  dto: ApiTokenDto;
}
