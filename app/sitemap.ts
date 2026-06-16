import type { MetadataRoute } from 'next';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { projectTagsService } from '@/lib/services/projectTagsService';
import { publicSiteOrigin, publicProjectUrl } from '@/lib/publicProjects/urls';

// The sitemap (Story 6.12 · Subtask 6.12.4 + Story 6.13 · Subtask 6.13.6) — lists
// every PUBLIC project's URL (`/p/<identifier>` + its tabs) AND the project
// square's indexable surfaces (`/explore`, its rank variants, and every
// `/explore/topic/<slug>` landing page) so crawlers discover the whole public
// surface. A framework boundary (like a route), so it calls the services
// (4-layer) which read the public-project set + the topic facet. Public projects
// are crawlable cross-org, so the list is intentionally tenant-wide.

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [projects, categories] = await Promise.all([
    publicProjectsService.listPublicForSitemap(),
    projectTagsService.listCategories(),
  ]);
  const origin = publicSiteOrigin();

  const entries: MetadataRoute.Sitemap = [
    { url: origin, changeFrequency: 'weekly', priority: 0.5 },
    // The project square + its ranked tabs — each a distinct crawlable URL.
    { url: `${origin}/explore`, changeFrequency: 'daily', priority: 0.7 },
    { url: `${origin}/explore?rank=popular`, changeFrequency: 'daily', priority: 0.6 },
    { url: `${origin}/explore?rank=recent`, changeFrequency: 'daily', priority: 0.6 },
  ];

  // Per-topic landing pages (the SEO surface for "{topic} projects").
  for (const category of categories) {
    entries.push({
      url: `${origin}/explore/topic/${category.slug}`,
      changeFrequency: 'daily',
      priority: 0.6,
    });
  }

  for (const project of projects) {
    const base = publicProjectUrl(project.identifier);
    entries.push({
      url: base,
      lastModified: project.updatedAt,
      changeFrequency: 'daily',
      priority: 0.8,
    });
    for (const tab of ['board', 'items', 'roadmap']) {
      entries.push({
        url: `${base}/${tab}`,
        lastModified: project.updatedAt,
        changeFrequency: 'daily',
        priority: 0.6,
      });
    }
  }

  return entries;
}
