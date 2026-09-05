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
// ⚠️ This route reads no database, but it DOES read the origin, and it is
// PRERENDERED at build time — which is why production serves
// `Host: http://localhost:3000`. That defect is MOTIR-4580 and is not fixed
// here; it is `blocked_by` MOTIR-4583 on purpose, because a corrected origin
// would otherwise have re-advertised the invalid sitemap on every crawl instead
// of once.

export default function robots(): MetadataRoute.Robots {
  return buildRobots(resolveBaseUrlTrimmed());
}
