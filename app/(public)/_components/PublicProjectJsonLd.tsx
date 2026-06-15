import type { PublicProjectOverviewDto } from '@/lib/dto/publicProjects';
import { publicProjectUrl } from '@/lib/publicProjects/urls';
import type { FaqItem } from './PublicOverviewFaq';

// Server-rendered JSON-LD for the public Overview (Story 6.12 · Subtask 6.12.4 ·
// design Panel 9). A `SoftwareApplication` object describing the project (the
// citable GEO description) + a `FAQPage` built from the same Q/A the FAQ block
// renders, so answer engines can cite both. Injected as a
// <script type="application/ld+json"> — the standard structured-data carrier.

export function PublicProjectJsonLd({
  overview,
  description,
  faq,
}: {
  overview: PublicProjectOverviewDto;
  description: string;
  faq: FaqItem[];
}) {
  const url = publicProjectUrl(overview.identifier);
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'SoftwareApplication',
      name: overview.name,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url,
      description,
      ...(overview.links.repo ? { codeRepository: overview.links.repo } : {}),
      ...(overview.links.website ? { sameAs: [overview.links.website] } : {}),
    },
    {
      '@type': 'FAQPage',
      mainEntity: faq.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
  ];
  const ld = { '@context': 'https://schema.org', '@graph': graph };
  return (
    <script
      type="application/ld+json"
      // JSON.stringify of a server-built object (no user-controlled keys); the
      // only dynamic values are the project's own public-safe content.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
    />
  );
}
