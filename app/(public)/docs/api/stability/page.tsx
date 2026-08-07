import { getTranslations } from 'next-intl/server';
import { buildApiReference } from '@/lib/apiDocs/reference';
import { ADR_PATH, POLICY_ADDITIVE, POLICY_FORBIDDEN, POLICY_SECTIONS } from '@/lib/apiDocs/guide';
import { CatalogueNav } from '../../_components/CatalogueNav';
import { DocBlocks } from '../../_components/DocBlocks';

// GET /docs/api/stability (Story 11.4 · Subtask 11.4.8 — MOTIR-2189 · design
// Panel 5).
//
// ⚠️ ONE PROMISE IN TWO PLACES. ADR §8 is the INTERNAL record; this page is the
// PUBLISHED commitment a third party integrates against. They must never say
// different things, so the two lists come from `lib/apiDocs/guide.ts`, where each
// item carries the §8 bullet it publishes, and `tests/api-docs/guide-truth.test.ts`
// fails when either side gains or loses one. The cross-link below says which is
// which, so a reader who finds one can find the other.
//
// The page is deliberately plainer than the reference: it is read once, in
// order, and then cited. The two lists are the load-bearing content and are the
// page's only structure.

export default async function StabilityPage() {
  const t = await getTranslations('apiDocs');

  let groups: Awaited<ReturnType<typeof buildApiReference>>['groups'] = [];
  try {
    groups = buildApiReference().groups;
  } catch {
    groups = [];
  }

  return (
    <>
      <CatalogueNav current="stability" groups={groups} />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-8">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('policyTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('policyLede')}
          </p>
        </header>

        {POLICY_SECTIONS.map((section) => (
          <div key={section.id}>
            <section id={section.id} className="mb-8 scroll-mt-6">
              <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
                {section.title}
              </h2>
              <DocBlocks blocks={section.blocks} />
            </section>

            {/* The two LISTS are the page's load-bearing content, so they land
                immediately after the guarantee they qualify rather than at the
                end. Keyed off the section's id, not its index — a positional
                slice would silently move them the day a section is inserted. */}
            {section.id === 'the-guarantee' && (
              <>
                <section id="additive" className="mb-8 scroll-mt-6">
                  <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
                    {t('policyAdditiveHeading')}
                  </h2>
                  <ul className="mb-3 max-w-[68ch] list-disc pl-5 text-sm leading-7 text-(--el-text-secondary)">
                    {POLICY_ADDITIVE.map((item) => (
                      <li key={item.adrPhrase}>{item.text}</li>
                    ))}
                  </ul>
                </section>

                <section id="forbidden" className="mb-8 scroll-mt-6">
                  <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
                    {t('policyForbiddenHeading')}
                  </h2>
                  <ul className="mb-3 max-w-[68ch] list-disc pl-5 text-sm leading-7 text-(--el-text-secondary)">
                    {POLICY_FORBIDDEN.map((item) => (
                      <li key={item.adrPhrase}>{item.text}</li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </div>
        ))}

        <p
          data-testid="adr-cross-link"
          className="mt-10 max-w-[68ch] border-t border-(--el-border-soft) pt-6 text-[13px] leading-relaxed text-(--el-text-muted)"
        >
          {t('policyAdrNote')} <code className="font-mono">{ADR_PATH}</code> §8.
        </p>
      </main>
    </>
  );
}
