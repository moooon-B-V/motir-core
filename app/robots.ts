import type { MetadataRoute } from 'next';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { buildRobots } from '@/lib/robotsPolicy';

// `/robots.txt` (MOTIR-3726) — this application had none, so the address 404ed
// with Next's HTML not-found page while the rest of the public-surface SEO
// scaffolding (sitemap, JSON-LD, canonicals, OG cards) had shipped.
//
// A framework boundary and nothing else: it resolves the origin through the one
// module that owns that precedence and returns what `lib/robotsPolicy.ts`
// builds. The policy — and the reasoning behind every entry in it, including
// the deliberate NON-entries and the ABSENT `Sitemap:` line (MOTIR-4583) —
// lives there.
//
// ⚠️ This is now the ONLY metadata route this application serves.
// `app/sitemap.ts` is deleted: an empty `<urlset>` is schema-invalid, so it
// could not express "nothing to crawl" and produced a permanent Search Console
// error instead (MOTIR-4583, and `lib/robotsPolicy.ts`'s note carries the full
// reasoning). Serving no sitemap is the valid way to say it.
//
// ⚠️ `force-dynamic` BELOW IS LOAD-BEARING, AND THE REASON IS NOT STALENESS
// (MOTIR-4580). This route carried a paragraph arguing the opposite — *"static
// by design, unlike `app/sitemap.ts`: this route reads no database, so it has
// nothing to go stale and no reason to be `force-dynamic`"* — and that
// paragraph was careful, correct in its premise, and wrong in its conclusion.
// The unstated step is that STALENESS is the only reason a route needs runtime.
// It is not. This route reads the ORIGIN, and an environment variable is not
// stale at build time — it is ABSENT.
//
// What that cost: `Dockerfile` declares no `ARG MOTIR_BASE_URL` (deliberately —
// baking an environment-specific origin into the image would make one image
// un-deployable to a second host), so the variable does not exist in the
// `builder` stage. `next build` therefore took `lib/baseUrl.ts`'s rung 2 and
// baked `http://localhost:3000` into the prerendered body, which was then
// served from the cache for ever: Fly secrets are runtime-only and nothing
// re-evaluated the route. `app.motir.co/robots.txt` published a loopback
// address on a world-readable surface for as long as the image lived, while the
// SAME function resolved correctly for every runtime caller of it — emailed
// links, Better-Auth's `baseURL` and `trustedOrigins`, every OAuth callback.
// One deploy, one function, two answers, and only the reader's TIMING differed.
//
// So the question to ask before deleting the line below is not *"does this
// route read a database?"* but *"does anything it reads resolve at REQUEST
// time?"*. `host: origin` in `lib/robotsPolicy.ts` is the one remaining reader,
// and while it is there this route renders per request. (Dropping `Host:` too
// would make the route genuinely origin-free and legitimately static — a
// cross-host product decision neither MOTIR-4583 nor MOTIR-4580 took by side
// effect in a bug fix; that module's note says so.)
//
// The rendering mode is a fact NO assertion about the body can reach — the
// policy tests inject the origin, which is the right shape for a policy test
// and is exactly why they were green throughout. `tests/seo/robots.test.ts`
// asserts this export directly for that reason.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(resolveBaseUrlTrimmed());
}
