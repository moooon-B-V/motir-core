import type { MetadataRoute } from 'next';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { publicSiteOrigin, publicProjectUrl } from '@/lib/publicProjects/urls';

// The sitemap (Story 6.12 · Subtask 6.12.4) — lists every PUBLIC project's URL
// (`/p/<identifier>` + its tabs) so crawlers discover the public surface. A
// framework boundary (like a route), so it calls the service (4-layer) which
// reads the public-project set. Public projects are crawlable cross-org, so the
// list is intentionally tenant-wide.

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const projects = await publicProjectsService.listPublicForSitemap();
  const origin = publicSiteOrigin();

  const entries: MetadataRoute.Sitemap = [
    { url: origin, changeFrequency: 'weekly', priority: 0.5 },
  ];

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
