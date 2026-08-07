import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { buildApiReference, SPEC_PATH, type ApiReference } from '@/lib/apiDocs/reference';
import { Button } from '@/components/ui/Button';
import { CatalogueNav } from '../_components/CatalogueNav';
import { OperationSection } from '../_components/OperationSection';

// GET /docs/api — the published API reference (Story 11.4 · Subtask 11.4.7 —
// MOTIR-2188 · design Panels 1–3, 6).
//
// ── Read from the EMITTER, not over HTTP ────────────────────────────────────
// `buildApiReference()` reads the same operation registry `/api/openapi/v1.json`
// is emitted from. Fetching our own public URL here would add a network round
// trip, a failure mode and a bootstrapping problem for no gain — the card says
// so, and it also means the "spec unavailable" branch below is about the
// BUILDER throwing, not about a request timing out.
//
// ⚠️ The failure state is not decoration. If the reference rendered an empty
// catalogue when the registry could not be built, the page would read as "this
// API has no operations" — a statement that is both false and unfalsifiable from
// the outside. It says what happened, what still works, and offers the raw
// document, which is public.

export default async function ApiReferencePage() {
  const t = await getTranslations('apiDocs');

  let reference: ApiReference | null = null;
  try {
    reference = buildApiReference();
  } catch {
    reference = null;
  }

  if (!reference || reference.operationCount === 0) {
    return (
      <>
        <CatalogueNav current="reference" groups={[]} />
        <main className="min-w-0 flex-1 px-4 py-16 sm:px-9">
          <div className="mx-auto flex max-w-[46ch] flex-col items-center gap-3 text-center">
            <span
              aria-hidden
              className="inline-flex h-11 w-11 items-center justify-center rounded-(--radius-badge) bg-(--el-tint-peach) text-xl text-(--el-text-strong)"
            >
              !
            </span>
            <h1 className="m-0 font-serif text-xl text-(--el-text)">{t('unavailableTitle')}</h1>
            <p className="m-0 text-[13.5px] leading-relaxed text-(--el-text-muted)">
              {t('unavailableBody')}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Link href="/docs/api/getting-started">
                <Button variant="primary" size="sm">
                  {t('navGettingStarted')}
                </Button>
              </Link>
              <a href={SPEC_PATH}>
                <Button variant="secondary" size="sm">
                  {t('unavailableOpenSpec')}
                </Button>
              </a>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <CatalogueNav current="reference" groups={reference.groups} />

      <main className="min-w-0 flex-1 px-4 py-7 sm:px-9">
        <header className="mb-2 border-b border-(--el-border-soft) pb-6">
          <h1 className="m-0 font-serif text-2xl font-semibold text-(--el-text)">
            {t('referenceTitle')}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[15px] leading-relaxed text-(--el-text-muted)">
            {t('referenceLede')}
          </p>
          <p className="mt-3 text-[12.5px] text-(--el-text-faint)">
            {t('specLine', {
              count: reference.operationCount,
              version: reference.contractVersion,
            })}{' '}
            <a className="text-(--el-link) underline" href={reference.specPath}>
              {reference.specPath}
            </a>
          </p>
        </header>

        {reference.groups.map((group) => (
          <div key={group.key}>
            <h2
              id={`group-${group.key}`}
              className="mt-10 scroll-mt-6 font-sans text-xs font-semibold tracking-wide text-(--el-text-faint) uppercase"
            >
              {group.label}
            </h2>
            {group.operations.map((operation) => (
              <OperationSection key={operation.id} operation={operation} />
            ))}
          </div>
        ))}
      </main>
    </>
  );
}
