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
// the two deliberate NON-entries — lives there.
//
// Static by design, unlike `app/sitemap.ts`: this route reads no database, so
// it has nothing to go stale and no reason to be `force-dynamic`.

export default function robots(): MetadataRoute.Robots {
  return buildRobots(resolveBaseUrlTrimmed());
}
