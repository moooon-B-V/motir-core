// Thin fetch layer over the 8.8.22 change-email route
// (`POST /api/account/request-email-change`) for the Profile pane's Email row
// client island (Subtask 8.8.24b). Mirrors `apiTokensClient` (the sibling
// API-tokens island): one POST, and on a non-2xx response the typed `code` is
// pulled off the `{ code }` error body and thrown as an `EmailChangeError` so
// the modal can map it to field copy. The route never returns anything
// sensitive (the confirm token goes by email), so a success is just `{ ok }`.

/** The discriminating `code`s the 8.8.22 route returns (see
 *  `app/api/account/request-email-change/route.ts` + `lib/users/errors.ts`). */
export type EmailChangeErrorCode =
  | 'INVALID_EMAIL'
  | 'SAME_EMAIL'
  | 'EMAIL_TAKEN'
  | 'EMAIL_CHANGE_RATE_LIMITED'
  | 'USER_NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'BAD_REQUEST'
  | 'UNKNOWN';

export class EmailChangeError extends Error {
  constructor(readonly code: EmailChangeErrorCode) {
    super(code);
    this.name = 'EmailChangeError';
  }
}

/** Pull the typed `code` off an error JSON body (`{ code, error }`). */
async function readErrorCode(res: Response): Promise<EmailChangeErrorCode> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return (data.code as EmailChangeErrorCode) ?? 'UNKNOWN';
}

/**
 * Request a verified change of the signed-in user's email to `newEmail`. On
 * success the server has recorded a pending request and emailed a confirm link
 * to the NEW address — the swap happens only when that link is clicked, so the
 * caller shows a confirmation-pending state, not a completed change. Throws
 * `EmailChangeError` carrying the route's typed `code` on any non-2xx.
 */
export async function requestEmailChange(newEmail: string): Promise<void> {
  const res = await fetch('/api/account/request-email-change', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newEmail }),
  });
  if (!res.ok) throw new EmailChangeError(await readErrorCode(res));
}
