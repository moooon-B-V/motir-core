import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  segmentOf,
  strayProxyEntries,
  topLevelSegments as segmentsOf,
  uncoveredProxySegments,
} from '../helpers/twoFactorGuardSweeps';

// MOTIR-3652 — the matcher was a COMMENT asking future authors to remember, and
// thirteen of sixteen segments were never added.
//
// `proxy.ts`'s own words: "as new authed routes are added in later Subtasks
// they get appended to this list". They were not. Measured at
// `motir-core` `origin/main` `d4072154c`, `app/(authed)/` holds SIXTEEN
// top-level segments and `config.matcher` listed THREE — `/dashboard`,
// `/settings`, `/invite`.
//
// That was never a security hole: the real gate is `app/(authed)/layout.tsx`'s
// `getSession()` redirect, which has always run for all sixteen. What the
// missing entries cost was the cheap optimistic bounce — and, once MOTIR-3652
// landed the `x-current-path` header, the header itself, which is absent for
// any path the matcher does not cover. A gate that lives in a layout cannot
// learn which page was asked for, so without the forward every person stopped
// for 2FA enrolment would afterwards be dumped somewhere they were not going
// (MOTIR-3648).
//
// So the comment is replaced by a MEASUREMENT: enumerate the segments from the
// filesystem and fail when one has no entry. A rule with no guard is a comment,
// and this file exists because that was demonstrated rather than argued.
//
// ── The one deliberate exclusion ────────────────────────────────────────────
// `/admin` must have NO entry, and that is asserted here as intent rather than
// left to read as another oversight. `docs/decisions/platform-staff-auth.md` §2
// (MOTIR-2896): the proxy's redirect is VISIBLY DIFFERENT from an unknown
// path's 404, so bouncing an anonymous request to `/sign-in?next=/admin` proves
// the route exists — exactly what the admin area's 404-not-403 posture prevents.

const ROOT = process.cwd();
const APP = join(ROOT, 'app');

/**
 * The route groups whose pages are SIGNED-IN surfaces. `(auth)` and `(public)`
 * are anonymous by design; `(admin)` is excluded on purpose and is asserted
 * separately below.
 *
 * ⚠️ `(planning)` WAS A THIRD until MOTIR-4732 retired it — the planning
 * workspace is an overlay mounted inside `(authed)` now, and the one path left at
 * `/planning` is a forward that lives in that group. Its matcher entry STAYS
 * (`proxy.ts` says why): the entry is what gives a cookie-less request to a
 * bookmarked `/planning?…` the sign-in bounce instead of the segment's own gate.
 */
const SIGNED_IN_GROUPS = ['(authed)', '(onboarding)'] as const;

/**
 * ⚠️ THE SWEEPS LIVE IN `tests/helpers/twoFactorGuardSweeps.ts`, taking the app
 * directory as a parameter, so this guard can be WATCHED FAILING over a
 * synthetic tree — `tests/integration/twoFactorEnforcementStoryGate.test.ts`
 * builds one whose group serves a segment the matcher never lists (MOTIR-3649).
 * A guard nobody has watched go red is indistinguishable from one that never
 * runs, and this file exists because that was demonstrated rather than argued.
 */
const topLevelSegments = (group: string): string[] => segmentsOf(APP, group);

describe('proxy config.matcher', () => {
  it('covers every top-level segment of every signed-in route group', async () => {
    const { config } = await import('@/proxy');

    const missing = uncoveredProxySegments(APP, SIGNED_IN_GROUPS, config.matcher).map(
      (segment) => `app/**/${segment} → add '/${segment}/:path*' to config.matcher`,
    );

    expect(missing).toEqual([]);
  });

  it('lists nothing the signed-in route groups do not serve, except the two deliberate classes', async () => {
    // The other direction of the same rule. An entry for a path no group serves
    // is either a segment that has since been deleted or a typo, and both make
    // the list above look more complete than it is. TWO classes of extra entry
    // are deliberate, and each is enumerated here so that adding a third is a
    // decision somebody writes down rather than a silent widening:
    //
    //   1. The moved public SURFACES (MOTIR-3884) — `/`, `/explore`, `/docs`,
    //      `/legal`, `/p` — which the proxy 308s onto motir.co.
    //   2. The public read API (MOTIR-4114) — `/api/public/*`, matched so the
    //      proxy can answer the cross-origin preflight and attach the CORS
    //      headers `motir.co`'s browser-side fetches need. It is matched for
    //      THAT ONLY: `proxy()` answers it and returns before any of the page
    //      logic, so no `/api/*` path takes the session bounce.
    const { config } = await import('@/proxy');

    const PUBLIC_REDIRECT_SEGMENTS = ['', 'explore', 'docs', 'legal', 'p'];
    const CORS_ONLY_SEGMENTS = ['api'];
    expect(
      strayProxyEntries(APP, SIGNED_IN_GROUPS, config.matcher).filter(
        (segment) =>
          !PUBLIC_REDIRECT_SEGMENTS.includes(segment) && !CORS_ONLY_SEGMENTS.includes(segment),
      ),
    ).toEqual([]);
  });

  it('matches ONLY /api/public under /api — the bounce must not reach another API path', async () => {
    // The hazard the entry above creates, closed where it is created. Every
    // other `/api/*` route answers its own callers — the CLI, the MCP surface,
    // the webhooks — and a matcher entry of `/api/:path*` would put the
    // signed-in page bounce in front of all of them, turning a 401 that a client
    // can read into a 307 to a sign-in page that it cannot.
    const { config } = await import('@/proxy');

    const apiEntries = config.matcher.filter((entry) => entry.startsWith('/api'));
    expect(apiEntries).toEqual(['/api/public/:path*']);
  });

  it('excludes /admin — the 404-not-403 posture, `platform-staff-auth.md` §2', async () => {
    // NOT an oversight, and asserted so that the next reader of the list does
    // not "fix" it. A redirect to `/sign-in?next=/admin` proves the route
    // exists; `app/(admin)/layout.tsx` must answer the anonymous request with
    // the ordinary 404 instead.
    const { config } = await import('@/proxy');
    expect(config.matcher.map(segmentOf)).not.toContain('admin');
    // …and the reason must stay in the file, or the exclusion decays into a gap
    // indistinguishable from the one this suite exists to catch.
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(join(ROOT, 'proxy.ts'), 'utf8'),
    );
    expect(source).toContain('platform-staff-auth.md');
    expect(source).toContain('404-not-403');
  });

  it('the eighteen (authed) segments are the ones measured, not a copied list', async () => {
    // A regression guard on the ENUMERATION, not on the matcher: if this number
    // moves, a segment was added or removed and the first test above is the one
    // that should have failed. Kept because the card's own measurement is the
    // thing a future reader will want to re-derive.
    expect(topLevelSegments('(authed)')).toEqual([
      'backlog',
      'boards',
      'code-health',
      'dashboard',
      'direction',
      'filters',
      'home',
      'invite',
      'items',
      // MOTIR-4732 — the FORWARD for old `/planning` links, and the eighteenth
      // segment. The route GROUP that served this path is gone; what is here is
      // a page inside `(authed)`, which is why the sweep now finds it.
      'planning',
      'plans',
      'ready',
      'reports',
      'roadmap',
      // MOTIR-3923 — the runs index, the segment that made this list seventeen.
      'runs',
      'settings',
      'sprints',
      'triage',
    ]);
  });
});

// ── The proxy's own behaviour ───────────────────────────────────────────────
// `getSessionCookie` is the only thing standing between the two branches, so it
// is the only thing stubbed. Everything else is the real `NextRequest` /
// `NextResponse` pair.

const cookiePresent = vi.hoisted(() => ({ value: false }));
vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => (cookiePresent.value ? 'a-session-cookie' : null),
}));

/**
 * The headers Next will hand the downstream render.
 *
 * `NextResponse.next({ request: { headers } })` does not mutate anything a test
 * can observe directly — it encodes the override onto the RESPONSE as
 * `x-middleware-override-headers` (the names) plus one
 * `x-middleware-request-<name>` per value, which the framework unpacks before
 * rendering. Reading it back through that encoding is what makes this an
 * assertion about the forwarded REQUEST rather than about a response header.
 */
function forwardedHeaders(res: Response): Headers {
  const out = new Headers();
  const names = res.headers.get('x-middleware-override-headers');
  if (!names) return out;
  for (const name of names.split(',').map((n) => n.trim())) {
    const value = res.headers.get(`x-middleware-request-${name}`);
    if (value !== null) out.set(name, value);
  }
  return out;
}

describe('proxy()', () => {
  it('bounces an unauthenticated request to a NEWLY covered segment', async () => {
    // `/items` is the case: it was not in the matcher before MOTIR-3652, so
    // this request used to reach the framework and be turned away deeper in.
    cookiePresent.value = false;
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('@/proxy');

    const res = await proxy(new NextRequest('https://app.motir.co/items'));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('next')).toBe('/items');
  });

  it('⚠️ carries the SEARCH STRING into `next=`, not the pathname alone', async () => {
    // MOTIR-4725. The planning workspace is an OVERLAY: `plan` / `planFrom` in
    // the query ARE the open state, so a bounce that kept only `/backlog` sent a
    // signed-out reader to a bare backlog — the link they were given, minus the
    // thing it was a link TO. The same drop quietly cost every filtered list its
    // filter. `sanitizeNextPath` admits a query (see its header), so the value
    // survives the round trip whole.
    cookiePresent.value = false;
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('@/proxy');

    const res = await proxy(
      new NextRequest('https://app.motir.co/backlog?kind=story&plan=project&planFrom=project'),
    );

    const next = new URL(res.headers.get('location')!).searchParams.get('next');
    expect(next).toBe('/backlog?kind=story&plan=project&planFrom=project');
    // …and it is still a value `sanitizeNextPath` admits: a single leading
    // slash, nothing protocol-relative. (Asserted as the SHAPE rather than by
    // calling the sanitizer — this lane may not import from `lib/`, and
    // `tests/navigation/landing.test.ts` is where that function is exercised.)
    expect(next!.startsWith('/')).toBe(true);
    expect(next!.startsWith('//') || next!.startsWith('/\\')).toBe(false);
  });

  it('forwards x-current-path with the path AND the search string', async () => {
    cookiePresent.value = true;
    const { NextRequest } = await import('next/server');
    const { proxy, CURRENT_PATH_HEADER } = await import('@/proxy');

    const res = await proxy(new NextRequest('https://app.motir.co/items?status=open&assignee=me'));

    expect(forwardedHeaders(res).get(CURRENT_PATH_HEADER)).toBe('/items?status=open&assignee=me');
  });

  it('OVERWRITES a client-supplied x-current-path rather than honouring it', async () => {
    // The header is forgeable, and a consumer that redirects to it would be an
    // open-redirect if the proxy passed a client value through. It does not.
    cookiePresent.value = true;
    const { NextRequest } = await import('next/server');
    const { proxy, CURRENT_PATH_HEADER } = await import('@/proxy');

    const res = await proxy(
      new NextRequest('https://app.motir.co/roadmap', {
        headers: { [CURRENT_PATH_HEADER]: 'https://evil.example/phish' },
      }),
    );

    expect(forwardedHeaders(res).get(CURRENT_PATH_HEADER)).toBe('/roadmap');
  });

  it('sets the header on the forwarded REQUEST only, never on the response', async () => {
    // A response header would join the cache key and change revalidation
    // behaviour for every covered route. The override encoding above is a
    // request-side channel; the response must not carry the header itself.
    cookiePresent.value = true;
    const { NextRequest } = await import('next/server');
    const { proxy, CURRENT_PATH_HEADER } = await import('@/proxy');

    const res = await proxy(new NextRequest('https://app.motir.co/dashboard'));

    expect(res.headers.get(CURRENT_PATH_HEADER)).toBeNull();
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('preserves the incoming headers it is not overriding', async () => {
    cookiePresent.value = true;
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('@/proxy');

    const res = await proxy(
      new NextRequest('https://app.motir.co/home', {
        headers: { 'accept-language': 'zh-CN' },
      }),
    );

    expect(forwardedHeaders(res).get('accept-language')).toBe('zh-CN');
  });
});
