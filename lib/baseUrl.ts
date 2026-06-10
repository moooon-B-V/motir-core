// The canonical public origin for links rendered into outgoing emails
// (extracted from workspaceInvitesService when the 5.1.6 mention notification
// became its second consumer). Mirrors lib/auth/index.ts's baseURL resolution
// so every emailed link points at the same origin Better-Auth uses for its own
// emails — a deploy that works for sign-in works for invite + mention links
// too.

export function resolveBaseUrl(): string {
  return (
    process.env['BETTER_AUTH_URL'] ??
    (process.env['VERCEL_BRANCH_URL']
      ? `https://${process.env['VERCEL_BRANCH_URL']}`
      : process.env['VERCEL_URL']
        ? `https://${process.env['VERCEL_URL']}`
        : 'http://localhost:3000')
  );
}

/** The origin with any trailing slash trimmed — ready for path concatenation. */
export function resolveBaseUrlTrimmed(): string {
  return resolveBaseUrl().replace(/\/+$/, '');
}
