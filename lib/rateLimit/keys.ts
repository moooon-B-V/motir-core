import { hashToken } from '@/lib/apiTokens/token';

// Building a rate-limit KEY (Subtask 8.5.9 / MOTIR-1165).
//
// ⚠️ EVERY CALLER COMPONENT IS HASHED. The pre-auth surfaces key on IP address,
// and an IP is personal data under GDPR; the auth surfaces additionally key on
// the submitted email. Storing either in the clear would turn the counter table
// into a log of who tried to sign in from where — a table with a very different
// legal weight from a set of opaque short-lived strings. So the components go
// through `hashToken` (sha-256 hex), the SAME fingerprint `/api/v1` already uses
// for its bearer token, and the table never sees a plaintext identifier.
// Required by `docs/decisions/production-service-stack.md` §7, which is also why
// the table carries no `workspace_id` and no RLS: there is nothing left in the
// key for a tenancy boundary to protect.
//
// The SCOPE prefix stays in the clear on purpose. It names the SURFACE, not the
// caller — `auth:sign-in`, `public-write`, `ai:chat` — so an operator can tell
// which limiter a row belongs to, and two surfaces can never share a bucket by
// accident. It is not personal data and hashing it would only make the table
// unreadable to us.

/** The limiter classes, one per surface family the card covers. */
export type RateLimitScope =
  | 'auth:sign-in'
  | 'auth:sign-up'
  | 'auth:password-reset'
  | 'public-write'
  | 'ai:chat'
  | 'ai:internal'
  | 'account:change-password'
  | 'account:set-password-link'
  | 'idea-draft';

/**
 * A stable, non-reversible key for `scope` + the caller components.
 *
 * Components are hashed INDIVIDUALLY rather than as one joined string, so an
 * `ip` of `"a:b"` can never collide with an `(ip, identifier)` pair of
 * `("a", "b")` — a separator injected through user-supplied input is exactly the
 * kind of collision that silently merges two callers' budgets.
 */
export function rateLimitKey(scope: RateLimitScope, ...components: string[]): string {
  return [scope, ...components.map((c) => hashToken(c))].join(':');
}

/**
 * The client's IP, as the first hop of `x-forwarded-for`.
 *
 * Behind Fly's proxy that header is set by the edge, so the first hop is the real
 * client. A request that arrives with no header at all (a direct hit, a
 * misconfigured proxy) falls into ONE shared `unknown` bucket rather than being
 * left unlimited — the conservative direction: an unattributable request may be
 * throttled alongside others, but it is never free.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}
