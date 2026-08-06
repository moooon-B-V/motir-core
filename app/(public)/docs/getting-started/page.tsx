import { getTranslations } from 'next-intl/server';
import { buildApiReference } from '@/lib/apiDocs/reference';
import { GUIDE_STEPS } from '@/lib/apiDocs/guide';
import { CatalogueNav } from '../_components/CatalogueNav';
import { DocBlocks } from '../_components/DocBlocks';

// GET /docs/getting-started (Story 11.4 · Subtask 11.4.8 — MOTIR-2189 ·
// design Panel 4).
//
// A single LINEAR read, and the order is the deliverable: mint → first call →
// paginate → read an error → read the rate-limit headers. Each step ends in
// something the reader can see happen, because a guide whose steps produce no
// visible result is a list of assertions a reader has to take on trust.
//
// The content is `lib/apiDocs/guide.ts` — declared as data with the endpoints,
// parameters, statuses and headers each step CLAIMS, so
// `tests/api-docs/guide-truth.test.ts` can refuse a guide that documents a route
// or a header the API does not have. A guide that is slightly wrong burns a
// developer's first ten minutes, which is the whole budget of goodwill a new API
// gets.
//
// It mounts into 11.4.7's shell and reuses its catalogue rail unchanged — this
// card builds no shell and no navigation.

export default async function GettingStartedPage() {
  const t = await getTranslations('apiDocs');

  // The rail is shared with the reference, so the guide is reachable from the
  // operation list and vice versa. A failure to build it costs the operation
  // rows, never the guide — the guide does not depend on the spec.
  let groups: Awaited<ReturnType<typeof buildApiReference>>['groups'] = [];
  try {
    groups = buildApiReference().groups;
  } catch {
    groups = [];
  }

  return (
    <>
      <CatalogueNav current="gettingStarted" groups={groups} />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-8">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('guideTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('guideLede')}
          </p>
        </header>

        {GUIDE_STEPS.map((step, index) => (
          <section key={step.id} id={step.id} className="mb-10 scroll-mt-6">
            <h2 className="mt-0 mb-2 font-sans text-base font-semibold text-(--el-text)">
              <span className="mr-2 font-mono text-(--el-text-faint)">{index + 1}</span>
              {step.title}
            </h2>
            <DocBlocks blocks={step.blocks} />
          </section>
        ))}

        <p className="mt-10 border-t border-(--el-border-soft) pt-6 max-w-[68ch] text-sm text-(--el-text-muted)">
          {t('guideNext')}{' '}
          <a className="text-(--el-link) underline" href="/docs/api">
            {t('navReference')}
          </a>
          {' · '}
          <a className="text-(--el-link) underline" href="/docs/stability">
            {t('navStability')}
          </a>
        </p>
      </main>
    </>
  );
}
