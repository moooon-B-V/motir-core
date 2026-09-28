import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';

// The `motir_visitor` cookie (Story MOTIR-6170 · MOTIR-6647 defines it, MOTIR-6648
// writes it). A module of its own, with no server imports, because `proxy.ts` is
// what sets and clears it and must not pull the datastore in to learn its name.
//
// ⚠️ AN ADDRESS, NEVER A CREDENTIAL. It names the public project a signed-in
// reader is watching, so the client data doors (`lib/visitor/readActor.ts`) know
// which project a Visitor's fetch is about. It grants nothing on its own: a door
// serves a Visitor only when the SESSION resolves, through `resolveVisitor`, to a
// consented Visitor of exactly that project.

/** The cookie's name. */
export const VISITOR_COOKIE = 'motir_visitor';

/**
 * Whether `value` may be written into / read out of the cookie: a project key's
 * shape and nothing else, so neither a forged cookie nor an odd URL segment can
 * put anything else into it.
 */
export function isVisitorCookieValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Its attributes: HOST-ONLY (no `Domain`, so `motir.co` never receives it),
 * HttpOnly, SameSite=Lax, Path=/ — and Secure wherever the session cookie is.
 * A session cookie in the browser's sense: no `Max-Age`, gone with the browser.
 */
export function visitorCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
} {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: shouldUseSecureCookies() };
}
