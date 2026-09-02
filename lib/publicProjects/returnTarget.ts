import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';

// The HAND-OFF's return destination (MOTIR-4114 · `public-surface-hosts.md`
// AMENDMENT 4 §F).
//
// ── What this exists for ──────────────────────────────────────────────────
//
// AMENDMENT 4 routes four affordances — follow, roadmap vote, request upvote,
// request comment, and the request intake — as a HAND-OFF: the control on
// `motir.co` is a link, the act happens on `app.motir.co` under this
// application's own session and CSRF posture, and the visitor is returned to the
// page they left. The destination therefore arrives FROM ANOTHER ORIGIN, in a
// query parameter, under the control of whoever composed the link.
//
// ── ⚠️ WHY IT IS ITS OWN MODULE, AND WHY NOT `sanitizeNextPath` ────────────
//
// `lib/navigation/nextDestination.ts` already sanitises a `?next=`, and it is
// the right answer for every EXISTING consumer: it accepts a same-origin PATH
// and rejects anything else — no scheme, no protocol-relative `//`, no control
// characters. That is exactly wrong here, because the destination this module
// validates is deliberately NOT same-origin: it is an absolute URL on
// `motir.co`. Widening the existing sanitiser to admit absolute URLs would hand
// every one of its callers — the CLI device hand-off, the two-factor gate, the
// re-consent gate — a way to leave this origin, which is the property they were
// written to prevent. Two questions, two functions.
//
// ── ⚠️ AN ALLOW-LIST, NEVER A REFLECTION ──────────────────────────────────
//
// `proxy.ts`'s `CURRENT_PATH_HEADER` doc names this hazard exactly: an
// unvalidated redirect target taken from a request is "the one way this small
// piece of plumbing could ship a vulnerability". So the test here is
// POSITIVE — the parsed URL's ORIGIN must EQUAL the configured public origin —
// rather than a list of things to reject. A rejection list is a list somebody
// has to keep complete; `evil.example`, `//evil.example`, `motir.co.evil.test`,
// `https://motir.co@evil.test`, a backslash, a tab inside the scheme, an
// uppercase `HTTPS://`, a punycode homograph and whatever a browser normalises
// next are all one answer under an origin comparison, and each is a separate
// entry under a deny-list.
//
// Comparing `URL.origin` — not `hostname`, not `startsWith` — is what makes that
// true: `origin` is scheme + host + port, normalised by the parser, so
// `https://motir.co@evil.test/` parses with origin `https://evil.test` and is
// refused, while `startsWith(publicSiteOrigin())` would have accepted it.

/**
 * Where a visitor is sent when the supplied destination is missing or refused.
 *
 * A FIXED path on this application, not a guess at where they came from: the
 * whole point of refusing a destination is that we do not trust it, and
 * salvaging a hostile URL into "something nearby" is trusting it a little.
 *
 * ⚠️ IT IS THE SIGNED-IN LANDING, TAKEN FROM ITS OWNER rather than re-typed
 * (`home-scope.md` §2.3). A refused hand-off lands the visitor exactly where a
 * fresh sign-in would, and that is not a coincidence to be maintained in two
 * places: a literal here is the shape MOTIR-2921, MOTIR-3171 and MOTIR-3173
 * each had to be repaired for, and `landing-owner-guard.test.ts` caught this
 * one before it shipped.
 */
export const HANDOFF_FALLBACK_PATH: string = AUTHED_LANDING_PATH;

/**
 * Validate a return destination supplied by the public site.
 *
 * Returns the destination as a normalised absolute URL when — and only when —
 * it parses and its ORIGIN equals `publicSiteOrigin()`. Returns `null`
 * otherwise, which every caller renders as {@link HANDOFF_FALLBACK_PATH}.
 *
 * ⚠️ WHILE `MOTIR_PUBLIC_SITE_URL` IS UNSET, `publicSiteOrigin()` FALLS BACK TO
 * THIS APPLICATION'S OWN ORIGIN — the ordering guarantee in
 * `lib/publicProjects/urls.ts`. That is correct and is not a hole: before the
 * cutover the public pages ARE served here, so this origin is the public origin,
 * and the comparison still admits exactly one origin. Nothing widens; the value
 * of the single allowed origin moves.
 */
export function resolvePublicReturnTarget(raw: string | string[] | undefined): string | null {
  // A repeated key takes the first value — the same rule `sanitizeNextPath`
  // applies, for the same reason: one of them was intended, and a nonsense value
  // is refused by the check below rather than guessed at.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not an absolute URL at all — including every relative path. A relative
    // path is not "safe by default" here: it would resolve against THIS origin
    // and send the visitor to an application page while claiming to return them
    // to the public site.
    return null;
  }

  if (parsed.origin !== publicSiteOrigin()) return null;
  return parsed.toString();
}

/**
 * The same validation, resolved to something a redirect can always take: the
 * destination when it is allowed, {@link HANDOFF_FALLBACK_PATH} when it is not.
 */
export function resolveHandoffDestination(raw: string | string[] | undefined): string {
  return resolvePublicReturnTarget(raw) ?? HANDOFF_FALLBACK_PATH;
}
