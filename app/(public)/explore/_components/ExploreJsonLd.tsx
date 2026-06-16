import type { ProjectSquareCardDto } from '@/lib/dto/projectSquare';
import { publicProjectUrl, publicSiteOrigin } from '@/lib/publicProjects/urls';
import type { ExploreFaqItem } from './ExploreFaq';

// Server-rendered JSON-LD structured data for the project square (Story 6.13 ·
// Subtask 6.13.6 · design Panel 4). Emits a `CollectionPage` whose `mainEntity`
// is an `ItemList` of `SoftwareApplication` (one per visible card, linking to its
// 6.12.4 public view), a `FAQPage` from the same GEO Q/A the FAQ block renders
// (so answer engines cite both), and — on a topic landing page — a
// `BreadcrumbList` (Project square › <topic>). Injected as a single
// <script type="application/ld+json"> (the standard structured-data carrier);
// the payload is server-built, JSON.stringify-encoded, no user-controlled keys.

export function ExploreJsonLd({
  pageUrl,
  name,
  description,
  cards,
  faq,
  breadcrumb,
}: {
  /** The canonical URL of this square/topic page. */
  pageUrl: string;
  /** The page's collection name (the <title>-ish label). */
  name: string;
  /** The citable description (matches the <meta description>). */
  description: string;
  cards: ProjectSquareCardDto[];
  faq: ExploreFaqItem[];
  /** Present on a topic landing page: the topic's display label. */
  breadcrumb?: { topicLabel: string; topicUrl: string; squareLabel: string };
}) {
  const origin = publicSiteOrigin();
  const graph: Record<string, unknown>[] = [
    {
      '@type': 'CollectionPage',
      name,
      description,
      url: pageUrl,
      isPartOf: { '@type': 'WebSite', name: 'Motir', url: origin },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: cards.length,
        itemListElement: cards.map((card, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'SoftwareApplication',
            name: card.name,
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            url: publicProjectUrl(card.identifier),
            ...(card.description ? { description: card.description } : {}),
            ...(card.org.name
              ? { publisher: { '@type': 'Organization', name: card.org.name } }
              : {}),
          },
        })),
      },
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

  if (breadcrumb) {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: breadcrumb.squareLabel,
          item: `${origin}/explore`,
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: breadcrumb.topicLabel,
          item: breadcrumb.topicUrl,
        },
      ],
    });
  }

  const ld = { '@context': 'https://schema.org', '@graph': graph };
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
  );
}
