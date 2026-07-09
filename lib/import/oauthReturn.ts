// Shared return-path handling for the import-source OAuth "Connect" flows
// (Story 7.16 · MOTIR-942). The per-vendor start/callback routes (Jira/Linear/
// Plane, MOTIR-1654/1655/1656) originally hardcoded `/onboarding/import` as the
// post-connect return target, which PINNED the whole wizard to that one door.
// The wizard's design has TWO doors (the /onboarding entrance AND Settings ›
// Project › Import), so the connect round-trip must return to WHEREVER it was
// launched from. The start route reads a `returnTo`, stashes the SAFE value in a
// cookie, and the callback sends the member back there with the status banner.

/** The wizard's canonical home — the fallback when no (or an unsafe) `returnTo`
 *  is supplied. */
export const IMPORT_RETURN_DEFAULT = '/onboarding/import';

/** The httpOnly cookie the start route stashes the validated return path in, so
 *  the callback (a top-level redirect from the vendor, which carries no query of
 *  ours) knows where to send the member back. Single-use — the callback clears
 *  it on every terminal outcome, like the state/verifier nonces. Shared across
 *  all three vendors (only one connect flow is ever in flight per browser). */
export const IMPORT_OAUTH_RETURN_COOKIE = 'import_oauth_return';

/**
 * Coerce a caller-supplied `returnTo` to a SAFE same-origin internal path, or
 * fall back to the wizard home. This guards the open-redirect class: the value
 * becomes an app URL a member is redirected to, so it MUST NOT be able to name
 * another origin. Accepted only when it:
 *   - begins with a single `/` (a path, not an absolute/scheme URL);
 *   - is NOT protocol-relative (`//host`) or a backslash trick (`/\`, `\`);
 *   - carries no control characters;
 *   - and its PATH (query/hash stripped) is one of the wizard's known doors —
 *     `/onboarding/import` or any `/settings/…` page (the future Settings home).
 * Everything else returns the default. The query string (e.g. `?projectId=…`) is
 * preserved so a resume URL survives the round-trip.
 */
export function safeImportReturnPath(candidate: string | null | undefined): string {
  if (!candidate) return IMPORT_RETURN_DEFAULT;

  let value = candidate;
  // A start route may receive it URL-encoded once (a Link/href param); decode a
  // single layer defensively. A malformed escape → reject to the default.
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return IMPORT_RETURN_DEFAULT;
    }
  }

  if (!value.startsWith('/')) return IMPORT_RETURN_DEFAULT; // absolute/scheme URL
  if (value.startsWith('//') || value.startsWith('/\\')) return IMPORT_RETURN_DEFAULT; // protocol-relative
  if (value.includes('\\')) return IMPORT_RETURN_DEFAULT; // backslash tricks
  // Reject any control character (codepoint < 0x20 or DEL) without a
  // literal control byte in source.
  if (
    [...value].some((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  )
    return IMPORT_RETURN_DEFAULT;

  const path = value.split(/[?#]/, 1)[0] ?? value;
  const allowed = path === '/onboarding/import' || path.startsWith('/settings/');
  return allowed ? value : IMPORT_RETURN_DEFAULT;
}

/**
 * Append a `key=status` query param to a return path that may already carry a
 * query and/or a hash — the wizard reads it to render the connect banner.
 */
export function appendStatus(returnTo: string, key: string, status: string): string {
  const hashIndex = returnTo.indexOf('#');
  const hash = hashIndex === -1 ? '' : returnTo.slice(hashIndex);
  const pathAndQuery = hashIndex === -1 ? returnTo : returnTo.slice(0, hashIndex);
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return `${pathAndQuery}${sep}${key}=${encodeURIComponent(status)}${hash}`;
}
