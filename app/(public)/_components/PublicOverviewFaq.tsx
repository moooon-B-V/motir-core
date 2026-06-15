import { getTranslations } from 'next-intl/server';

// The Overview FAQ block (Story 6.12 · Subtask 6.12.4 · design Panel 9 — the GEO
// answer-engine framing). A small Q/A set ("Can anyone view this project?", "How
// do I submit a request?", "What's hidden on the public view?") rendered as
// semantic <h2> + <dl>; the same Q/A also feed the FAQPage JSON-LD. Server
// component; colour via --el-* tokens.

export interface FaqItem {
  q: string;
  a: string;
}

/** The FAQ Q/A pairs — shared by this component AND the JSON-LD builder. */
export async function publicFaqItems(): Promise<FaqItem[]> {
  const t = await getTranslations('publicProjects');
  return [
    { q: t('faqQ1'), a: t('faqA1') },
    { q: t('faqQ2'), a: t('faqA2') },
    { q: t('faqQ3'), a: t('faqA3') },
  ];
}

export async function PublicOverviewFaq() {
  const t = await getTranslations('publicProjects');
  const items = await publicFaqItems();
  return (
    <section aria-labelledby="public-faq-heading" className="mt-2">
      <h2
        id="public-faq-heading"
        className="mb-3 font-serif text-[19px] font-semibold text-(--el-text)"
      >
        {t('faqTitle')}
      </h2>
      <dl className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            key={item.q}
            className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-4"
          >
            <dt className="text-sm font-semibold text-(--el-text)">{item.q}</dt>
            <dd className="mt-1.5 text-[13.5px] leading-relaxed text-(--el-text-secondary)">
              {item.a}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
