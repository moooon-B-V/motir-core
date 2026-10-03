import 'server-only';

import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import type { StaffSessionDTO } from '@/lib/dto/platformImpersonation';
import { ImpersonationCredentialRefusedError, ImpersonationReadOnlyError } from './errors';

/**
 * The REQUEST PATH of a staff "View as" session (Story 10.3 · MOTIR-749) — how
 * the session is carried, and the chokepoint that enforces it.
 *
 * ── HOW IT IS CARRIED ────────────────────────────────────────────────────────
 * The operator keeps their own Better-Auth session. Starting a session sets ONE
 * more cookie, {@link STAFF_SESSION_COOKIE}: httpOnly, `sameSite: lax`, expiring
 * with the time-box, holding a random token whose SHA-256 is the
 * `impersonation_session` row's key. Nothing is minted for the customer and the
 * customer's credentials are never touched — the "no raw tokens, no shared
 * session" control of the safe-impersonation pattern.
 *
 * `readSession` (`lib/auth/index.ts`) — the single place every session read in
 * the app goes through — reads the operator's session, and when this cookie is
 * present hands both to {@link applyStaffSession}. That resolves the row
 * (`impersonationService.resolveForRequest`) and answers:
 *
 *   · ACTIVE → the TARGET's identity, with `impersonation` attached (the
 *     session, and the operator's own identity for attribution);
 *   · ENDED / EXPIRED / REVOKED / unknown → `null`: the request is signed out
 *     until the cookie is cleared. Fail closed — never the operator's own self
 *     in a tenant they believe is the customer's. The (authed) layout turns that
 *     into a redirect through `/api/staff-session/clear` to the ended page.
 *
 * The platform console never reads through this: `requirePlatformStaff` reads
 * the operator's raw session whenever the cookie is present
 * (`lib/platform/auth.ts`), so the console is the operator's own in a session.
 *
 * ── THE CHOKEPOINT ───────────────────────────────────────────────────────────
 * Because every tenant door resolves its actor through `readSession` — cookie
 * pages, Server Actions, the cookie API (`requireCompliantSession`,
 * `getWorkspaceContext`, `resolveWorkspaceContext`) — the mode is enforced HERE,
 * once, rather than per route:
 *
 *   · READ-ONLY: a MUTATING request throws {@link ImpersonationReadOnlyError}
 *     before any service runs. The cookie API doors answer it 403
 *     `IMPERSONATION_READ_ONLY`.
 *   · FULL: a mutating request is AUDITED (`user.impersonation_action`, the
 *     session's reason, the operator as actor) BEFORE it runs; if the audit row
 *     cannot be written, the request fails.
 *   · Either mode: a tenant PAGE render is audited `user.impersonation_view`.
 *
 * Bearer doors (PATs, device credentials, run tokens, OAuth) never read the
 * cookie, so a staff session never reaches them; and minting a NEW credential
 * as the customer is refused in every mode ({@link assertNoStaffSessionCookie}).
 *
 * The resolution is MEMOISED per request (keyed on the request's `Headers`
 * object, which Next returns as one instance per request), so a Server Action
 * that reads the session twice is resolved, refused or audited once.
 */

/** The staff-session cookie. Its value is the random token, nothing else. */
export const STAFF_SESSION_COOKIE = 'motir_staff_session';

/** The cookie's attributes; `expires` is the session's time-box. */
export function staffSessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: shouldUseSecureCookies(),
    expires: expiresAt,
  };
}

/** The header the proxy sets on every tenant PAGE request (`proxy.ts`, MOTIR-3652). */
const CURRENT_PATH_HEADER = 'x-current-path';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The staff-session token a request carries, or null. */
export function readStaffSessionToken(requestHeaders: Headers): string | null {
  const header = requestHeaders.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== STAFF_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** What this request is, for the gate. */
export interface StaffRequestClassification {
  mutating: boolean;
  pageView: boolean;
  method: string | null;
  path: string | null;
  serverAction: string | null;
}

/**
 * Classify a request inside a staff session.
 *
 * MUTATING is decided by three signals, strongest first:
 *
 *   1. A Server Action on a TENANT page — the `next-action` header Next puts on
 *      every action POST, together with the proxy's `x-current-path` (the proxy
 *      runs on every tenant page path and on nothing under `/admin`, so a
 *      console action is never mistaken for a tenant write).
 *   2. The HTTP method, when the caller holds the `Request`
 *      (`resolveWorkspaceContext`): anything but GET / HEAD / OPTIONS.
 *   3. Otherwise the browser's own `Origin` rule. The Fetch standard attaches
 *      `Origin` to every request whose method is not GET or HEAD — same-origin
 *      included — and to no same-origin GET or HEAD, which is how a route
 *      handler reached through `next/headers` (which carries no method) is
 *      told apart. This is a SAFETY RAIL for the operator's own browser, not a
 *      boundary against them: the operator is a superadmin who can open a
 *      full-access session at will, and the session is bound to their sign-in.
 *      An unexpected `Origin` errs towards "mutating" — refused in read-only,
 *      recorded in full — never the other way.
 *
 * A PAGE VIEW is a non-mutating request on a tenant page (`x-current-path`),
 * excluding the router's prefetches, which nobody opened.
 */
export function classifyStaffRequest(
  requestHeaders: Headers,
  method: string | null = null,
): StaffRequestClassification {
  const path = requestHeaders.get(CURRENT_PATH_HEADER);
  const serverAction = requestHeaders.get('next-action');
  const upper = method?.toUpperCase() ?? null;
  let mutating: boolean;
  if (serverAction) {
    mutating = path !== null;
  } else if (upper) {
    mutating = !SAFE_METHODS.has(upper);
  } else {
    mutating = path === null && requestHeaders.has('origin');
  }
  const prefetch = requestHeaders.has('next-router-prefetch');
  return {
    mutating,
    pageView: !mutating && path !== null && !prefetch,
    method: upper ?? (serverAction ? 'POST' : null),
    path,
    serverAction,
  };
}

/** The operator's own identity, kept on an impersonated session for attribution. */
export interface StaffSessionOperator {
  userId: string;
  email: string;
  name: string;
  /** The operator's Better-Auth session id the staff session is bound to. */
  sessionId: string;
}

/** What `readSession` attaches to an impersonated session. */
export interface StaffSessionContext {
  session: StaffSessionDTO;
  operator: StaffSessionOperator;
}

/** The minimal Better-Auth session shape this module needs. */
interface RawSessionLike {
  session: { id: string; userId: string };
  user: { id: string; email: string; name: string };
}

/** What the gate concluded for one request. */
export type StaffSessionGateResult<S> =
  | { kind: 'none'; session: S }
  | { kind: 'active'; session: S; context: StaffSessionContext }
  | { kind: 'ended'; sessionId: string | null; operatorMatches: boolean };

const memo = new WeakMap<Headers, Promise<StaffSessionGateResult<unknown>>>();

/**
 * Layer the staff session (if any) over the operator's own session — the gate.
 * See the module header. Throws `ImpersonationReadOnlyError` for a mutating
 * request in a read-only session.
 */
export function applyStaffSession<S extends RawSessionLike>(
  raw: S,
  requestHeaders: Headers,
  method: string | null = null,
): Promise<StaffSessionGateResult<S>> {
  const cached = memo.get(requestHeaders);
  if (cached) return cached as Promise<StaffSessionGateResult<S>>;
  const result = resolve(raw, requestHeaders, method);
  memo.set(requestHeaders, result as Promise<StaffSessionGateResult<unknown>>);
  return result;
}

async function resolve<S extends RawSessionLike>(
  raw: S,
  requestHeaders: Headers,
  method: string | null,
): Promise<StaffSessionGateResult<S>> {
  const token = readStaffSessionToken(requestHeaders);
  if (!token) return { kind: 'none', session: raw };

  // Loaded lazily: the service reaches `lib/platform/auth`, which imports
  // `lib/auth` — the module that calls this one.
  const { impersonationService } = await import('@/lib/services/impersonationService');
  const resolution = await impersonationService.resolveForRequest(
    { userId: raw.user.id, sessionId: raw.session.id },
    token,
  );
  if (resolution.kind === 'ended') return resolution;

  const facts = classifyStaffRequest(requestHeaders, method);
  if (facts.mutating && resolution.session.mode === 'read_only') {
    throw new ImpersonationReadOnlyError(resolution.session.id);
  }
  await impersonationService.recordRequest(resolution.session, facts);

  // The TARGET's identity, in exactly the shape the operator's session had:
  // every key Better-Auth put on `user`, valued from the target's row.
  const user = Object.fromEntries(
    Object.keys(raw.user).map((key) => [key, resolution.target[key] ?? null]),
  ) as S['user'];
  const context: StaffSessionContext = {
    session: resolution.session,
    operator: {
      userId: raw.user.id,
      email: raw.user.email,
      name: raw.user.name,
      sessionId: raw.session.id,
    },
  };
  return {
    kind: 'active',
    session: { ...raw, session: { ...raw.session, userId: user.id }, user },
    context,
  };
}

/**
 * Refuse to MINT A CREDENTIAL while a staff-session cookie is present — a PAT,
 * a `motir login` device credential, an OAuth/MCP connection. In every mode: a
 * credential minted as the customer would outlive the time-box and walk out of
 * the session, which is exactly what the pattern forbids. Presence of the cookie
 * is enough (a stale one is cleared on the next page), and outside a request
 * (a job, a script, a test) there is no cookie and nothing to refuse.
 */
export async function assertNoStaffSessionCookie(): Promise<void> {
  if (await hasStaffSessionCookie()) throw new ImpersonationCredentialRefusedError();
}

/**
 * Whether THIS request carries a staff-session cookie at all — live or stale.
 * False outside a request (a job, a script, a test with no request headers).
 */
export async function hasStaffSessionCookie(): Promise<boolean> {
  try {
    const { headers } = await import('next/headers');
    return readStaffSessionToken(await headers()) !== null;
  } catch {
    return false;
  }
}
