import { getTranslations } from 'next-intl/server';

// The GEO FAQ block (Story 6.13 · Subtask 6.13.6 · design Panel 4 — the
// answer-engine framing). A concise, citable lead paragraph + a small Q/A set,
// rendered as semantic <h2> + <dl>; the SAME Q/A feed the FAQPage JSON-LD so
// generative engines get a clean, attributable answer with the canonical URL as
// the source. Server component; colour via --el-* tokens.

export interface ExploreFaqItem {
  q: string;
  a: string;
}

/** The FAQ Q/A pairs — shared by this component AND the JSON-LD builder. */
export async function exploreFaqItems(): Promise<ExploreFaqItem[]> {
  const t = await getTranslations('projectSquare');
  return [
    { q: t('faqQ1'), a: t('faqA1') },
    { q: t('faqQ2'), a: t('faqA2') },
    { q: t('faqQ3'), a: t('faqA3') },
  ];
}

export async function ExploreFaq() {
  const t = await getTranslations('projectSquare');
  const items = await exploreFaqItems();
  return (
    <section
      aria-labelledby="explore-faq-heading"
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-mint) p-(--spacing-card-padding)"
    >
      <h2
        id="explore-faq-heading"
        className="font-serif text-lg font-semibold text-(--el-text-strong)"
      >
        {t('faqHeading')}
      </h2>
      <p className="mt-2 max-w-[48rem] text-[13.5px] leading-relaxed text-(--el-text-secondary)">
        {t('faqLede')}
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.q}
            className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface) p-4"
          >
            <dt className="text-sm font-semibold text-(--el-text)">{item.q}</dt>
            <dd className="mt-1.5 text-[13px] leading-relaxed text-(--el-text-secondary)">
              {item.a}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
