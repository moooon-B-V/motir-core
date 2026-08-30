// The crawl directives this application serves at `/robots.txt` — and the ONE
// place the disallow set is authored (MOTIR-3726).
//
// ── Why a module and not four lines in `app/robots.ts` ─────────────────────
//
// `app/robots.ts` is a framework boundary: it resolves the origin and returns
// what this module builds. Keeping the policy pure and host-parameterised is
// what lets `tests/seo/robots.test.ts` assert the ALLOW as well as the deny
// without standing up a request, and it is the seam MOTIR-3881 widens when the
// same route has to answer differently per host. This card ships ONE host's
// directives against today's single origin, deliberately: a `robots.ts` that
// branches on a hostname nothing yet serves is untestable.
//
// ── What is disallowed, and why the list is what it is ─────────────────────
//
// `/api/` plus the signed-in surfaces. Every one of those already redirects an
// anonymous request to `/sign-in`, so a crawler that follows them indexes the
// sign-in page under N different addresses; the directive saves the crawl
// budget and the duplicate. It is NOT a security control — `app/(authed)/
// layout.tsx`'s `getSession()` redirect is, and it is unaffected by anything
// here.
//
// ⚠️ `/admin` IS DELIBERATELY ABSENT, and that is the one entry worth arguing.
// `docs/decisions/platform-staff-auth.md` §2 (MOTIR-2896) gives the platform
// staff area a 404-not-403 posture precisely so that an anonymous request
// cannot prove the route exists. **robots.txt is world-readable**, so listing
// `/admin` here would publish the very fact that posture hides — the same
// hazard `tests/navigation/proxy-matcher.test.ts` records for the proxy
// matcher, one surface over. An un-listed path is crawlable in principle and
// unreachable in practice: it 404s for everyone who is not staff.
//
// ⚠️ THE `?rank=` FACETS ARE NOT DISALLOWED, and this is a decision rather than
// an omission (MOTIR-3726 asks for it explicitly). `/explore?rank=popular` and
// `?rank=recent` are SELF-canonical — `app/(public)/explore/(square)/page.tsx`
// builds `alternates.canonical` from the query it was given, not from a
// collapsed `/explore` — and each renders a distinct `galleryHeading`
// ("Trending" / "Popular" / "New"). They are three deliberate indexable states,
// which is why `app/sitemap.ts` lists them as separate entries. Disallowing
// them would de-index two of the three and contradict the canonical the page
// itself emits. They stay in the sitemap and stay crawlable.

import type { MetadataRoute } from 'next';

/**
 * The signed-in top-level segments, as authored. `tests/seo/robots.test.ts`
 * derives the same set from `app/`'s filesystem and fails when the two drift,
 * so this list is a MEASUREMENT with a guard rather than a comment asking
 * future authors to remember — the failure `proxy-matcher.test.ts` was written
 * against (MOTIR-3652), avoided here by construction.
 *
 * `(admin)` is excluded on purpose; see the module note above.
 */
export const SIGNED_IN_SEGMENTS = [
  'backlog',
  'boards',
  'code-health',
  'dashboard',
  'direction',
  'filters',
  'home',
  'invite',
  'items',
  'onboarding',
  'planning',
  'plans',
  'ready',
  'reports',
  'roadmap',
  'settings',
  'sprints',
  'triage',
] as const;

/**
 * The anonymous AUTH surfaces. They are reachable without a session by design,
 * so no filesystem sweep marks them — but a crawler indexing `/sign-in` under
 * every `?next=` value is pure duplicate, and `/unsubscribe` and `/device`
 * carry one-shot tokens that must never be fetched by a bot.
 */
export const AUTH_SEGMENTS = [
  'device',
  're-consent',
  'reset-password',
  'sign-in',
  'sign-up',
  'two-factor-required',
  'unsubscribe',
] as const;

/** Every path prefix this application asks crawlers to skip, in served order. */
export function disallowedPaths(): string[] {
  return ['/api/', ...AUTH_SEGMENTS.map((s) => `/${s}`), ...SIGNED_IN_SEGMENTS.map((s) => `/${s}`)];
}

/**
 * The `/robots.txt` body for a host serving this application at `origin`.
 *
 * `origin` is passed in rather than read here: `lib/baseUrl.ts` owns that
 * precedence for the whole app (MOTIR-2388) and this module is not a second
 * reader of the variable.
 */
export function buildRobots(origin: string): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: disallowedPaths() }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
